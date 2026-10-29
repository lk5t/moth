// v0.5.0 Vault: one-time Obsidian import. Real engine, SQLite, job queue and real files on disk.
// Every test checks that the source vault was not changed (same files, same bytes, nothing added).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Brain } from "../src/engine/brain.ts";
import { openBrain, tmpDir } from "./helpers.ts";

function write(root: string, rel: string, data: string | Buffer) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

/** A small but realistic vault: nested folders, same-name notes, aliases, broken and ambiguous links, attachments. */
export function makeVault(root: string) {
  const png = crypto.randomBytes(5000);
  write(root, "Home.md", "---\ntags: [index]\n---\n# Home\nStart at [[Projects/Arena]] or [[Ideas]]. Picture: ![[logo.png]]\nBroken: [[Does not exist]]. Ambiguous: [[Notes]].\nPDF: [spec](Files/spec.pdf)");
  write(root, "Ideas.md", "---\naliases: [Brainstorm]\n---\nIdeas list #ideas\n- [ ] try parry\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```lua\nprint('[[not a link]]')\n```");
  write(root, "Projects/Arena.md", "# Arena\nSee [[Brainstorm]] and [[Ideas#List]]. Copy of the logo: ![[logo copy.png]]");
  write(root, "Projects/Notes.md", "Project notes");
  write(root, "Journal/Notes.md", "Journal notes");
  write(root, "Journal/2026/Été ☀️.md", "Unicode title, links to [[Home]]");
  write(root, "Empty.md", "");
  write(root, "Attachments/logo.png", png);
  write(root, "Attachments/logo copy.png", png); // identical file under another name
  write(root, "Files/spec.pdf", "%PDF-1.4 fake pdf for the test");
  write(root, "Files/tool.exe", "MZ any file type is kept");
  write(root, ".obsidian/workspace.json", '{"main":{}}');
  write(root, ".obsidian/plugins/x/main.js", "console.log('plugin')");
  fs.mkdirSync(path.join(root, "Empty folder"), { recursive: true });
}

export function manifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = "dir";
        walk(r);
      } else {
        const st = fs.statSync(path.join(root, r));
        out[r] = `${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, r))).digest("hex")}:${st.size}:${Math.round(st.mtimeMs)}`;
      }
    }
  };
  walk("");
  return out;
}

async function until(b: Brain, id: string, statuses: string[], max = 400) {
  for (let i = 0; i < max; i++) {
    const s = String(b.importer.batch(id).status);
    if (statuses.includes(s)) return b.importer.batch(id);
    await b.jobs.tick();
  }
  throw new Error(`import stuck in ${b.importer.batch(id).status}`);
}

function readOnly(root: string, on: boolean) {
  // Effective for non-root users (e.g. CI); the manifest comparison below is the real check.
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      fs.chmodSync(p, on ? (e.isDirectory() ? 0o555 : 0o444) : e.isDirectory() ? 0o755 : 0o644);
    }
  };
  walk(root);
  fs.chmodSync(root, on ? 0o555 : 0o755);
}

test("Obsidian import: scan preview from real files, import, links, attachments; the vault is not modified", async () => {
  const vault = path.join(tmpDir(), "My Vault");
  makeVault(vault);
  readOnly(vault, true);
  const before = manifest(vault);
  const b = openBrain();
  b.importer.registerJobs();
  const imp = b.importer.startScan(vault);
  const scanned = await until(b, imp.id as string, ["scanned", "failed"]);
  assert.equal(scanned.status, "scanned", String(scanned.error));
  const s = scanned.scan as any;
  assert.equal(s.notes, 7);
  assert.equal(s.attachments, 4, "every non-note file is kept, whatever its type");
  assert.equal(s.unsupported_files, 0);
  assert.ok(s.skipped_folders.includes(".obsidian"), "Obsidian settings and plugins are left out");
  assert.equal(s.unresolved_links, 1, JSON.stringify(s.unresolved_examples));
  assert.equal(s.unresolved_examples[0].target, "does not exist");
  assert.deepEqual(s.same_name_notes.map((x: any) => x.name), ["notes"]);
  assert.ok(s.disk.free_bytes === null || s.disk.free_bytes > 0);

  b.importer.start(imp.id as string, {});
  const done = await until(b, imp.id as string, ["done", "failed"]);
  assert.equal(done.status, "done", String(done.error));
  const r = done.result as any;
  assert.equal(r.notes, 7);
  assert.equal(r.attachments, 4);
  assert.equal(r.errors, 0);
  assert.ok(r.duration_ms >= 0);
  // Folders kept (inside a folder named after the vault), notes are independent editable copies.
  const L = b.library;
  const root = L.tree().find((f) => f.parent_id === null)!;
  assert.equal(root.name, "My Vault");
  const home = L.list({ q: "Start at" }).items[0];
  assert.equal(L.get(home.id as string).path, "My Vault/Home");
  assert.equal(L.get(L.list({ q: "Unicode title" }).items[0].id as string).path, "My Vault/Journal/2026/Été ☀️");
  const bl = L.backlinks(home.id as string) as any;
  const arena = bl.outgoing.find((o: any) => o.target_text === "Projects/Arena");
  assert.equal(arena.status, "resolved");
  assert.equal(bl.outgoing.find((o: any) => o.target_text === "logo.png").target_kind, "attachment");
  assert.equal(bl.outgoing.find((o: any) => o.target_text === "Files/spec.pdf").target_kind, "attachment");
  assert.ok(bl.unresolved.some((u: any) => u.target_text === "Does not exist" && u.status === "unresolved"));
  assert.ok(bl.unresolved.some((u: any) => u.target_text === "Notes" && u.status === "ambiguous" && u.candidates.length === 2), "two notes called Notes: recorded as ambiguous, not guessed");
  const arenaDoc = L.backlinks(arena.target_id) as any;
  assert.equal(arenaDoc.outgoing.find((o: any) => o.target_text === "Brainstorm").target_title, "Ideas", "aliases resolve");
  // Identical files are stored once, under both names.
  const atts = L.attachments().items;
  assert.equal(atts.length, 4);
  assert.equal(new Set(atts.filter((a: any) => /logo/.test(a.original_name)).map((a: any) => a.storage_path)).size, 1);
  const { file } = L.attachmentFile(atts.find((a: any) => a.original_name === "logo.png")!.id as string);
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(vault, "Attachments/logo.png")));
  // Editing the copy never touches the vault.
  L.update(home.id as string, { content: "changed in MOTH" });
  assert.deepEqual(manifest(vault), before, "source vault unchanged: same files, same bytes, same times, nothing added");
  readOnly(vault, false);
  b.close();
});

test("Obsidian import: a repeated import skips confirmed duplicates; identical text elsewhere is not merged", async () => {
  const vault = path.join(tmpDir(), "Vault");
  makeVault(vault);
  const b = openBrain();
  b.importer.registerJobs();
  const first = b.importer.startScan(vault);
  await until(b, first.id as string, ["scanned"]);
  b.importer.start(first.id as string, {});
  await until(b, first.id as string, ["done"]);
  const docs = Number(b.db.value("SELECT COUNT(*) FROM documents"));
  const again = b.importer.startScan(vault);
  const sc = await until(b, again.id as string, ["scanned"]);
  assert.equal((sc.scan as any).duplicates_existing, 7);
  b.importer.start(again.id as string, {});
  const d = await until(b, again.id as string, ["done"]);
  assert.equal((d.result as any).duplicates, 11, "7 notes and 4 files already imported");
  assert.equal((d.result as any).folders, 0, "added to the earlier import's folder, no second folder");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), docs, "nothing imported twice");
  // "Import separately" makes copies on request.
  const third = b.importer.startScan(vault);
  await until(b, third.id as string, ["scanned"]);
  b.importer.start(third.id as string, { duplicates: "separate", folderName: "Second copy" });
  await until(b, third.id as string, ["done"]);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), docs * 2);
  b.close();
});

test("Obsidian import: interrupted (crash), paused and resumed, then undone safely", async () => {
  const vault = path.join(tmpDir(), "Big");
  for (let i = 0; i < 450; i++) write(vault, `Folder ${i % 7}/Note ${i}.md`, `# Note ${i}\nLinks to [[Note ${(i + 1) % 450}]] #n${i % 5}`);
  write(vault, "media/big.bin.png", crypto.randomBytes(3 * 1024 * 1024));
  const before = manifest(vault);
  const dir = tmpDir();
  let b = openBrain(dir);
  b.importer.registerJobs();
  b.importer.sliceMs = 0; // one batch of 100 notes per job: lets the test stop between batches
  const imp = b.importer.startScan(vault);
  await until(b, imp.id as string, ["scanned"]);
  b.importer.start(imp.id as string, {});
  await b.jobs.tick(); // first batch
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 100);
  // "Crash": the process goes away with the next job queued. A new process picks up where it stopped.
  b.close();
  b = openBrain(dir);
  b.importer.registerJobs();
  b.importer.sliceMs = 0;
  await b.jobs.tick();
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 200);
  // Pause → nothing happens; resume → finishes.
  b.importer.pause(imp.id as string);
  for (let i = 0; i < 3; i++) await b.jobs.tick();
  assert.equal(b.importer.batch(imp.id as string).status, "paused");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 200);
  b.importer.start(imp.id as string);
  const done = await until(b, imp.id as string, ["done"]);
  assert.equal((done.result as any).notes, 450);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 450, "no note imported twice across the crash and the pause");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM document_links WHERE status = 'resolved'")), 450);
  assert.equal((done.result as any).attachments, 1);

  // Your work after the import: an edited note, a note of yours linking to an imported note, a link you added by hand.
  const L = b.library;
  const byTitle = (t: string) => ({ id: String(b.db.value("SELECT id FROM documents WHERE title = ?", [t])) });
  const n1 = byTitle("Note 1");
  L.update(n1.id as string, { content: "# Note 1\nMy own edits" });
  const n2 = byTitle("Note 2");
  const mine = L.create({ title: "My plan", content: "Based on [[Note 2]]" });
  const n3 = byTitle("Note 3");
  const mem = b.store.createMemory({ title: "A memory", content: "about note 3" }, { actor: "user", reason: "t" });
  L.addManualLink(n3.id as string, "memory", mem.id);
  const pre = b.importer.undoPreview(imp.id as string) as any;
  assert.deepEqual(pre.kept_edited.map((x: any) => x.title), ["Note 1"]);
  assert.deepEqual(pre.kept_linked_from_your_notes.map((x: any) => x.title), ["Note 2"]);
  assert.deepEqual(pre.kept_with_your_links.map((x: any) => x.title), ["Note 3"]);
  assert.equal(pre.will_remove, 447);
  const u = b.importer.undo(imp.id as string) as any;
  assert.equal(u.removed_notes, 447);
  assert.equal(u.kept_notes, 3);
  assert.equal(u.removed_attachments, 1);
  assert.ok(L.doc(mine.id as string), "your own note is untouched");
  assert.ok(L.doc(n1.id as string) && L.doc(n2.id as string) && L.doc(n3.id as string));
  assert.equal(b.importer.batch(imp.id as string).status, "undone");
  assert.equal(fs.readdirSync(L.attachmentDir()).filter((f) => f !== "tmp").length, 0, "the copied file was removed (nothing used it)");
  assert.deepEqual(manifest(vault), before);
  b.close();
});

test("Obsidian import: cancel keeps what was imported (undo removes it); not enough disk space is refused before starting", async () => {
  const vault = path.join(tmpDir(), "V");
  for (let i = 0; i < 300; i++) write(vault, `n${i}.md`, `note ${i}`);
  const b = openBrain();
  b.importer.registerJobs();
  b.importer.sliceMs = 0;
  const imp = b.importer.startScan(vault);
  await until(b, imp.id as string, ["scanned"]);
  const real = b.importer.diskSpace.bind(b.importer);
  b.importer.diskSpace = () => 1000;
  assert.throws(() => b.importer.start(imp.id as string, {}), /Not enough free disk space/);
  b.importer.diskSpace = real;
  b.importer.start(imp.id as string, {});
  await b.jobs.tick();
  b.importer.cancel(imp.id as string);
  for (let i = 0; i < 3; i++) await b.jobs.tick();
  assert.equal(b.importer.batch(imp.id as string).status, "cancelled");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 100);
  b.importer.undo(imp.id as string);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 0);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM folders")), 0);
  b.close();
});

test("Obsidian import: refuses unreadable or unsafe sources", () => {
  const b = openBrain();
  assert.throws(() => b.importer.startScan(path.join(tmpDir(), "nope")), /not found/);
  const f = path.join(tmpDir(), "file.md");
  fs.writeFileSync(f, "x");
  assert.throws(() => b.importer.startScan(f), /not a folder/);
  assert.throws(() => b.importer.startScan(path.dirname(b.paths.base)), /MOTH's own data folder/);
  b.close();
});

test("Cortex after import is optional: refused clearly when unavailable or paused; queued jobs keep the note as their source and can be cancelled (ISOLATED: stand-in readiness, no inference)", async () => {
  const vault = path.join(tmpDir(), "C");
  for (let i = 0; i < 5; i++) write(vault, `n${i}.md`, `# Note ${i}\n${"word ".repeat(40 + i * 10)}`);
  write(vault, "short.md", "tiny");
  const b = openBrain();
  b.importer.registerJobs();
  const imp = b.importer.startScan(vault);
  await until(b, imp.id as string, ["scanned"]);
  b.importer.start(imp.id as string, {});
  await until(b, imp.id as string, ["done"]);
  assert.equal((b.importer.batch(imp.id as string).result as any).notes, 6, "importing needed no AI");
  assert.throws(() => b.importer.analyze(imp.id as string), /Cortex isn't available/);
  (b.cortex as any).readiness = () => ({ ok: true });
  b.settings.set("automation.paused", true);
  assert.throws(() => b.importer.analyze(imp.id as string), /paused/);
  b.settings.set("automation.paused", false);
  const r: any = b.importer.analyze(imp.id as string, { limit: 3 });
  assert.equal(r.queued, 3);
  assert.equal(r.skipped_short, 1);
  const jobs = r.job_ids.map((id: number) => b.jobs.get(id)!);
  const longest = String(b.db.value("SELECT id FROM documents WHERE import_batch_id = ? ORDER BY words DESC LIMIT 1", [imp.id]));
  assert.equal((jobs[0].payload as any).source_ref, `document:${longest}`, "provenance: the memory Cortex proposes will point back at the note");
  assert.ok(b.jobs.cancel(r.job_ids[0]));
  assert.equal(b.jobs.get(r.job_ids[0])!.status, "cancelled");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents WHERE version > 1")), 0, "notes are never rewritten by analysis");
  b.close();
});

test("Updating: imports are paused before an update and resume after the restart; a backup copy is made", async () => {
  const vault = path.join(tmpDir(), "U");
  for (let i = 0; i < 250; i++) write(vault, `n${i}.md`, `note ${i}`);
  const dir = tmpDir();
  let b = openBrain(dir);
  b.importer.registerJobs();
  b.importer.sliceMs = 0;
  const imp = b.importer.startScan(vault);
  await until(b, imp.id as string, ["scanned"]);
  b.importer.start(imp.id as string, {});
  await b.jobs.tick();
  const r: any = await b.prepareForUpdate("9.9.9");
  assert.equal(r.paused_imports, 1);
  assert.ok(fs.existsSync(path.join(b.backupDir(), r.backup)));
  assert.equal(b.importer.batch(imp.id as string).status, "paused");
  b.close();
  // The new version starts: the import continues by itself.
  b = openBrain(dir);
  b.importer.sliceMs = 0;
  b.startBackground();
  b.stopBackground();
  assert.equal(b.importer.batch(imp.id as string).status, "importing");
  for (let i = 0; i < 20 && b.importer.batch(imp.id as string).status !== "done"; i++) await b.jobs.tick();
  assert.equal(b.importer.batch(imp.id as string).status, "done");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), 250);
  b.close();
});

test("Re-importing a vault after more file types are supported: only the missing files are copied, into the same folder; undo removes only them", async () => {
  const vault = path.join(tmpDir(), "Game Vault");
  makeVault(vault);
  const model = crypto.randomBytes(30000);
  write(vault, "Models/Ship/ship.glb", model);
  write(vault, "Models/Ship/ship.mtl", "newmtl hull");
  write(vault, "Models/Ship/ship.fbx", crypto.randomBytes(2000)); // not linked from any note
  write(vault, "Models/Ship.md", "# Ship\nThe model: ![[ship.glb]] and materials [[ship.mtl]]");
  const before = manifest(vault);
  const b = openBrain();
  b.importer.registerJobs();
  const L = b.library;
  // First import without the 3D files (like v0.5.0, which skipped those types).
  const first = b.importer.startScan(vault);
  await until(b, first.id as string, ["scanned"]);
  b.importer.start(first.id as string, { excludeExtensions: [".glb", ".mtl", ".fbx"] });
  const f = await until(b, first.id as string, ["done"]);
  assert.equal((f.result as any).attachments, 4);
  const ship = L.list({ q: "The model" }).items[0];
  assert.ok((L.backlinks(ship.id as string) as any).unresolved.some((u: any) => u.target_text === "ship.glb"), "missing before");
  const rootFolders = () => L.tree().filter((x) => x.parent_id === null).length;
  assert.equal(rootFolders(), 1);
  const stored = () => Number(b.db.value("SELECT COUNT(*) FROM attachments"));
  const storedBefore = stored();
  const docs = Number(b.db.value("SELECT COUNT(*) FROM documents"));
  const firstAttachmentIds = b.db.all<any>("SELECT id FROM attachments ORDER BY id").map((r) => r.id);

  // Second import of the same vault.
  const again = b.importer.startScan(vault);
  const sc = (await until(b, again.id as string, ["scanned"])).scan as any;
  assert.equal(sc.duplicates_existing, 8);
  assert.equal(sc.attachments_existing, 4, "files copied the first time are recognised");
  assert.ok(sc.disk.needed_bytes < 42000 + 5000, `only the missing files count towards the space needed (${sc.disk.needed_bytes})`);
  let copies = 0;
  const orig = (b.importer as any).copyAttachment.bind(b.importer);
  (b.importer as any).copyAttachment = (...a: unknown[]) => (copies++, orig(...a));
  b.importer.start(again.id as string, {});
  const d = await until(b, again.id as string, ["done"]);
  const r = d.result as any;
  assert.equal(copies, 3, "only the three new files were read and copied");
  assert.equal(r.attachments, 3);
  assert.equal(r.notes, 0);
  assert.equal(r.duplicates, 12);
  assert.equal(r.errors, 0);
  assert.equal(rootFolders(), 1, "same folder as the first import");
  assert.equal(stored(), storedBefore + 3);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents")), docs, "no note imported twice");
  const glb = L.attachments().items.find((a: any) => a.original_name === "ship.glb")!;
  assert.deepEqual(fs.readFileSync(L.attachmentFile(glb.id as string).file), model);
  const links = L.backlinks(ship.id as string) as any;
  assert.equal(links.outgoing.find((o: any) => o.target_text === "ship.glb")?.target_kind, "attachment", "the earlier note's embed now finds the model");
  assert.equal(links.outgoing.find((o: any) => o.target_text === "ship.mtl")?.target_kind, "attachment");

  // Undoing the second import removes only what it added, and keeps files that notes use.
  const u = b.importer.undo(again.id as string) as any;
  assert.equal(u.removed_attachments, 1, "the unlinked .fbx is removed; the model and material used by the Ship note stay");
  assert.equal(u.removed_notes, 0);
  assert.equal(stored(), storedBefore + 2);
  const left = b.db.all<any>("SELECT id FROM attachments ORDER BY id").map((x) => x.id);
  assert.ok(firstAttachmentIds.every((id: string) => left.includes(id)), "nothing from the first import was removed");
  assert.equal(rootFolders(), 1, "the first import's folder stays");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM documents WHERE status = 'active'")), docs);
  assert.deepEqual(manifest(vault), before, "source vault unchanged");
  b.close();
});

test("The Mind groups imported notes by their top folder in the vault (real folders, layout only)", async () => {
  const vault = path.join(tmpDir(), "Group Vault");
  makeVault(vault);
  const b = openBrain();
  b.importer.registerJobs();
  const imp = b.importer.startScan(vault);
  await until(b, imp.id as string, ["scanned"]);
  b.importer.start(imp.id as string, {});
  await until(b, imp.id as string, ["done"]);
  const g = b.graph({}) as any;
  const byTitle = new Map<string, any>(g.nodes.filter((n: any) => n.kind === "document").map((n: any) => [n.title, n]));
  const name = (id: string) => g.groups.find((x: any) => x.id === id)?.name;
  assert.equal(name(byTitle.get("Arena").group), "Projects");
  assert.equal(name(byTitle.get("Été ☀️").group), "Journal", "nested folders belong to their top folder in the vault");
  assert.equal(name(byTitle.get("Home").group), "Group Vault", "notes at the vault root form the vault's own group");
  assert.ok(g.groups.every((x: any) => x.kind === "project" || x.kind === "folder"));
  // Memories keep their project as group.
  const p = b.store.createProject({ name: "P" }, { actor: "user", reason: "t" } as any);
  const m = b.store.createMemory({ title: "In P", content: "x", category: "fact", project_id: p.id } as any, { actor: "user", reason: "t" } as any);
  const g2 = b.graph({}) as any;
  assert.equal(g2.nodes.find((n: any) => n.id === m.id).group, p.id);
  assert.ok(g2.groups.some((x: any) => x.id === p.id && x.kind === "project"));
  b.close();
});

test("The Mind loads a big vault quickly: note link counts are computed in one pass (was minutes for 3,000 notes)", async () => {
  const vault = path.join(tmpDir(), "Big Vault");
  const N = 1500;
  for (let i = 0; i < N; i++) {
    const links = Array.from({ length: 10 }, (_, k) => `[[Note ${(i * 7 + k * 13 + 1) % N}]]`).join(" ");
    write(vault, `F${i % 30}/Note ${i}.md`, `# Note ${i}\n${links}`);
  }
  write(vault, "INDEX.md", Array.from({ length: N }, (_, i) => `[[Note ${i}]]`).join("\n"));
  const b = openBrain();
  b.importer.registerJobs();
  const imp = b.importer.startScan(vault);
  await until(b, imp.id as string, ["scanned"], 20000);
  b.importer.start(imp.id as string, {});
  await until(b, imp.id as string, ["done"], 20000);
  const t0 = performance.now();
  const g = b.graph({}) as any;
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `graph() took ${Math.round(ms)} ms`);
  const docs = g.nodes.filter((n: any) => n.kind === "document");
  assert.equal(docs.length, N + 1);
  // Degrees are the real number of resolved links touching each note.
  const index = docs.find((n: any) => n.title === "INDEX");
  assert.equal(index.degree, N);
  const real = Number(b.db.value("SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.source_id WHERE l.status = 'resolved' AND l.target_kind = 'document' AND (l.source_id = ? OR l.target_id = ?) AND l.source_id <> l.target_id", [docs[5].id, docs[5].id]));
  assert.equal(docs[5].degree, real);
  assert.equal(docs[0].id, index.id, "most connected notes come first (they're kept when the note cap applies)");
  b.close();
});
