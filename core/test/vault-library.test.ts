// v0.5.0 Vault: knowledge foundation, library operations, Markdown parsing and Smart Backlinks.
// Real engine + SQLite. No AI involved.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { extractAliases, extractHeadings, extractLinks, extractTags, rewriteLinkTargets, splitFrontmatter } from "../src/vault/markdown.ts";
import { openBrain, tmpDir, user } from "./helpers.ts";

test("Markdown: wikilinks (alias, heading, folder path, embeds), standard links, unsafe schemes, code is ignored, unicode", () => {
  const text = [
    "---",
    "title: Über Notes",
    "tags: [roblox, ui/menus]",
    "aliases:",
    "  - Ueber",
    "  - Über-Note",
    "custom: { nested: true }",
    "---",
    "# Café ☕ plan",
    "See [[Shop|the shop]] and [[Design/Combat#Parry window]] and ![[sword.png]].",
    "Also [docs](Guides/Start%20Here.md#install) and [site](https://example.org) and [bad](javascript:alert(1)).",
    "Inline `[[NotALink]]` and #inline-tag #日本語 but not #1.",
    "```",
    "[[AlsoNotALink]] #nottag",
    "```",
    "Unsupported ((block ref)) stays as text.",
  ].join("\n");
  const fm = splitFrontmatter(text);
  assert.equal(fm.data.title, "Über Notes");
  assert.deepEqual(fm.data.tags, ["roblox", "ui/menus"]);
  assert.ok(fm.raw!.includes("custom: { nested: true }"), "unknown metadata is preserved verbatim");
  assert.deepEqual(extractAliases(text), ["Ueber", "Über-Note"]);
  const tags = extractTags(text);
  for (const t of ["roblox", "ui/menus", "inline-tag", "日本語"]) assert.ok(tags.includes(t), t);
  assert.ok(!tags.includes("nottag") && !tags.includes("1"));
  assert.equal(extractHeadings(text)[0].text, "Café ☕ plan");
  const links = extractLinks(text);
  const by = (t: string) => links.find((l) => l.target === t)!;
  assert.equal(by("Shop").alias, "the shop");
  assert.equal(by("Design/Combat").heading, "Parry window");
  assert.equal(by("sword.png").kind, "embed");
  assert.equal(by("Guides/Start Here.md").heading, "install", "percent-encoding decoded");
  assert.equal(by("https://example.org").external, true);
  assert.equal(links.find((l) => l.raw.includes("javascript"))!.unsafe, true);
  assert.ok(!links.some((l) => /NotALink/.test(l.target)), "links in code are ignored");
  // Malformed Markdown doesn't throw.
  assert.doesNotThrow(() => extractLinks("[[unclosed and [broken](  and ]] ]("));
  const rw = rewriteLinkTargets("A [[Old|x]] b [[old#h]] c ![[Old]] d [m](Old.md) e [[Other]]", ["Old"], "New");
  assert.equal(rw.text, "A [[New|x]] b [[New#h]] c ![[New]] d [](New.md) e [[Other]]".replace("[](New.md)", "[m](New.md)"));
  assert.equal(rw.changed, 4);
});

test("Library: notes, folders, safe deletes, stale-write protection, revisions and restore, search, tags, collections, workspace", () => {
  const b = openBrain();
  const L = b.library;
  const games = L.createFolder("Games");
  const roblox = L.createFolder("Roblox", games.id as string);
  assert.throws(() => L.createFolder("Roblox", games.id as string), /already exists/);
  assert.throws(() => L.createFolder("bad/name"), /can't contain/);
  assert.throws(() => L.moveFolder(games.id as string, roblox.id as string), /into itself/);
  const n = L.create({ title: "Arena plan", content: "# Arena plan\nMatches last three minutes. #design", folder_id: roblox.id as string });
  assert.equal(n.version, 1);
  assert.deepEqual(n.tags, ["design"]);
  assert.equal(L.get(n.id as string).path, "Games/Roblox/Arena plan");
  // Same title in the same folder gets a suffix on create; rename into a clash is refused.
  const dup = L.create({ title: "Arena plan", content: "x", folder_id: roblox.id as string });
  assert.equal(dup.title, "Arena plan 2");
  assert.throws(() => L.update(dup.id as string, { title: "Arena plan" }), /already called/);
  assert.throws(() => L.create({ title: "Bad [title]" }), /can't contain/);

  // Saving based on an old version is refused (no stale overwrite).
  const v2 = L.update(n.id as string, { content: "# Arena plan\nMatches last five minutes." }, { base_version: 1 });
  assert.equal(v2.version, 2);
  assert.throws(() => L.update(n.id as string, { content: "stale text" }, { base_version: 1 }), (e: any) => e.code === "conflict");
  assert.equal(L.doc(n.id as string).content, "# Arena plan\nMatches last five minutes.");
  // Revisions: the first save kept the original; restoring keeps the current text too.
  const revs = L.revisions(n.id as string);
  assert.equal(revs.length, 1);
  assert.equal(L.revision(revs[0].id as number).content, "# Arena plan\nMatches last three minutes. #design");
  const restored = L.restoreRevision(revs[0].id as number);
  assert.match(String(restored.content), /three minutes/);
  const after = L.revisions(n.id as string);
  assert.ok(after.some((r) => /Before restoring/.test(String(r.reason))));
  assert.ok(after.some((r) => L.revision(r.id as number).content === "# Arena plan\nMatches last five minutes."), "the newer text can still be recovered");

  // Search (titles and content), tags with nesting, sorting.
  L.create({ title: "Menus", content: "Main menu layout #ui/menus", folder_id: games.id as string });
  assert.equal(L.list({ q: "three minutes" }).items[0].id, n.id);
  assert.equal(L.list({ tag: "ui" }).total, 1, "parent tag finds nested tags");
  assert.equal(L.list({ folder_id: games.id as string, recursive: true }).total, 3);
  assert.equal(L.list({ folder_id: games.id as string }).total, 1);
  assert.deepEqual(L.list({ sort: "title" }).items.map((i) => i.title), ["Arena plan", "Arena plan 2", "Menus"]);

  // Deleting: archive first; permanent delete only from the archive; non-empty folders can't be deleted.
  assert.throws(() => L.deletePermanently(dup.id as string), /Archive the note first/);
  L.archive(dup.id as string);
  assert.equal(L.list({ status: "archived" }).total, 1);
  L.deletePermanently(dup.id as string);
  assert.throws(() => L.deleteFolder(roblox.id as string), /isn't empty/);

  // Collections hold references; deleting one leaves the notes alone.
  const col = L.createCollection("Launch");
  L.setInCollection(col.id as string, "document", n.id as string, true);
  assert.equal(L.list({ collection: col.id as string }).total, 1);
  L.deleteCollection(col.id as string);
  assert.ok(L.doc(n.id as string));

  // Workspace sessions persist; missing entities are reported, not crashed on.
  L.saveWorkspace({ panes: [{ tabs: [{ kind: "document", id: n.id }, { kind: "document", id: "doc_gone" }] }] });
  assert.equal((L.workspace().state as any).panes[0].tabs.length, 2);
  const res = L.resolveEntities([{ kind: "document", id: n.id as string }, { kind: "document", id: "doc_gone" }]);
  assert.deepEqual(res.map((r) => r.exists), [true, false]);
  b.close();
});

test("Smart Backlinks: deterministic resolution (title, alias, path, heading), ambiguity recorded, unresolved kept, rename/move keep links working", () => {
  const b = openBrain();
  const L = b.library;
  const a = L.createFolder("A");
  const c = L.createFolder("C");
  const shopA = L.create({ title: "Shop", content: "---\naliases: [Store]\n---\nShop in folder A", folder_id: a.id as string });
  const hub = L.create({ title: "Hub", content: "Links: [[Shop]] [[Store|the store]] [[Shop#Prices]] [[Missing note]] [[#Local heading]]" , folder_id: a.id as string });
  let bl: any = L.backlinks(shopA.id as string);
  assert.equal(bl.incoming.length, 3, "title, alias and heading links all resolve to Shop");
  assert.ok((L.backlinks(hub.id as string) as any).unresolved.some((u: any) => u.target_text === "Missing note"));
  // A second "Shop" elsewhere: links from folder A still prefer the one next to them…
  const shopC = L.create({ title: "Shop", content: "Shop in folder C", folder_id: c.id as string });
  L.update(hub.id as string, { content: L.doc(hub.id as string).content + " again [[Shop]]" });
  assert.equal((L.backlinks(shopA.id as string) as any).incoming.filter((x: any) => x.raw === "[[Shop]]").length, 2);
  // …but a note in a third place that says [[Shop]] is ambiguous (recorded with both candidates, not guessed).
  const other = L.create({ title: "Elsewhere", content: "Go to [[Shop]]" });
  const amb = (L.backlinks(other.id as string) as any).unresolved.find((u: any) => u.target_text === "Shop");
  assert.equal(amb.status, "ambiguous");
  assert.deepEqual(amb.candidates.map((x: any) => x.id).sort(), [shopA.id, shopC.id].sort());
  // Path links pick exactly one.
  const p = L.create({ title: "Paths", content: "[[C/Shop]] and [[A/Shop]]" });
  const outs: any = (L.backlinks(p.id as string) as any).outgoing;
  assert.deepEqual(outs.map((o: any) => o.target_id).sort(), [shopA.id, shopC.id].sort());
  // Creating the missing note resolves the earlier unresolved link.
  const missing = L.create({ title: "Missing note", content: "now it exists" });
  assert.equal((L.backlinks(missing.id as string) as any).incoming.length, 1);

  // Rename: links that pointed at the note are rewritten (with a revision) and still resolve to it.
  const before = L.doc(hub.id as string).version as number;
  const r = L.rename(shopA.id as string, "Shop A");
  assert.ok(Number(r.links_updated) >= 3);
  const hubText = String(L.doc(hub.id as string).content);
  assert.match(hubText, /\[\[Shop A\]\]/);
  assert.match(hubText, /\[\[Shop A#Prices\]\]/);
  assert.match(hubText, /\[\[Store\|the store\]\]/, "alias links keep working through the alias and are left as written");
  assert.ok(Number(L.doc(hub.id as string).version) > before);
  bl = L.backlinks(shopA.id as string);
  assert.ok(bl.incoming.length >= 4, JSON.stringify(bl.incoming.map((x: any) => x.raw)));
  assert.equal((L.backlinks(other.id as string) as any).outgoing.find((o: any) => o.target_text === "Shop")?.target_id, shopC.id, "with one Shop left, the other note's link resolves to it (no rename hijack)");
  // Move: path links follow.
  const d = L.createFolder("D");
  L.move(shopC.id as string, d.id as string);
  assert.match(String(L.doc(p.id as string).content), /\[\[D\/Shop\]\]/);
  assert.equal((L.backlinks(p.id as string) as any).outgoing.find((o: any) => o.target_text === "D/Shop")?.target_id, shopC.id);
  // Archive → links become unresolved (text kept); restore → resolved again.
  L.archive(missing.id as string);
  assert.equal((L.backlinks(hub.id as string) as any).unresolved.filter((u: any) => u.target_text === "Missing note").length, 1);
  L.restore(missing.id as string);
  assert.equal((L.backlinks(missing.id as string) as any).incoming.length, 1);
  // Manual links to memories are kept when the text changes; parser links are rebuilt.
  const mem = b.store.createMemory({ title: "Shop prices", content: "Swords cost 300" }, user);
  L.addManualLink(hub.id as string, "memory", mem.id);
  L.update(hub.id as string, { content: "rewritten without links" });
  const hb: any = L.backlinks(hub.id as string);
  assert.equal(hb.memories.length, 1);
  assert.equal(hb.outgoing.filter((o: any) => o.created_by === "parser").length, 0);
  // The Mind shows notes as their own kind of node, with their links as edges.
  const g: any = b.graph({});
  assert.ok(g.nodes.some((n: any) => n.kind === "document" && n.id === hub.id));
  assert.ok(g.links.some((l: any) => l.source_id === hub.id && l.target_id === mem.id));
  assert.ok(g.nodes.some((n: any) => n.id === mem.id && n.kind !== "document"), "memories stay memories");
  b.close();
});

test("Migration: a real v0.4.0 database upgrades to v0.5.0 with every memory, project, relationship and setting kept, after a backup copy", () => {
  const dir = tmpDir();
  let b = openBrain(dir);
  const p = b.store.createProject({ name: "Arena" }, user);
  const m1 = b.store.createMemory({ title: "Timer", content: "Matches last three minutes", project_id: p.id }, user);
  const m2 = b.store.createMemory({ title: "Respawn", content: "Players respawn after five seconds", project_id: p.id }, user);
  b.store.link(m1.id, m2.id, "RELATED_TO", "both are match rules", user);
  b.store.updateMemory(m1.id, { content: "Matches last five minutes" }, user);
  b.settings.set("graph", { ...b.settings.get("graph"), nodeSize: 1.7 });
  const counts = () => ["memories", "memory_versions", "memory_relationships", "projects", "settings"].map((t) => Number(b.db.value(`SELECT COUNT(*) FROM ${t}`)));
  const before = counts();
  const file = b.db.file;
  b.close();
  // Turn it into exactly the v0.4.0 schema (v6 only added new objects).
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = OFF");
  const v6 = raw.prepare("SELECT type, name FROM sqlite_master WHERE name IN ('folders','documents','document_tags','document_aliases','documents_fts','document_revisions','document_links','collections','collection_items','attachments','attachment_refs','import_batches','import_items','import_link_targets','document_positions','workspace_sessions') AND type = 'table'").all() as any[];
  raw.exec("DROP TABLE IF EXISTS documents_fts");
  for (const t of v6.filter((x) => x.name !== "documents_fts")) raw.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  raw.exec("DELETE FROM schema_migrations WHERE version >= 6");
  assert.equal(Number((raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as any).v), 5);
  raw.close();
  b = openBrain(dir);
  assert.equal(Number(b.db.value("SELECT MAX(version) FROM schema_migrations")), 6);
  assert.deepEqual(counts(), before, "nothing lost");
  assert.equal(b.store.getMemory(m1.id)!.content, "Matches last five minutes");
  assert.equal(b.store.versions(m1.id).length, 2);
  assert.equal(b.settings.get("graph").nodeSize, 1.7);
  const backups = fs.readdirSync(path.join(path.dirname(file), "backups")).filter((f) => f.startsWith("before-schema-v6"));
  assert.equal(backups.length, 1, "a copy was made before upgrading");
  const copy = new DatabaseSync(path.join(path.dirname(file), "backups", backups[0]), { readOnly: true });
  assert.equal(Number((copy.prepare("SELECT COUNT(*) AS n FROM memories").get() as any).n), before[0]);
  copy.close();
  // The new library works on the upgraded database.
  const d = b.library.create({ title: "First note", content: "Hello [[Timer]]" });
  assert.equal(b.library.list({ q: "hello" }).items[0].id, d.id);
  // A failed transaction leaves nothing half-written.
  assert.throws(() => b.db.tx(() => {
    b.library.create({ title: "Half", content: "x" });
    throw new Error("boom");
  }));
  assert.equal(b.library.list({ q: "Half" }).total, 0);
  b.close();
});
