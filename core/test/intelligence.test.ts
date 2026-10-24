// v0.4.0 "Consciousness" — Milestone 1: durable jobs, permissions, provenance (findings), migration v4.
// Real engine + real SQLite; the crash test kills a real child process with SIGKILL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Database } from "../src/db/database.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/db/migrations.ts";
import { Brain } from "../src/engine/brain.ts";
import { awaitingApproval } from "../src/engine/jobs.ts";
import { openBrain, tmpDir, user } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("migration v4 upgrades a v3 database: memories, projects, research, preferences, versions, settings and jobs are kept", () => {
  const dir = tmpDir();
  const raw = new DatabaseSync(path.join(dir, "moth.db"));
  const run = (q: string, p: unknown[] = []) => raw.prepare(q).run(...(p as never[]));
  raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
    raw.exec(m.sql);
    run("INSERT INTO schema_migrations VALUES (?,?,?)", [m.version, m.name, new Date().toISOString()]);
  }
  const t = new Date().toISOString();
  run("INSERT INTO users(id, kind, name, created_at) VALUES ('local','local','Local user',?)", [t]);
  run("INSERT INTO projects(id, user_id, name, slug, goals, created_at, updated_at) VALUES ('prj_1','local','Cursed RNG','cursed-rng','Ship the beta',?,?)", [t, t]);
  run(`INSERT INTO memories(id, user_id, title, content, category, project_id, created_at, updated_at, memory_type, pinned, version) VALUES ('mem_a','local','Rolls','Rolls cost 1 coin','decision','prj_1',?,?,'project',1,2)`, [t, t]);
  run(`INSERT INTO memories(id, user_id, title, content, category, created_at, updated_at, memory_type, evidence) VALUES ('mem_r','local','Research','Studies say X','research',?,?,'research','sourced')`, [t, t]);
  run(`INSERT INTO memory_versions(memory_id, version, title, content, summary, category, tags, project_id, importance, confidence, status, changed_by, change_type, reason, created_at) VALUES ('mem_a',1,'Rolls','Rolls cost 2 coins','','decision','[]','prj_1',0.5,0.8,'active','user','create','x',?)`, [t]);
  run(`INSERT INTO memory_relationships(id, user_id, source_id, target_id, type, strength, reason, created_by, created_at) VALUES ('rel_1','local','mem_a','mem_r','RELATED_TO',0.7,'test','user',?)`, [t]);
  run(`INSERT INTO memory_sources(memory_id, url, title, created_at) VALUES ('mem_r','https://example.org/paper','Paper',?)`, [t]);
  run(`INSERT INTO settings(key, value, updated_at) VALUES ('appearance.motion','"full"',?)`, [t]);
  run(`INSERT INTO jobs(kind, payload, status, priority, attempts, max_attempts, run_after, created_at, updated_at) VALUES ('reflect','{}','pending',5,0,4,?,?,?)`, [t, t, t]);
  run(`INSERT INTO jobs(kind, payload, status, priority, attempts, max_attempts, run_after, result, created_at, updated_at) VALUES ('backup','{}','done',5,1,4,?,'{"ok":true}',?,?)`, [t, t, t]);
  raw.close();

  const b = Brain.open({ dataDir: dir, role: "test" });
  assert.equal(SCHEMA_VERSION >= 4, true);
  assert.equal(Number(b.db.value("SELECT MAX(version) FROM schema_migrations")), SCHEMA_VERSION);
  const a = b.store.requireMemory("mem_a");
  assert.equal(a.content, "Rolls cost 1 coin");
  assert.equal(a.version, 2);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM memory_versions WHERE memory_id = 'mem_a'")), 1);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM memory_relationships")), 1);
  assert.equal(b.db.value("SELECT url FROM memory_sources WHERE memory_id = 'mem_r'"), "https://example.org/paper");
  assert.equal(b.store.getProject("prj_1")?.goals, "Ship the beta");
  assert.equal(b.settings.get("appearance.motion"), "full");
  const jobs = b.db.all<any>("SELECT kind, status, owner, finished_at, result FROM jobs ORDER BY id");
  assert.deepEqual(jobs.map((j) => [j.kind, j.status, j.owner]), [["reflect", "pending", "system"], ["backup", "done", "system"]]);
  assert.ok(jobs[1].finished_at, "completed jobs keep a finish time");
  assert.equal(JSON.parse(jobs[1].result).ok, true);
  // New states are now accepted by the schema.
  b.db.run("UPDATE jobs SET status = 'interrupted' WHERE kind = 'reflect'");
  assert.equal(b.db.value("SELECT status FROM jobs WHERE kind = 'reflect'"), "interrupted");
  b.close();
});

test("durable jobs: persist across a restart, run once, store result and timestamps", async () => {
  const dir = tmpDir();
  let b = openBrain(dir);
  const id = b.jobs.enqueue("intel_echo", { n: 2 }, { owner: "test", title: "Echo", dedupe: "echo" })!;
  assert.equal(b.jobs.enqueue("intel_echo", { n: 3 }, { dedupe: "echo" }), null, "duplicate submission is ignored");
  b.close();

  b = openBrain(dir);
  let runs = 0;
  b.jobs.register("intel_echo", async (job) => ({ doubled: job.payload.n * 2, runs: ++runs }));
  assert.equal(b.jobs.get(id)?.status, "pending");
  await b.jobs.tick();
  const j = b.jobs.get(id)!;
  assert.equal(j.status, "done");
  assert.deepEqual(j.result, { doubled: 4, runs: 1 });
  assert.equal(j.owner, "test");
  assert.equal(j.title, "Echo");
  assert.ok(j.started_at && j.finished_at && j.started_at <= j.finished_at);
  await b.jobs.tick();
  assert.equal(runs, 1, "a completed job never runs again");
  b.close();
});

async function crashDuring(dir: string, kind: string): Promise<number> {
  const b = openBrain(dir);
  const id = b.jobs.enqueue(kind, {}, { owner: "test" })!;
  b.close();
  const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", path.join(here, "fixtures/job-crash-child.ts"), dir], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("child never reached its checkpoint")), 20_000);
    child.stdout.on("data", (d) => {
      if (String(d).includes(`STEP_DONE ${id}`)) (clearTimeout(t), resolve());
    });
  });
  child.kill("SIGKILL"); // a real crash: no shutdown code runs
  await new Promise((r) => child.once("exit", r));
  return id;
}

test("restart after a crash: resumable jobs continue from their checkpoint without duplicate writes", async () => {
  const dir = tmpDir();
  const id = await crashDuring(dir, "intel_crash_resumable");
  const b = openBrain(dir);
  assert.equal(b.jobs.get(id)?.status, "running", "the crashed process left the job running");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM memories WHERE title = 'Written by intel_crash_resumable'")), 1);
  let resumedSteps = 0;
  b.jobs.register(
    "intel_crash_resumable",
    async (_job, _s, jc) => {
      await jc.step("write-memory", () => {
        resumedSteps++;
        return b.store.createMemory({ title: "Written by intel_crash_resumable", content: "again" }, user).id;
      });
      return { finished: true };
    },
    { resumable: true },
  );
  assert.deepEqual(b.jobs.recoverStale(), { requeued: 1, interrupted: 0 });
  await b.jobs.tick();
  const j = b.jobs.get(id)!;
  assert.equal(j.status, "done");
  assert.equal(resumedSteps, 0, "the committed step was not executed again");
  assert.equal(Number(j.recoveries), 1);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM memories WHERE title = 'Written by intel_crash_resumable'")), 1, "no duplicate write");
  b.close();
});

test("restart after a crash: non-resumable jobs become 'interrupted' and only run again when retried", async () => {
  const dir = tmpDir();
  const id = await crashDuring(dir, "intel_crash_once");
  const b = openBrain(dir);
  let runs = 0;
  b.jobs.register("intel_crash_once", async () => ({ runs: ++runs }), { resumable: false });
  assert.deepEqual(b.jobs.recoverStale(), { requeued: 0, interrupted: 1 });
  await b.jobs.tick();
  let j = b.jobs.get(id)!;
  assert.equal(j.status, "interrupted");
  assert.match(String(j.last_error), /interrupted/i);
  assert.equal(runs, 0, "nothing re-ran on its own");
  assert.equal(b.jobs.retry(id), true);
  await b.jobs.tick();
  j = b.jobs.get(id)!;
  assert.equal(j.status, "done");
  assert.equal(runs, 1);
  b.close();
});

test("cancellation: a running job is aborted (also when cancelled from another process) and ends cancelled", async () => {
  const b = openBrain();
  let aborted = 0;
  const hang = async (_j: unknown, signal: AbortSignal) =>
    new Promise((_r, rej) => {
      const t = setTimeout(() => rej(new Error("should have been cancelled")), 10_000);
      signal.addEventListener("abort", () => (clearTimeout(t), aborted++, rej(signal.reason)));
    });
  b.jobs.register("intel_hang", hang);
  // Same process.
  const a = b.jobs.enqueue("intel_hang", {})!;
  const p1 = b.jobs.tick();
  while (b.jobs.currentJobId() !== a) await sleep(10);
  assert.equal(b.jobs.cancel(a, "Test cancel"), true);
  await p1;
  assert.equal(b.jobs.get(a)?.status, "cancelled");
  assert.equal(b.jobs.get(a)?.cancel_reason, "Test cancel");
  // Another process (a separate connection marks it cancelled; the runner notices within about a second).
  const c = b.jobs.enqueue("intel_hang", {})!;
  const p2 = b.jobs.tick();
  while (b.jobs.currentJobId() !== c) await sleep(10);
  const other = new Database(b.db.file);
  other.run("UPDATE jobs SET status = 'cancelled', cancel_reason = 'From the MCP process' WHERE id = ?", [c]);
  other.close();
  const t0 = Date.now();
  await p2;
  assert.ok(Date.now() - t0 < 2500, "cross-process cancel noticed quickly");
  assert.equal(b.jobs.get(c)?.status, "cancelled");
  assert.equal(aborted, 2);
  b.close();
});

test("timeouts and bounded retries: a job that runs too long fails with the real error", async () => {
  const b = openBrain();
  b.jobs.register("intel_slow", async (_j, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(signal.reason))), { timeoutMs: 150 });
  const id = b.jobs.enqueue("intel_slow", {}, { maxAttempts: 2 })!;
  await b.jobs.tick();
  let j = b.jobs.get(id)!;
  assert.equal(j.status, "pending", "first failure is retried later (backoff)");
  assert.match(String(j.last_error), /Timed out/);
  assert.ok(Date.parse(j.run_after as string) > Date.now() + 5000, "with backoff");
  b.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", [new Date(0).toISOString(), id]);
  await b.jobs.tick();
  j = b.jobs.get(id)!;
  assert.equal(j.status, "failed");
  assert.match(String(j.last_error), /Timed out after 0 s|Timed out/);
  assert.ok(j.finished_at);
  b.close();
});

test("awaiting approval: a job that proposed changes completes only when its reviews are decided", async () => {
  const b = openBrain();
  const m = b.store.createMemory({ title: "Target", content: "Something" }, user);
  b.jobs.register("intel_propose", async (job) => {
    b.db.run(
      `INSERT INTO review_queue(user_id, kind, operation, target_memory_id, proposal, statement, reason, risk, job_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [b.store.userId, "cortex", "update", m.id, "{}", "Proposed edit", "test", "high", job.id, new Date().toISOString()],
    );
    return awaitingApproval({ proposals: 1 });
  });
  const id = b.jobs.enqueue("intel_propose", {})!;
  await b.jobs.tick();
  assert.equal(b.jobs.get(id)?.status, "awaiting_approval");
  assert.deepEqual(b.jobs.get(id)?.result, { proposals: 1 });
  const rid = Number(b.db.value("SELECT id FROM review_queue WHERE job_id = ?", [id]));
  b.inbox.reject(rid, "not now");
  assert.equal(b.jobs.get(id)?.status, "done");
  assert.equal(b.store.requireMemory(m.id).content, "Something", "rejecting changed nothing");
  b.close();
});

test("job controls respect Privacy Mode, Pause Learning and the background-analysis switch", async () => {
  const b = openBrain();
  const ran: string[] = [];
  b.jobs.register("intel_scan", async (job) => void ran.push(job.scope));
  b.jobs.heldSql = () => b.heldJobsSql();
  b.settings.set("automation.paused", true);
  b.jobs.enqueue("intel_scan", {}, { scope: "manual" });
  b.jobs.enqueue("intel_scan", {}, { scope: "background" });
  await b.jobs.tick();
  assert.deepEqual(ran, [], "Pause Learning: no analysis starts at all");
  b.settings.set("automation.paused", false);
  b.settings.set("intelligence.background", false);
  await b.jobs.tick();
  assert.deepEqual(ran, ["manual"], "background analysis off: only the manual run starts");
  b.settings.set("intelligence.background", true);
  await b.jobs.tick();
  assert.deepEqual(ran, ["manual", "background"]);
  b.close();
});

test("permissions: least privilege by default, private projects excluded, enforced and audited in the engine", () => {
  const b = openBrain();
  const p = b.store.createProject({ name: "Secret Project" }, user);
  const q = b.store.createProject({ name: "Open Project" }, user);
  b.db.run("UPDATE projects SET private = 1 WHERE id = ?", [p.id]);
  const P = b.permissions;
  assert.equal(P.allowed("agent:memory_curator", "read_memories"), true);
  assert.equal(P.allowed("agent:memory_curator", "propose_changes"), true);
  assert.equal(P.allowed("agent:memory_curator", "modify_important"), false);
  assert.equal(P.allowed("agent:research_analyst", "network"), false);
  assert.equal(P.allowed("background", "read_memories", p.id), false, "private project is off-limits");
  assert.equal(P.allowed("background", "read_memories", q.id), true);
  assert.throws(() => P.assert("agent:project_analyst", "read_projects", p.id), /not allowed/);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM activity_logs WHERE kind = 'permission' AND action = 'denied'")), 1, "denial is audited");
  // Revoke, then allow one project explicitly.
  P.set("agent:project_analyst", "read_projects", false);
  assert.equal(P.allowed("agent:project_analyst", "read_projects", q.id), false);
  P.set("agent:project_analyst", "read_projects", true, p.id);
  assert.equal(P.allowed("agent:project_analyst", "read_projects", p.id), true, "explicit project grant wins");
  assert.equal(P.allowed("agent:project_analyst", "read_projects", q.id), false);
  // Consequential permissions can never be granted to automated work.
  assert.throws(() => P.set("agent:memory_curator", "modify_important", true), /can't be given/);
  b.db.run("INSERT INTO permissions(subject, permission, project_id, allowed, updated_at) VALUES ('agent:memory_curator','modify_important','*',1,?)", [new Date().toISOString()]);
  assert.equal(P.allowed("agent:memory_curator", "modify_important"), false, "even a forged database row can't grant it");
  b.close();
});

test("findings: provenance is validated, duplicates are merged, dismissals stick until evidence changes, scans resolve", () => {
  const b = openBrain();
  const F = b.findings;
  const m1 = b.store.createMemory({ title: "A", content: "Alpha" }, user);
  const m2 = b.store.createMemory({ title: "B", content: "Beta" }, user);
  const base = { kind: "health" as const, category: "duplicate", key: [m1.id, m2.id], title: "Possible duplicate", description: "A and B look alike", memory_ids: [m1.id, m2.id], evidence: [{ memory_id: m1.id, note: "same words" }], algorithm: "test", evidence_status: "possible" as const };
  assert.equal(F.upsert({ ...base, memory_ids: [m1.id, "mem_doesnotexist"] }).outcome, "rejected", "invented evidence is refused");
  const r1 = F.upsert(base);
  assert.equal(r1.outcome, "created");
  assert.equal(F.upsert(base).outcome, "unchanged", "a repeated scan doesn't create a duplicate");
  const f = F.get(r1.id!);
  assert.deepEqual(f.memory_ids, [m1.id, m2.id]);
  assert.equal((f.memories as any[]).length, 2);
  assert.equal(f.algorithm, "test");
  F.dismiss(r1.id!, "they are different");
  assert.equal(F.upsert(base).outcome, "suppressed", "dismissed stays dismissed while nothing changed");
  b.store.updateMemory(m2.id, { content: "Beta, edited" }, user);
  const r2 = F.upsert(base);
  assert.equal(r2.outcome, "created", "material change: shown again");
  assert.notEqual(r2.id, r1.id);
  assert.equal(F.reconcile("health", ["duplicate"], new Set()), 1);
  assert.equal(F.get(r2.id!).status, "resolved");
  assert.equal(F.list({ kind: "health" }).length, 0);
  assert.equal(F.list({ kind: "health", status: "all" }).length, 2, "history is kept");
  b.close();
});
