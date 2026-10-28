// v0.4.0 Milestone 9: MOTH Pulse 2.0 — every number on the Overview comes from stored records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { intelligencePulse } from "../src/api/pulse.ts";
import { openBrain, user } from "./helpers.ts";

test("v0.4.0 test 16: Pulse counts match the database exactly, feeds hold only stored items, and an empty brain shows zeros and empty feeds", async () => {
  const b = openBrain();
  const empty: any = intelligencePulse(b);
  for (const [k, v] of Object.entries(empty.counts)) assert.equal(v, 0, `${k} is 0 on an empty brain`);
  for (const k of ["awareness", "discoveries", "agents", "continuity"]) assert.deepEqual(empty.feeds[k], [], `${k} feed is empty`);
  assert.equal(empty.feeds.health.last_scan, null);

  const pid = (name: string) => (b.store.getProject(name) ?? b.store.createProject({ name }, user)).id;
  const m = (t: string, project?: string) => b.store.createMemory({ title: t, content: `${t} details`, project_id: project ? pid(project) : null }, user);
  const a = m("Arena uses a 3 minute timer", "Arena");
  const lesson = m("Server rewind fixes hit desync", "Shooter");
  b.projectIntel.addItem("Arena", { kind: "unresolved_decision", title: "Best of 3 or best of 5?" });
  b.projectIntel.addItem("Arena", { kind: "unresolved_decision", title: "Ranked mode now or later?" });
  const resolved = b.projectIntel.addItem("Arena", { kind: "unresolved_decision", title: "Map size" });
  b.projectIntel.resolveItem(resolved.id as string, { resolution: "Medium maps" });
  b.projectIntel.addItem("Arena", { kind: "blocker", title: "Waiting for animations" });
  // A dropped/archived project's open items don't count.
  m("Old idea", "Old");
  b.projectIntel.addItem("Old", { kind: "unresolved_decision", title: "Old question" });
  const old = b.store.getProject("Old")!;
  b.db.run("UPDATE projects SET archived = 1 WHERE id = ?", [old.id]);
  // Findings: one high-confidence discovery, one below the bar, one dismissed.
  const f = (conf: number, key: string) => b.findings.upsert({ kind: "discovery", category: "cross_project", key: [key], title: `Discovery ${key}`, description: "d", memory_ids: [a.id, lesson.id], evidence: [{ note: "n" }], algorithm: "test", evidence_status: "possible", confidence: conf }).id!;
  f(0.9, "hi");
  f(0.6, "lo");
  const dismissed = f(0.95, "gone");
  b.findings.dismiss(dismissed, "no");
  await b.awareness.scan({ as: "user" });
  b.handoffs.save({ project: "Arena", client: "claude-code", session_id: "s1", summary: "Timer done", completed: ["Timer"], next_steps: ["Pick the match format"], created_by: "claude" } as any);

  const p: any = intelligencePulse(b);
  const n = (sql: string, args: unknown[] = []) => Number(b.db.value(sql, args));
  assert.equal(p.counts.unresolved_decisions, 2, "open decisions in non-archived projects only");
  assert.equal(p.counts.open_blockers, 1);
  assert.equal(p.counts.high_confidence_discoveries, 1, "only active discoveries at or above 75%");
  assert.equal(p.counts.discoveries, 2);
  assert.equal(p.counts.pending_reviews, n("SELECT COUNT(*) FROM review_queue WHERE status = 'pending'"));
  assert.equal(p.counts.awareness_items, n("SELECT COUNT(*) FROM findings WHERE kind = 'awareness' AND status IN ('new','viewed')"));
  assert.ok(p.counts.awareness_items >= 3, "awareness found the decisions and the blocker");
  assert.equal(p.counts.projects, n("SELECT COUNT(*) FROM projects WHERE archived = 0"));
  assert.equal(p.counts.active_projects, 2);
  // Feeds point at stored rows.
  for (const x of p.feeds.awareness) assert.ok(b.db.value("SELECT 1 FROM findings WHERE id = ? AND kind = 'awareness'", [x.id]));
  assert.deepEqual(p.feeds.discoveries.map((d: any) => d.title), ["Discovery hi"]);
  const arena = p.feeds.continuity.find((c: any) => c.name === "Arena");
  assert.equal(arena.next_step.text, "Pick the match format", "next step comes from the stored handoff");
  assert.equal(arena.handoff.summary, "Timer done");
  assert.equal(arena.unresolved, 2);
  assert.equal(arena.blockers, 1);
  assert.equal(p.feeds.agents.length, 0, "no agent ran, so no agent activity is shown");
  b.close();
});
