// v0.4.0 Milestone 6: MOTH Agents. Real engine, SQLite and job queue. Where model output is needed, a stand-in model
// (test/fixtures/fake-model.ts) is used and the test says so: these test MOTH's validation and recovery, NOT real
// inference. Real-model agent tests run in CI (test-real/agents.real.test.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Brain } from "../src/engine/brain.ts";
import { hangingModel, useFakeModel } from "./fixtures/fake-model.ts";
import { openBrain, tmpDir, user } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function research(b: any, title: string, content: string, sources: { url: string; title: string; publisher?: string; published_at?: string }[] = []) {
  const m = b.store.createMemory({ title, content, category: "research", memory_type: "research", evidence: sources.length ? "sourced" : "unsourced" }, user);
  for (const s of sources) b.db.run("INSERT INTO memory_sources(memory_id, url, title, publisher, published_at, kind, created_at) VALUES (?,?,?,?,?,'citation',?)", [m.id, s.url, s.title, s.publisher ?? "", s.published_at ?? null, new Date().toISOString()]);
  return m;
}
async function runAgent(b: any, id: string, opts: any = {}) {
  const jid = b.agents.run(id, opts);
  for (let i = 0; i < 20 && ["pending", "running"].includes(b.jobs.get(jid)!.status); i++) await b.jobs.tick();
  return b.jobs.get(jid)!;
}

test("v0.4.0 test 8 (ISOLATED, stand-in model): Research Analyst keeps only quoted, correctly cited insights; approval saves them with the real source", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  const r = research(b, "Sleep in cats", "Cats sleep about 15 hours a day. Kittens sleep even more than adult cats.", [{ url: "https://example.org/cat-sleep", title: "Cat sleep study", publisher: "Example Vet School", published_at: "2024-03-01" }]);
  const fake = useFakeModel(b, () =>
    JSON.stringify({
      insights: [
        { text: "Adult cats sleep roughly 15 hours per day.", quote: "Cats sleep about 15 hours a day", source: 1 },
        { text: "Cats dream in colour.", quote: "Cats dream in full colour every night", source: 1 }, // quote not in the note: invented
        { text: "Kittens sleep more than adults.", quote: "Kittens sleep even more than adult cats", source: 4 }, // source 4 doesn't exist
      ],
    }),
  );
  const job = await runAgent(b, "research_analyst");
  assert.equal(fake.calls.length, 1);
  assert.equal(job.status, "awaiting_approval", JSON.stringify(job.result ?? job.last_error));
  assert.equal(job.result.proposals, 1);
  assert.equal(job.result.rejected_model_output, 2, "invented quote and invented citation are rejected");
  const items: any[] = b.inbox.list().filter((i: any) => i.job_id === job.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].sources[0].url, "https://example.org/cat-sleep", "only the note's own source");
  const res: any = b.inbox.approve(items[0].id);
  const m = b.store.getMemory(res.memory_id)!;
  assert.equal(m.memory_type, "research");
  assert.match(m.content, /Cats sleep about 15 hours a day/);
  assert.equal(b.db.value("SELECT url FROM memory_sources WHERE memory_id = ?", [m.id]), "https://example.org/cat-sleep");
  assert.ok(b.store.relationshipsOf(m.id).some((x: any) => x.other_id === r.id));
  assert.equal(b.jobs.get(job.id)!.status, "done", "deciding the last proposal completes the job");
  b.close();
});

test("v0.4.0 test 8b: without a local model the Research Analyst still checks sources and contradictions, and says what it skipped", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  research(b, "Caffeine and focus", "Caffeine improves short-term focus in most adults.");
  research(b, "Caffeine and focus (other study)", "Caffeine does not improve short-term focus in most adults.", [{ url: "https://example.org/c", title: "" }]);
  const job = await runAgent(b, "research_analyst");
  assert.equal(job.status, "done");
  assert.match(job.result.ai, /Insights not extracted/);
  const f: any[] = b.findings.list({ kind: "agent", status: "active" });
  assert.ok(f.some((x: any) => x.category === "research_sources"), "missing / incomplete sources");
  assert.ok(f.some((x: any) => x.category === "research_contradiction"), "possible contradiction");
  assert.ok(f.every((x: any) => x.agent === "agent:research_analyst"));
  b.close();
});

test("v0.4.0 (ISOLATED, stand-in model): malformed model output never reaches the knowledge base", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  research(b, "Note", "Some research text that is long enough.", [{ url: "https://example.org/n", title: "N" }]);
  useFakeModel(b, () => "this is not JSON at all {");
  const job = await runAgent(b, "research_analyst");
  assert.equal(job.status, "done");
  assert.equal(job.result.ai_errors, 1);
  assert.equal(job.result.proposals, 0);
  assert.equal(b.inbox.list().length, 0);
  b.close();
});

test("v0.4.0 test 9: Memory Curator finds overlapping memories and proposes, without deleting or merging anything", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  const p = b.store.createProject({ name: "Outbreak" }, user);
  const a = b.store.createMemory({ title: "Zombie spawn rate", content: "Zombies spawn every 30 seconds near the walls.", category: "decision", project_id: p.id }, user);
  const c = b.store.createMemory({ title: "Zombie spawn rate", content: "Zombies spawn every 30 seconds near the walls", category: "decision", project_id: p.id }, user);
  b.store.createMemory({ title: "Zombie wall pathing", content: "Zombies path around the walls to reach the base gate in Outbreak.", category: "solution", project_id: p.id }, user);
  b.store.createMemory({ title: "Zombie walls gate", content: "Zombies attack the walls first, then the base gate in Outbreak.", category: "fact", project_id: p.id }, user);
  const orphan = b.store.createMemory({ title: "Zombies and walls", content: "Zombies attack walls and the base gate; path around walls.", category: "fact" }, user);
  const before = b.store.getMany([a.id, c.id, orphan.id]).map((m: any) => `${m.id}:${m.status}:${m.version}:${m.project_id}`);
  const job = await runAgent(b, "memory_curator");
  assert.equal(job.status, "awaiting_approval", JSON.stringify(job.result ?? job.last_error));
  const items: any[] = b.inbox.list().filter((i: any) => i.job_id === job.id);
  assert.ok(items.some((i: any) => i.operation === "merge" && i.affected_ids.includes(a.id) && i.affected_ids.includes(c.id)), "merge proposed");
  assert.ok(items.some((i: any) => i.operation === "assign_project" && i.target_memory_id === orphan.id), "move into project proposed");
  assert.deepEqual(b.store.getMany([a.id, c.id, orphan.id]).map((m: any) => `${m.id}:${m.status}:${m.version}:${m.project_id}`), before, "nothing changed yet");
  for (const i of items as any[]) b.inbox.reject(i.id, "keep");
  assert.deepEqual(b.store.getMany([a.id, c.id, orphan.id]).map((m: any) => `${m.id}:${m.status}:${m.version}:${m.project_id}`), before, "rejected: still unchanged");
  assert.equal(b.jobs.get(job.id)!.status, "done");
  b.close();
});

test("v0.4.0 test 10: Project Analyst reports an explicit blocker with its evidence (no AI needed)", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  const p = b.store.createProject({ name: "Swing and Grow" }, user);
  const bl: any = b.projectIntel.addItem(p.id, { kind: "blocker", title: "Vine physics explodes at high speed" });
  b.store.createMemory({ title: "Monkey growth", content: "Monkeys grow by eating.", category: "task", task_state: "done", project_id: p.id }, user);
  const job = await runAgent(b, "project_analyst");
  assert.equal(job.status, "done", JSON.stringify(job.last_error));
  const f: any[] = b.findings.list({ kind: "agent", category: "project_briefing", status: "active" });
  assert.equal(f.length, 1);
  assert.ok(f[0].source_refs.includes(`item:${bl.id}`), JSON.stringify(f[0].source_refs));
  assert.ok(f[0].evidence.some((e: any) => /Vine physics explodes/.test(e.note)));
  assert.match(f[0].suggested_action, /Clear the blocker: Vine physics explodes/);
  assert.equal(f[0].severity, "medium");
  assert.match(String(job.result.ai), /not available/, "says honestly that no written summary was made");
  b.close();
});

test("v0.4.0 test 11: Knowledge Connector suggests a cross-project relationship with evidence; confirming persists it", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  const s = b.store.createProject({ name: "Shopfront" }, user);
  const m = b.store.createProject({ name: "MOTH app" }, user);
  const lesson = b.store.createMemory({ title: "Onboarding checklist increased activation", content: "Lesson: a short onboarding checklist increased user activation and reduced first-run onboarding drop-off.", category: "solution", memory_type: "lesson", project_id: s.id }, user);
  const target = b.store.createMemory({ title: "First-run onboarding drop-off", content: "Users drop off during first-run onboarding before activation.", category: "idea", project_id: m.id }, user);
  const job = await runAgent(b, "knowledge_connector");
  assert.equal(job.status, "done");
  const d = b.findings.list({ kind: "discovery", status: "active" }).find((f: any) => f.memory_ids.includes(lesson.id) && f.memory_ids.includes(target.id));
  assert.ok(d, "suggested");
  assert.equal(d.agent, "agent:knowledge_connector");
  assert.ok(!b.store.relationshipsOf(lesson.id).some((r: any) => r.other_id === target.id), "a suggestion is not a relationship");
  b.discovery.confirm(Number(d.id));
  b.close();
  const b2 = Brain.open({ dataDir: (b as any).paths.base, role: "test" });
  assert.ok(b2.store.relationshipsOf(lesson.id).some((r: any) => r.other_id === target.id), "persisted across restart");
  b2.close();
});

test("v0.4.0 test 12: agent permissions are enforced in the engine (not just the UI) and denials are audited", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  assert.throws(() => b.permissions.set("agent:memory_curator", "modify_important", true), /can't be given to automated work/);
  b.permissions.set("agent:project_analyst", "create_analysis", false);
  b.store.createProject({ name: "P" }, user);
  const job = await runAgent(b, "project_analyst");
  assert.equal(job.status, "failed");
  assert.match(String(job.last_error), /not allowed to: create analysis results/);
  assert.ok(Number(b.db.value("SELECT COUNT(*) FROM activity_logs WHERE kind = 'permission' AND action = 'denied' AND source = 'agent:project_analyst'")) >= 1);
  // Proposing without permission is refused too.
  b.permissions.set("agent:memory_curator", "propose_changes", false);
  const x = b.store.createMemory({ title: "Dup", content: "Same text" }, user);
  b.store.createMemory({ title: "Dup", content: "Same text" }, user);
  const j2 = await runAgent(b, "memory_curator");
  assert.equal(j2.status, "done");
  assert.equal(j2.result.proposals, 0, "no proposals without the permission");
  assert.equal(b.store.getMemory(x.id)!.status, "active");
  b.close();
});

test("v0.4.0 agents: repeated submissions don't start duplicate runs; cancellation during a (stand-in) model call works", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  research(b, "R", "Long enough research text for the model.", [{ url: "https://e.org", title: "E" }]);
  const j1 = b.agents.run("research_analyst");
  assert.equal(b.agents.run("research_analyst"), j1, "same queued run");
  useFakeModel(b, hangingModel);
  const tick = b.jobs.tick();
  for (let i = 0; i < 50 && b.jobs.get(j1!)!.status !== "running"; i++) await sleep(20);
  await sleep(100);
  assert.equal(b.jobs.get(j1!)!.status, "running");
  assert.ok(b.jobs.cancel(j1!));
  await tick;
  assert.equal(b.jobs.get(j1!)!.status, "cancelled");
  assert.equal(b.inbox.list().length, 0);
  b.close();
});

test("v0.4.0 agents: a database write failure is reported as the real error and leaves no partial results", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  b.store.createProject({ name: "Q" }, user);
  b.db.exec("CREATE TRIGGER test_fail BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
  const jid = b.agents.run("project_analyst")!;
  await b.jobs.tick();
  let job = b.jobs.get(jid)!;
  assert.equal(job.status, "pending", "first failure: retried later (bounded)");
  assert.match(String(job.last_error), /simulated disk failure/);
  b.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", [new Date(0).toISOString(), jid]);
  await b.jobs.tick();
  job = b.jobs.get(jid)!;
  assert.equal(job.status, "failed");
  assert.match(String(job.last_error), /simulated disk failure/);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM findings")), 0);
  b.close();
});

test("v0.4.0 agents (ISOLATED, stand-in model): MOTH killed mid-run → the agent resumes after restart without duplicate proposals", async () => {
  const dir = tmpDir();
  let b = Brain.open({ dataDir: dir, role: "test" });
  research(b, "Cats", "Cats sleep about 15 hours a day.", [{ url: "https://e.org/cats", title: "Cats" }]);
  research(b, "Dogs", "Dogs need daily walks to stay healthy.", [{ url: "https://e.org/dogs", title: "Dogs" }]);
  b.registerIntelligenceJobs();
  const jid = b.agents.run("research_analyst")!;
  b.close();
  const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", path.join(here, "fixtures/agent-crash-child.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("child never reached its first proposal")), 30_000);
    child.stdout.on("data", (d) => String(d).includes("FIRST_DONE") && (clearTimeout(t), resolve()));
  });
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  b = Brain.open({ dataDir: dir, role: "test" });
  b.registerIntelligenceJobs();
  assert.equal(b.jobs.get(jid)!.status, "running", "left running by the crashed process");
  const proposalsBefore = b.inbox.list().length;
  assert.equal(proposalsBefore, 1, "one proposal was written before the crash");
  const rec = b.jobs.recoverStale();
  assert.equal(rec.requeued, 1, "agent jobs are resumable (every write is deduplicated)");
  // On restart the model answers normally for both notes.
  useFakeModel(b, (req) => {
    const quote = /Cats sleep/.test(req.user) ? "Cats sleep about 15 hours a day" : "Dogs need daily walks";
    return JSON.stringify({ insights: [{ text: `Insight: ${quote}.`, quote, source: 1 }] });
  });
  await b.jobs.tick();
  const job = b.jobs.get(jid)!;
  assert.equal(job.status, "awaiting_approval", JSON.stringify(job.last_error));
  const items: any[] = b.inbox.list();
  assert.equal(items.length, 2, `no duplicate proposal for the note handled before the crash: ${items.map((i: any) => i.statement).join(" | ")}`);
  b.close();
});
