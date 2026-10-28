// v0.4.0 Milestones 2-3: Project Intelligence 2.0 and Session Continuity (real engine + SQLite).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Brain } from "../src/engine/brain.ts";
import { openBrain, tmpDir, user } from "./helpers.ts";

test("v0.4.0 test 3: project summary distinguishes decisions, completed work and unresolved issues, with evidence", () => {
  const b = openBrain();
  const p: any = b.store.createProject({ name: "Ironbound Arena", goals: "Ship a 1v1 melee prototype" }, user);
  const dec: any = b.store.createMemory({ title: "Use server-side hit detection", content: "Hits are validated on the server to stop exploits.", category: "decision", project_id: p.id }, user);
  const done: any = b.store.createMemory({ title: "Sword swing animation", content: "Implemented the sword swing animation.", category: "task", task_state: "done", project_id: p.id }, user);
  const open: any = b.store.createMemory({ title: "Add block mechanic", content: "Players need to block attacks.", category: "task", task_state: "open", project_id: p.id }, user);
  const ud: any = b.projectIntel.addItem(p.id, { kind: "unresolved_decision", title: "Should matches be best of 3 or best of 5?" });
  const bl: any = b.projectIntel.addItem(p.id, { kind: "blocker", title: "Hitbox desync on high ping" });
  const obj: any = b.projectIntel.addItem(p.id, { kind: "objective", title: "Playable 1v1 match" });

  const s: any = b.projectIntel.state(p.id);
  assert.deepEqual(s.decisions.map((d: any) => d.id), [dec.id]);
  assert.deepEqual(s.completed_work.map((d: any) => d.id), [done.id]);
  assert.deepEqual(s.open_tasks.map((d: any) => d.id), [open.id]);
  assert.deepEqual(s.unresolved_decisions.map((d: any) => d.id), [ud.id]);
  assert.deepEqual(s.blockers.map((d: any) => d.id), [bl.id]);
  assert.deepEqual(s.objectives.map((d: any) => d.id), [obj.id]);
  // Evidence-based progress: 1 of 2 tasks done, labelled as tasks-based; never invented.
  assert.equal(s.progress.status, "confirmed");
  assert.equal(s.progress.basis, "tasks");
  assert.equal(s.progress.done, 1);
  assert.equal(s.progress.total, 2);

  const r: any = b.projectIntel.resume(p.id);
  assert.equal(r.next_step.ref.type, "item");
  assert.equal(r.next_step.ref.id, bl.id, "with no handoff, the oldest blocker comes first");
  assert.ok(r.unresolved.some((u: any) => u.kind === "unresolved_decision" && u.ref.id === ud.id));
  assert.ok(r.last_completed.some((c: any) => c.ref.id === done.id));
  for (const x of [...r.unresolved, ...r.decisions, ...r.last_completed]) assert.ok(x.ref?.id, "every line points to its record");
  b.close();
});

test("v0.4.0: progress is 'unknown' without milestones or tasks; milestones take precedence", () => {
  const b = openBrain();
  const p: any = b.store.createProject({ name: "Empty" }, user);
  b.store.createMemory({ title: "An idea", content: "Some idea", category: "idea", project_id: p.id }, user);
  assert.equal((b.projectIntel.state(p.id) as any).progress.status, "unknown");
  assert.equal((b.projectIntel.state(p.id) as any).progress.percent, null);
  const m1: any = b.projectIntel.addItem(p.id, { kind: "milestone", title: "Alpha" });
  b.projectIntel.addItem(p.id, { kind: "milestone", title: "Beta" });
  b.projectIntel.resolveItem(m1.id);
  const pr: any = b.projectIntel.state(p.id).progress;
  assert.equal(pr.basis, "milestones");
  assert.equal(pr.done, 1);
  assert.equal(pr.total, 2);
  b.close();
});

test("v0.4.0: unresolved decisions can be inspected and resolved; the decision is recorded; state persists after restart", () => {
  const dir = tmpDir();
  let b = Brain.open({ dataDir: dir, role: "test" });
  const p: any = b.store.createProject({ name: "Cursed RNG" }, user);
  const ud: any = b.projectIntel.addItem(p.id, { kind: "unresolved_decision", title: "Price of the Auto Roll pass", detail: "99 or 149 Robux?" });
  assert.equal(b.projectIntel.addItem(p.id, { kind: "unresolved_decision", title: "price of the auto roll pass" }).id, ud.id, "no duplicate open item");
  const res: any = b.projectIntel.resolveItem(ud.id, { resolution: "149 Robux" });
  assert.equal(res.status, "resolved");
  assert.ok(res.resolution_memory_id);
  const m: any = b.store.getMemory(res.resolution_memory_id)!;
  assert.equal(m.category, "decision");
  assert.equal(m.project_id, p.id);
  assert.match(m.content, /149 Robux/);
  assert.throws(() => b.projectIntel.resolveItem(ud.id), /already resolved/);
  b.close();
  b = Brain.open({ dataDir: dir, role: "test" });
  const s: any = b.projectIntel.state(p.id);
  assert.equal(s.unresolved_decisions.length, 0);
  assert.equal(s.resolved_items.length, 1);
  assert.ok(s.decisions.some((d: any) => d.id === res.resolution_memory_id));
  assert.equal(b.projectIntel.reopenItem(ud.id).status, "open");
  b.close();
});

test("v0.4.0: project boundaries — other projects' knowledge only with transfer allowed, never from private projects, never their decisions", () => {
  const b = openBrain();
  const a: any = b.store.createProject({ name: "Swing and Grow" }, user);
  const other: any = b.store.createProject({ name: "Outbreak" }, user);
  const secret: any = b.store.createProject({ name: "Secret game" }, user);
  b.store.updateProject(secret.id, { private: true } as any, user);
  b.projectIntel.addItem(a.id, { kind: "blocker", title: "Rope swinging physics jitter at high speed" });
  const lesson: any = b.store.createMemory({ title: "Rope swinging physics jitter fix", content: "Rope swinging physics jitter at high speed was fixed by clamping velocity and using constraints.", category: "solution", memory_type: "lesson", project_id: other.id }, user);
  const privLesson: any = b.store.createMemory({ title: "Rope swinging physics jitter (secret)", content: "Rope swinging physics jitter at high speed solved with secret constraint trick.", category: "solution", memory_type: "lesson", project_id: secret.id }, user);
  const otherDecision: any = b.store.createMemory({ title: "Rope swinging physics jitter requirement", content: "Requirement: rope swinging physics jitter at high speed must be tolerated.", category: "decision", project_id: other.id }, user);

  let r: any = b.projectIntel.resume(a.id);
  const ids = r.helpful_research.map((h: any) => h.memory.id);
  assert.ok(ids.includes(lesson.id), "a lesson from a project that allows transfer is suggested");
  const hit: any = r.helpful_research.find((h: any) => h.memory.id === lesson.id);
  assert.equal(hit.from_project, "Outbreak");
  assert.match(hit.why, /From your project Outbreak/);
  assert.ok(!ids.includes(privLesson.id), "private project knowledge never leaks");
  assert.ok(!ids.includes(otherDecision.id), "another project's decisions/requirements are never suggested");

  b.store.updateProject(other.id, { transfer_enabled: false } as any, user);
  r = b.projectIntel.resume(a.id);
  assert.ok(!r.helpful_research.some((h: any) => h.memory.id === lesson.id), "transfer switched off: no cross-project suggestions");
  b.close();
});

test("v0.4.0: background work and agents cannot read a private project (permission enforced in the engine)", () => {
  const b = openBrain();
  const p: any = b.store.createProject({ name: "Diary" }, user);
  b.store.updateProject(p.id, { private: true } as any, user);
  assert.throws(() => b.projectIntel.state(p.id, "agent:project_analyst"), /not allowed/);
  assert.doesNotThrow(() => b.projectIntel.state(p.id)); // the user can always read their own project
  b.permissions.set("agent:project_analyst", "read_projects", true, p.id);
  assert.doesNotThrow(() => b.projectIntel.state(p.id, "agent:project_analyst"));
  b.close();
});

test("v0.4.0: handoffs — versions, duplicate protection, edits and validation", () => {
  const b = openBrain();
  const p: any = b.store.createProject({ name: "MOTH" }, user);
  const m: any = b.store.createMemory({ title: "Handoff test memory", content: "x", project_id: p.id }, user);
  const h1: any = b.handoffs.save({ project: "MOTH", client: "claude-desktop", session_id: "s1", summary: "Did things", next_steps: ["Next"], memory_ids: [m.id] });
  assert.equal(h1.outcome, "created");
  assert.equal(b.handoffs.save({ project: "MOTH", client: "claude-desktop", session_id: "s1", summary: "Did things", next_steps: ["Next"], memory_ids: [m.id] }).outcome, "unchanged");
  const other: any = b.handoffs.save({ project: "MOTH", client: "claude-code", session_id: "s1", summary: "Other client, same session id" });
  assert.equal(other.outcome, "created", "the key includes the client");
  const manual: any = b.handoffs.save({ project: "MOTH", summary: "Manual handoff without a session" });
  const ed: any = b.handoffs.edit(manual.handoff.id as string, { next_steps: ["Edited step"] });
  assert.equal(ed.id, manual.handoff.id, "editing a keyless handoff updates it instead of creating a new one");
  assert.equal(ed.version, 2);
  assert.equal(b.handoffs.versions(ed.id as string).length, 1);
  assert.throws(() => b.handoffs.save({ summary: "x" }), /summary/);
  assert.throws(() => b.handoffs.save({ summary: "valid summary", project: "Nope" }), /No project/);
  assert.equal(b.handoffs.list({ project: "MOTH" }).length, 3);
  assert.equal((b.projectIntel.state(p.id) as any).latest_handoff.id, ed.id);
  // Same-millisecond writes (fast machines): the most recently written handoff still wins.
  b.db.run("UPDATE handoffs SET updated_at = '2026-01-01T00:00:00.000Z'");
  const again: any = b.handoffs.edit(h1.handoff.id as string, { summary: "Did things, then more" });
  b.db.run("UPDATE handoffs SET updated_at = '2026-01-01T00:00:00.000Z'");
  assert.equal(b.handoffs.latest("MOTH")!.id, again.id);
  b.close();
});

test("v0.4.0: Claude Code SessionEnd hook queues a handoff job only when enabled; without AI nothing is invented", async () => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = tmpDir();
  const transcript = path.join(dir, "session.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { role: "user", content: "Let's add the refund flow to Shopfront." } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I added the refund endpoint and tests. The partial refund case is still open." }] } }),
  ].join("\n") + "\n");
  const runHook = (input: object) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", path.resolve(import.meta.dirname, "../src/index.ts"), "hook", "session-end"], { env: { ...process.env, MOTH_DATA_DIR: dir, MOTH_LOG_STDERR: "0" }, stdio: ["pipe", "pipe", "pipe"] });
      p.stdin.end(JSON.stringify(input));
      p.on("exit", (code) => resolve(code ?? -1));
    });
  const input = { session_id: "cc-1", transcript_path: transcript, cwd: "/home/u/Shopfront", hook_event_name: "SessionEnd", reason: "prompt_input_exit" };

  // Off by default: nothing queued.
  assert.equal(await runHook(input), 0);
  let b = Brain.open({ dataDir: dir, role: "test" });
  assert.equal(b.jobs.list({ owner: "sessions" }).length, 0);
  b.settings.set("sessions.autoHandoff", true);
  b.store.createProject({ name: "Shopfront" }, user);
  b.close();

  // On: the hook (a separate process, like Claude Code runs it) queues exactly one job, even if it fires twice.
  assert.equal(await runHook(input), 0);
  assert.equal(await runHook(input), 0);
  b = Brain.open({ dataDir: dir, role: "test" });
  const jobs = b.jobs.list({ owner: "sessions" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "session_handoff");
  // Run it here (no local model in this test environment): it must not invent a handoff.
  const out: any = await b.sessionHandoff(jobs[0].payload as any);
  assert.match(String(out.skipped), /No handoff written/);
  assert.equal(b.handoffs.list().length, 0);
  b.close();
});
