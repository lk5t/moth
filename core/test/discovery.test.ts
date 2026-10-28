// v0.4.0 Milestone 5: Discovery Engine (quiet mode). Real engine + SQLite; no AI involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openBrain, user } from "./helpers.ts";

function seed(b: any) {
  const shop = b.store.createProject({ name: "Shopfront" }, user);
  const moth = b.store.createProject({ name: "MOTH app" }, user);
  const lesson = b.store.createMemory({ title: "Onboarding checklist increased activation", content: "Lesson: a short onboarding checklist with three steps increased user activation and reduced drop-off during first-run onboarding.", category: "solution", memory_type: "lesson", project_id: shop.id }, user);
  const target = b.store.createMemory({ title: "First-run onboarding drop-off", content: "Many users drop off during the first-run onboarding before activation; the onboarding flow needs work.", category: "idea", project_id: moth.id }, user);
  const unrelated = b.store.createMemory({ title: "Zombie pathfinding", content: "Zombies use A* pathfinding around fences and walls.", category: "solution", memory_type: "lesson", project_id: shop.id }, user);
  return { shop, moth, lesson, target, unrelated };
}

test("v0.4.0 test 7: a genuine cross-project connection is suggested with both sources; dismissal sticks; unrelated knowledge is filtered", async () => {
  const b = openBrain();
  const s = seed(b);
  const before = b.db.value("SELECT COUNT(*) FROM memory_relationships");
  const r: any = await b.discovery.scan({ as: "user" });
  const found = b.findings.list({ kind: "discovery", status: "active" });
  const d: any = found.find((f: any) => f.memory_ids.includes(s.lesson.id) && f.memory_ids.includes(s.target.id));
  assert.ok(d, `expected a discovery; scan stats: ${JSON.stringify(r)}`);
  assert.equal(d.category, "cross_project");
  assert.deepEqual([...d.project_ids].sort(), [s.shop.id, s.moth.id].sort(), "references both projects");
  assert.ok(d.evidence.some((e: any) => e.memory_id === s.lesson.id) && d.evidence.some((e: any) => e.memory_id === s.target.id));
  assert.ok(d.confidence >= 0.6, "quiet mode: only confident suggestions are stored");
  assert.match(d.description, /onboarding/);
  assert.ok(!found.some((f: any) => f.memory_ids.includes(s.unrelated.id)), "no invented connection for unrelated knowledge");
  assert.equal(b.db.value("SELECT COUNT(*) FROM memory_relationships"), before, "suggestions never create relationships by themselves");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM activity_logs WHERE kind = 'notification'")), 0, "quiet: no notifications");

  // Dismiss → repeated scans don't recreate it while nothing changed.
  b.findings.dismiss(d.id, "not relevant");
  await b.discovery.scan({ as: "user" });
  await b.discovery.scan({ as: "user" });
  assert.ok(!b.findings.list({ kind: "discovery", status: "active" }).some((f: any) => f.memory_ids.includes(s.lesson.id) && f.memory_ids.includes(s.target.id)));
  assert.equal(b.findings.list({ kind: "discovery", status: "all" }).filter((f: any) => f.memory_ids.includes(s.lesson.id) && f.memory_ids.includes(s.target.id)).length, 1, "no duplicate rows either");
  // Material change (the memory is edited) → it may be suggested again.
  b.store.updateMemory(s.target.id, { content: "Many users drop off during first-run onboarding before activation; we will add an onboarding checklist." }, user);
  await b.discovery.scan({ as: "user" });
  assert.ok(b.findings.list({ kind: "discovery", status: "active" }).some((f: any) => f.memory_ids.includes(s.lesson.id) && f.memory_ids.includes(s.target.id)));
  b.close();
});

test("v0.4.0: confirming a discovery creates a real, persisted relationship; private projects and disabled transfer are excluded", async () => {
  const b = openBrain();
  const s = seed(b);
  await b.discovery.scan({ as: "user" });
  const d: any = b.findings.list({ kind: "discovery", status: "active" }).find((f: any) => f.memory_ids.includes(s.lesson.id))!;
  assert.ok(b.discovery.suggestedEdges().some((e: any) => e.finding_id === d.id), "shown as a suggested (not confirmed) edge");
  const res: any = b.discovery.confirm(d.id);
  assert.equal(res.links.length, 1);
  const rel = b.db.get("SELECT * FROM memory_relationships WHERE id = ?", [res.links[0]]) as any;
  assert.ok(rel, "relationship persisted");
  assert.match(rel.reason, /Confirmed discovery/);
  assert.equal(b.findings.get(d.id).status, "confirmed");
  assert.ok(!b.discovery.suggestedEdges().some((e: any) => e.finding_id === d.id), "no longer a suggestion: it's a real edge now");

  // Private project: nothing from it is suggested elsewhere.
  const b2 = openBrain();
  const s2 = seed(b2);
  b2.store.updateProject(s2.shop.id, { private: true } as any, user);
  await b2.discovery.scan({ as: "user" });
  assert.equal(b2.findings.list({ kind: "discovery", status: "active" }).filter((f: any) => f.memory_ids.includes(s2.lesson.id)).length, 0);
  b2.store.updateProject(s2.shop.id, { private: false, transfer_enabled: false } as any, user);
  await b2.discovery.scan({ as: "user" });
  assert.equal(b2.findings.list({ kind: "discovery", status: "active" }).filter((f: any) => f.memory_ids.includes(s2.lesson.id)).length, 0, "knowledge transfer off: excluded");
  b.close();
  b2.close();
});

test("v0.4.0: stored research that matches an open question is suggested; feedback raises the bar for a category", async () => {
  const b = openBrain();
  const p = b.store.createProject({ name: "Cursed RNG" }, user);
  b.store.createMemory({ title: "Cursed RNG", content: "Project hub", category: "project", project_id: p.id }, user);
  b.store.updateProject(p.id, {} as any, user);
  b.projectIntel.addItem(p.id, { kind: "unresolved_decision", title: "How to store player roll history without hitting DataStore limits?" });
  const research = b.store.createMemory({ title: "Roblox DataStore request limits", content: "Roblox DataStore requests are limited per server per minute; batch player data writes and store roll history compactly to avoid hitting limits.", category: "research", memory_type: "research" }, user);
  await b.discovery.scan({ as: "user" });
  const q = b.findings.list({ kind: "discovery", status: "active", category: "answers_question" });
  assert.ok(q.some((f: any) => f.memory_ids.includes(research.id)), JSON.stringify(q.map((x: any) => x.title)));

  const base = b.discovery.threshold("cross_project");
  for (let i = 0; i < 3; i++) {
    const id = b.findings.upsert({ kind: "discovery", category: "cross_project", key: [`x${i}`], title: "t", description: "d", memory_ids: [research.id], evidence: [{ note: "n" }], algorithm: "test", evidence_status: "possible" }).id!;
    b.findings.dismiss(id);
  }
  assert.ok(b.discovery.threshold("cross_project") > base, "a category the user keeps dismissing needs more confidence");
  b.close();
});
