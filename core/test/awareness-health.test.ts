// v0.4.0 Milestone 4: Awareness Engine + Knowledge Health (real engine + SQLite, real job queue).
import assert from "node:assert/strict";
import { test } from "node:test";
import { openBrain, user } from "./helpers.ts";

const active = (b: any, kind: string, category?: string) => b.findings.list({ kind, status: "active", category });

test("v0.4.0 test 5: an explicit unresolved decision becomes a finding; resolving it resolves the finding; no duplicates", async () => {
  const b = openBrain();
  const p = b.store.createProject({ name: "Cursed RNG" }, user);
  const it = b.projectIntel.addItem(p.id, { kind: "unresolved_decision", title: "Should the Auto Roll pass cost 99 or 149 Robux?" });
  const r1: any = await b.awareness.scan({ as: "user" });
  assert.equal(r1.projects, 1);
  const f = active(b, "awareness", "unresolved_decision");
  assert.equal(f.length, 1);
  assert.equal(f[0].project_id, p.id);
  assert.ok(f[0].source_refs.includes(`project_item:${it.id}`), "the finding points to the real item");
  assert.match(f[0].title, /Auto Roll pass/);
  // Nothing stored about it → a knowledge gap (possible, not confirmed).
  const gap = active(b, "awareness", "knowledge_gap");
  assert.equal(gap.length, 1);
  assert.equal(gap[0].evidence_status, "possible");

  // Repeated scans: still one finding each.
  await b.awareness.scan({ as: "user" });
  await b.awareness.scan({ as: "user" });
  assert.equal(b.findings.list({ kind: "awareness", status: "all", category: "unresolved_decision" }).length, 1);

  // Resolve the decision → the finding is no longer active (kept in history as resolved).
  b.projectIntel.resolveItem(it.id, { resolution: "149 Robux" });
  await b.awareness.scan({ as: "user" });
  assert.equal(active(b, "awareness", "unresolved_decision").length, 0);
  const hist = b.findings.list({ kind: "awareness", status: "resolved", category: "unresolved_decision" });
  assert.equal(hist.length, 1);
  assert.match(String(hist[0].resolution), /No longer present/);
  b.close();
});

test("v0.4.0: dismissed awareness findings don't come back unless their evidence changes", async () => {
  const b = openBrain();
  const p = b.store.createProject({ name: "Outbreak" }, user);
  const bl = b.projectIntel.addItem(p.id, { kind: "blocker", title: "Zombies get stuck on fences" });
  await b.awareness.scan({ as: "user" });
  const f = active(b, "awareness", "blocker")[0];
  assert.equal(f.severity, "high");
  b.findings.dismiss(f.id, "known, ignoring for now");
  await b.awareness.scan({ as: "user" });
  assert.equal(active(b, "awareness", "blocker").length, 0, "dismissed and unchanged: stays dismissed");
  b.projectIntel.updateItem(bl.id, { detail: "Now they also clip through walls" });
  await b.awareness.scan({ as: "user" });
  assert.equal(active(b, "awareness", "blocker").length, 1, "the blocker changed materially: shown again");
  b.close();
});

test("v0.4.0: awareness finds a relevant earlier lesson (with project boundaries) and documented incomplete work", async () => {
  const b = openBrain();
  const a = b.store.createProject({ name: "Swing and Grow" }, user);
  const o = b.store.createProject({ name: "Ironbound Arena" }, user);
  const s = b.store.createProject({ name: "Secret" }, user);
  b.store.updateProject(s.id, { private: true } as any, user);
  b.projectIntel.addItem(a.id, { kind: "blocker", title: "Network lag makes hit detection unfair" });
  const lesson = b.store.createMemory({ title: "Lag compensation for hit detection", content: "Network lag made hit detection unfair; fixed with server-side lag compensation that rewinds positions.", category: "solution", memory_type: "lesson", project_id: o.id }, user);
  const secretLesson = b.store.createMemory({ title: "Secret lag trick for hit detection", content: "Network lag hit detection unfair fixed with a secret trick.", category: "solution", memory_type: "lesson", project_id: s.id }, user);
  b.store.createMemory({ title: "Add vines", content: "Add swinging vines", category: "task", task_state: "open", project_id: a.id }, user);
  b.handoffs.save({ project: a.id, client: "claude-desktop", session_id: "x", summary: "Worked on swinging", next_steps: ["Tune vine physics"] });
  await b.awareness.scan({ as: "background" });
  const lessons = active(b, "awareness", "relevant_lesson");
  assert.ok(lessons.some((f: any) => f.memory_ids.includes(lesson.id)), "a lesson from a project that allows transfer is surfaced");
  assert.ok(!lessons.some((f: any) => f.memory_ids.includes(secretLesson.id)), "a private project's lesson is never surfaced");
  const work = active(b, "awareness", "incomplete_work");
  assert.equal(work.length, 2, "open tasks + the latest handoff's next steps");
  assert.ok(work.some((f: any) => /Tune vine physics/.test(f.title)));
  b.close();
});

test("v0.4.0: background awareness skips private projects; the user's manual scan includes them", async () => {
  const b = openBrain();
  const p = b.store.createProject({ name: "Diary" }, user);
  b.store.updateProject(p.id, { private: true } as any, user);
  b.projectIntel.addItem(p.id, { kind: "blocker", title: "Private blocker" });
  const r: any = await b.awareness.scan({ as: "background" });
  assert.equal(r.skipped_projects, 1);
  assert.equal(active(b, "awareness", "blocker").length, 0);
  await b.awareness.scan({ as: "user" });
  assert.equal(active(b, "awareness", "blocker").length, 1);
  // A later background scan must not resolve findings of projects it can't read.
  await b.awareness.scan({ as: "background" });
  assert.equal(active(b, "awareness", "blocker").length, 1);
  b.close();
});

test("v0.4.0 test 6: duplicates and conflicts are found on real records; rejecting a risky merge leaves the data unchanged", async () => {
  const b = openBrain();
  const p = b.store.createProject({ name: "MOTH" }, user);
  const d1 = b.store.createMemory({ title: "Lavender accent colour", content: "MOTH uses the lavender accent #A78BFA on charcoal.", category: "decision", project_id: p.id }, user);
  const d2 = b.store.createMemory({ title: "Lavender accent colour", content: "MOTH uses the lavender accent #A78BFA on charcoal!", category: "decision", project_id: p.id }, user);
  const s1 = b.store.createMemory({ title: "Backups are kept for seven days", content: "Automatic backups of the brain database are kept for seven days and older ones are deleted.", category: "fact" }, user);
  const s2 = b.store.createMemory({ title: "Backups are kept seven days", content: "Automatic backups of the brain database are kept for seven days, older ones are deleted.", category: "fact" }, user);
  const c = b.store.createMemory({ title: "Release on Fridays", content: "Releases go out on Fridays.", category: "decision", project_id: p.id }, user);
  b.db.run(`UPDATE memories SET flags = '["possible_conflict"]' WHERE id = ?`, [c.id]);
  const before = b.store.getMany([d1.id, d2.id, s1.id, s2.id, c.id]).map((m: any) => `${m.id}@${m.version}:${m.status}`);

  const r = await b.health.scan({ as: "user" });
  const exact = active(b, "health", "exact_duplicate");
  assert.equal(exact.length, 1);
  assert.deepEqual([...exact[0].memory_ids].sort(), [d1.id, d2.id].sort(), "the right memories are referenced");
  assert.equal(exact[0].evidence_status, "confirmed");
  const similar = active(b, "health", "similar_duplicate");
  assert.ok(similar.some((f: any) => f.memory_ids.includes(s1.id) && f.memory_ids.includes(s2.id)), JSON.stringify(r.checks.similar_duplicate));
  assert.ok(similar.every((f: any) => f.evidence_status === "possible"));
  const conflicts = active(b, "health", "conflict");
  assert.ok(conflicts.some((f: any) => f.memory_ids.includes(c.id)));
  // Conflicts and duplicates preserve the originals: the scan changed nothing.
  assert.deepEqual(b.store.getMany([d1.id, d2.id, s1.id, s2.id, c.id]).map((m: any) => `${m.id}@${m.version}:${m.status}`), before);

  // Risky change → review queue; reject → nothing changes and the finding is dismissed.
  const sim = similar.find((f: any) => f.memory_ids.includes(s1.id));
  const prop: any = b.health.propose(sim.id);
  const review = b.inbox.get(prop.review_id);
  assert.equal(review.status, "pending");
  b.inbox.reject(prop.review_id, "they differ");
  assert.deepEqual(b.store.getMany([s1.id, s2.id]).map((m: any) => `${m.id}@${m.version}:${m.status}`), before.slice(2, 4), "rejected: no memory changed");
  assert.equal(b.findings.get(sim.id).status, "dismissed");
  await b.health.scan({ as: "user" });
  assert.ok(!active(b, "health", "similar_duplicate").some((f: any) => f.memory_ids.includes(s1.id)), "a rejected suggestion isn't raised again");

  // Approving the exact-duplicate merge really merges.
  const prop2: any = b.health.propose(exact[0].id);
  b.inbox.approve(prop2.review_id);
  const statuses = b.store.getMany([d1.id, d2.id]).map((m: any) => m.status).sort();
  assert.deepEqual(statuses, ["active", "merged"]);
  assert.equal(b.findings.get(exact[0].id).status, "resolved");
  b.close();
});

test("v0.4.0: broken connections are proposed for repair; damaged search index and vectors are repaired automatically and logged", async () => {
  const b = openBrain();
  const a = b.store.createMemory({ title: "Alpha note about rockets", content: "Rockets need fuel." }, user);
  const x = b.store.createMemory({ title: "Beta note about fuel", content: "Fuel is heavy." }, user);
  const y = b.store.createMemory({ title: "Gamma note about fuel", content: "Fuel is heavy indeed." }, user);
  const rel = b.store.link(a.id, x.id, "RELATED_TO", "test", user);
  b.store.merge(y.id, [x.id], user);
  await b.health.scan({ as: "user", checks: ["broken_relationship"] });
  const br = active(b, "health", "broken_relationship");
  assert.equal(br.length, 1);
  assert.equal(br[0].action.relationship_id, rel.id);
  const prop: any = b.health.propose(br[0].id);
  b.inbox.approve(prop.review_id);
  const rels = b.store.relationshipsOf(a.id);
  assert.ok(rels.some((r: any) => r.other_id === y.id), "connection moved to the surviving memory");
  assert.ok(!rels.some((r: any) => r.id === rel.id));

  // Damage derived data: empty the full-text index and drop a vector.
  b.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')");
  b.db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [a.id]);
  assert.equal(b.search.keyword("rockets").size, 0, "index is really broken");
  const r = await b.health.scan({ as: "background", checks: ["search_index", "similarity_vectors"] });
  assert.equal(r.repairs.length, 2);
  assert.ok(b.search.keyword("rockets").has(a.id), "search works again after the automatic rebuild");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?", [a.id])), 1);
  assert.equal(b.health.repairs().length, 2, "repairs are in the audit history");
  b.close();
});

test("v0.4.0 test 17: Pause Learning / Privacy Mode stop intelligence jobs; background switch holds only background runs; revoked access denies reads", async () => {
  const b = openBrain();
  b.registerIntelligenceJobs();
  const p = b.store.createProject({ name: "Shopfront" }, user);
  b.projectIntel.addItem(p.id, { kind: "blocker", title: "Payment provider approval pending" });
  b.settings.set("automation.paused", true);
  const j1 = b.jobs.enqueue("intel_awareness_scan", { as: "background" }, { scope: "background" })!;
  const j2 = b.jobs.enqueue("intel_health_scan", { as: "user" }, { scope: "manual" })!;
  await b.jobs.tick();
  assert.equal(b.jobs.get(j1)?.status, "pending");
  assert.equal(b.jobs.get(j2)?.status, "pending", "Pause Learning: even manual analysis waits");
  b.settings.set("automation.paused", false);
  b.settings.set("privacy.mode", true);
  await b.jobs.tick();
  assert.equal(b.jobs.get(j1)?.status, "pending", "Privacy Mode: nothing runs");
  b.settings.set("privacy.mode", false);
  b.settings.set("intelligence.background", false);
  await b.jobs.tick();
  assert.equal(b.jobs.get(j2)?.status, "done", "manual run allowed");
  assert.equal(b.jobs.get(j1)?.status, "pending", "background analysis off: background job held");
  b.settings.set("intelligence.background", true);
  await b.jobs.tick();
  assert.equal(b.jobs.get(j1)?.status, "done");
  assert.equal(active(b, "awareness", "blocker").length, 1);

  // Revoke background access to the project: the next background scan may not read it.
  b.permissions.set("background", "read_projects", false, p.id);
  assert.throws(() => b.projectIntel.state(p.id, "background"), /not allowed/);
  const r: any = await b.awareness.scan({ as: "background" });
  assert.equal(r.skipped_projects, 1);
  const denied = b.db.value("SELECT COUNT(*) FROM activity_logs WHERE kind = 'permission' AND action = 'denied'");
  assert.ok(Number(denied) >= 1, "the denial is audited");
  b.close();
});
