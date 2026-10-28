// v0.4.0 Milestone 7: The Mind 3.0 — pathways and knowledge evolution from stored records only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openBrain, user } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("v0.4.0 test 13: the path follows the actual stored edges; disconnected memories get no invented path", () => {
  const b = openBrain();
  const m = (t: string) => b.store.createMemory({ title: t, content: `${t} content` }, user);
  const a = m("A rockets"), c = m("C fuel"), d = m("D oxygen"), e = m("E engines"), x = m("X unrelated");
  const r1 = b.store.link(a.id, c.id, "RELATED_TO", "rockets need fuel", user);
  const r2 = b.store.link(d.id, c.id, "DEPENDS_ON", "burning fuel needs oxygen", user);
  const r3 = b.store.link(d.id, e.id, "REFERENCES", "engines mix oxygen", user);
  b.store.link(a.id, e.id, "CONTINUES", "longer route? no: direct", user); // a direct alternative
  const p: any = b.mindTime.path(a.id, d.id);
  assert.equal(p.found, true);
  assert.equal(p.hops, 2, "shortest path");
  for (const s of p.steps) {
    const rel: any = b.db.get("SELECT * FROM memory_relationships WHERE id = ?", [s.relationship.id]);
    assert.ok(rel, "every step is a stored relationship");
    assert.ok([s.from.id, s.to.id].sort().join() === [rel.source_id, rel.target_id].sort().join(), "the step uses that relationship's real endpoints");
  }
  assert.deepEqual(p.node_ids[0], a.id);
  assert.deepEqual(p.node_ids[p.node_ids.length - 1], d.id);
  assert.ok([r1.id, r2.id, r3.id].some((id) => p.edge_ids.includes(id)));
  const none: any = b.mindTime.path(a.id, x.id);
  assert.equal(none.found, false);
  assert.match(none.message, /doesn't invent/);
  // A merged (inactive) memory is not a stepping stone.
  b.store.merge(e.id, [c.id], user);
  const p2: any = b.mindTime.path(a.id, d.id);
  assert.ok(!p2.node_ids?.includes(c.id));
  b.close();
});

test("v0.4.0 test 14: history shows the real versions and timestamps; the graph at a past moment is rebuilt from stored history", async () => {
  const b = openBrain();
  const a = b.store.createMemory({ title: "Price v1", content: "Auto roll costs 99" }, user);
  const other = b.store.createMemory({ title: "Shop", content: "The shop sells passes" }, user);
  await sleep(15);
  const t1 = new Date().toISOString();
  await sleep(15);
  b.store.updateMemory(a.id, { title: "Price v2", content: "Auto roll costs 149" }, user);
  const rel = b.store.link(a.id, other.id, "RELATED_TO", "price shown in the shop", user);
  await sleep(15);
  const t2 = new Date().toISOString();
  await sleep(15);
  b.store.updateMemory(a.id, { title: "Price v3", content: "Auto roll costs 199" }, user);
  b.store.unlink(rel.id, user);
  const late = b.store.createMemory({ title: "Later idea", content: "Added at the end" }, user);

  const versions = b.store.versions(a.id);
  assert.deepEqual(versions.map((v: any) => v.version).sort(), [1, 2, 3]);
  assert.ok(versions.every((v: any) => typeof v.created_at === "string"));

  const g1: any = b.mindTime.graphAt(t1);
  assert.equal(g1.nodes.find((n: any) => n.id === a.id).title, "Price v1", "title as it was then");
  assert.equal(g1.links.length, 0, "the connection didn't exist yet");
  assert.ok(!g1.nodes.some((n: any) => n.id === late.id), "memories created later don't appear");
  const g2: any = b.mindTime.graphAt(t2);
  assert.equal(g2.nodes.find((n: any) => n.id === a.id).title, "Price v2");
  assert.equal(g2.links.length, 1, "the connection removed later is restored from its 'unlinked' event");
  assert.equal(g2.links[0].id, rel.id);
  assert.equal(g2.restored_links, 1);
  const now: any = b.mindTime.graphAt(new Date().toISOString());
  assert.equal(now.nodes.find((n: any) => n.id === a.id).title, "Price v3");
  assert.equal(now.links.length, 0);
  assert.ok(now.nodes.some((n: any) => n.id === late.id));
  const mo: any = b.mindTime.moments();
  assert.ok(mo.days.length >= 1 && mo.days.reduce((n: number, d: any) => n + Number(d.n), 0) >= 7);
  b.close();
});
