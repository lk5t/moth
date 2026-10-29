// One-time Obsidian vault import into the Knowledge Library.
//
// The source vault is READ ONLY for MOTH: nothing in it is created, changed, renamed, moved or deleted, and no
// tracking files are written there. Imported notes are independent copies in MOTH's database; attachments are
// copied into MOTH's own attachments folder (stored once per content hash).
//
// Built for very large vaults (tens of GB):
// - Scanning walks the folder tree iteratively and writes a durable manifest (import_items) in batches; nothing
//   proportional to the vault's size is kept in memory. Notes are read one at a time; attachments aren't read
//   during the scan (only their sizes).
// - Importing runs as a chain of short background jobs (about a minute each): each processes pending manifest rows in
//   transactions of up to 200 notes and records every file's outcome. A crash, quit, pause or cancel loses at most
//   the current batch, and resuming continues with the rows still pending (idempotent: finished rows are skipped).
// - Attachments are streamed (copy + hash in one pass, 1 MB chunks) to a temporary file, then moved into place.
// - Disk space is checked before importing.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { newId, safeJson } from "../engine/store.ts";
import { MothError } from "../engine/types.ts";
import { sha, MAX_DOC_CHARS } from "./library.ts";
import { extractAliases, extractLinks, fileKind, mediaType, normTarget } from "./markdown.ts";

export interface ImportOptions {
  preserveFolders?: boolean;
  copyAttachments?: boolean;
  /** File extensions (".pdf") of attachments to leave out. */
  excludeExtensions?: string[];
  /** Leave out attachments larger than this (bytes). 0 = no limit. */
  maxAttachmentBytes?: number;
  /** Specific vault-relative paths to leave out (from the preview). */
  excludePaths?: string[];
  /** Notes already imported earlier (same file, same content): "skip" (default) or "separate" (import again as a separate copy). */
  duplicates?: "skip" | "separate";
  /** Name of the library folder the vault goes into (default: the vault's folder name). */
  folderName?: string;
}

const DEFAULT_EXCLUDED_DIRS = new Set([".obsidian", ".trash", ".git", ".github", "node_modules"]);
const NOTE_READ_LIMIT = 20 * 1024 * 1024; // larger "notes" are recorded as failed (they can't be edited as notes anyway)
const SLICE_MS = 60_000; // one import job works for about a minute, then hands over to the next
const DB_BATCH = 100;

const yieldNow = () => new Promise((r) => setImmediate(r));

export class VaultImporter {
  /** How long one import job works before handing over (tests shorten it to simulate interruptions). */
  sliceMs = SLICE_MS;
  constructor(private brain: Brain) {}

  private get db() {
    return this.brain.db;
  }
  private get uid() {
    return this.brain.store.userId;
  }

  batch(id: string): Row {
    const b = this.db.get<Row>("SELECT * FROM import_batches WHERE id = ? AND user_id = ?", [id, this.uid]);
    if (!b) throw new MothError("not_found", "Import not found");
    return { ...b, options: safeJson(b.options as string, {}), scan: safeJson(b.scan as string, {}), progress: safeJson(b.progress as string, {}), result: safeJson(b.result as string, {}) };
  }

  list(): Row[] {
    return this.db.all<Row>("SELECT id FROM import_batches WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [this.uid]).map((r) => this.batch(r.id as string));
  }

  private setBatch(id: string, patch: Record<string, unknown>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
    }
    sets.push("updated_at = ?");
    vals.push(nowIso());
    this.db.run(`UPDATE import_batches SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
  }

  /** Validates the chosen folder and starts a background scan. Returns the import id. */
  startScan(root: string): Row {
    if (typeof root !== "string" || !root.trim()) throw new MothError("invalid_input", "Choose a vault folder");
    const abs = path.resolve(root);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new MothError("not_found", `Folder not found: ${abs}`);
    }
    if (!st.isDirectory()) throw new MothError("invalid_input", "That's a file, not a folder");
    try {
      fs.accessSync(abs, fs.constants.R_OK);
      fs.readdirSync(abs);
    } catch {
      throw new MothError("invalid_input", "MOTH can't read this folder (permissions)");
    }
    const data = path.resolve(this.brain.paths.base);
    if (data === abs || data.startsWith(abs + path.sep)) throw new MothError("invalid_input", "This folder contains MOTH's own data folder; choose the vault folder itself");
    if (abs.startsWith(data + path.sep)) throw new MothError("invalid_input", "That folder is inside MOTH's data folder");
    const busy = this.db.value("SELECT id FROM import_batches WHERE user_id = ? AND status IN ('scanning','importing')", [this.uid]);
    if (busy) throw new MothError("conflict", "Another import is running. Wait for it, pause it or cancel it first.");
    const id = newId("imp");
    const t = nowIso();
    this.db.run("INSERT INTO import_batches(id, user_id, kind, source_root, status, created_at, updated_at) VALUES (?, ?, 'obsidian', ?, 'scanning', ?, ?)", [id, this.uid, abs, t, t]);
    const job = this.brain.jobs.enqueue("vault_scan", { batch: id }, { dedupe: `vault_scan:${id}`, priority: 2, owner: "library", title: `Scan vault ${path.basename(abs)}`, scope: "manual", timeoutMs: 3 * 3_600_000 });
    this.setBatch(id, { job_id: job });
    return this.batch(id);
  }

  /** Background scan: builds the manifest and the preview numbers. Restarting it starts the scan over. */
  async scan(batchId: string, signal: AbortSignal): Promise<Row> {
    const b = this.batch(batchId);
    if (b.status !== "scanning") return { skipped: `import is ${b.status}` };
    const root = b.source_root as string;
    const t0 = Date.now();
    // A restarted scan starts from a clean manifest.
    this.db.run("DELETE FROM import_items WHERE batch_id = ?", [batchId]);
    this.db.run("DELETE FROM import_link_targets WHERE batch_id = ?", [batchId]);
    const pending: Row[] = [];
    const pendingLinks: [string, string][] = [];
    let files = 0;
    let bytes = 0;
    let lastProgress = 0;
    let lastYield = Date.now();
    const flush = () => {
      if (!pending.length && !pendingLinks.length) return;
      this.db.tx(() => {
        for (const r of pending)
          this.db.run("INSERT OR REPLACE INTO import_items(batch_id, rel_path, kind, size, mtime_ms, sha256, links, status, detail) VALUES (?,?,?,?,?,?,?,?,?)", [batchId, r.rel, r.kind, r.size, r.mtime, r.sha ?? null, r.links ?? 0, r.status ?? "pending", r.detail ?? null]);
        for (const [rel, target] of pendingLinks) this.db.run("INSERT INTO import_link_targets(batch_id, rel_path, target) VALUES (?,?,?)", [batchId, rel, target]);
      });
      pending.length = 0;
      pendingLinks.length = 0;
    };
    const stack: string[] = [""];
    const skippedDirs: string[] = [];
    while (stack.length) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Cancelled");
      const relDir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
      } catch (e) {
        pending.push({ rel: relDir || ".", kind: "folder", size: 0, mtime: 0, status: "failed", detail: `Can't read folder: ${(e as Error).message}` });
        continue;
      }
      if (relDir) pending.push({ rel: relDir, kind: "folder", size: 0, mtime: 0, status: "done" });
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isSymbolicLink()) {
          pending.push({ rel, kind: "unsupported", size: 0, mtime: 0, status: "skipped", detail: "Shortcut / symbolic link (not followed)" });
          continue;
        }
        if (e.isDirectory()) {
          if (DEFAULT_EXCLUDED_DIRS.has(e.name)) skippedDirs.push(rel);
          else stack.push(rel);
          continue;
        }
        if (!e.isFile()) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(root, rel));
        } catch (err) {
          pending.push({ rel, kind: "unsupported", size: 0, mtime: 0, status: "failed", detail: (err as Error).message });
          continue;
        }
        files++;
        bytes += st.size;
        const kind = fileKind(e.name);
        if (kind === "note") {
          if (st.size > NOTE_READ_LIMIT) {
            pending.push({ rel, kind, size: st.size, mtime: st.mtimeMs, status: "failed", detail: "Note larger than 20 MB" });
          } else {
            let text: string;
            try {
              text = fs.readFileSync(path.join(root, rel), "utf8");
            } catch (err) {
              pending.push({ rel, kind, size: st.size, mtime: st.mtimeMs, status: "failed", detail: `Can't read: ${(err as Error).message}` });
              continue;
            }
            const links = extractLinks(text).filter((l) => !l.external && !l.unsafe && l.target);
            for (const l of links.slice(0, 2000)) pendingLinks.push([rel, normTarget(l.target)]);
            for (const a of extractAliases(text)) pendingLinks.push([rel, `#alias:${a.toLowerCase()}`]);
            pending.push({ rel, kind, size: st.size, mtime: st.mtimeMs, sha: sha(text), links: links.length });
          }
        } else {
          pending.push({ rel, kind, size: st.size, mtime: st.mtimeMs });
        }
        if (pending.length >= 500 || pendingLinks.length >= 5000) flush();
        if (Date.now() - lastProgress > 300) {
          lastProgress = Date.now();
          this.setBatch(batchId, { progress: { phase: "scanning", files_seen: files, bytes_seen: bytes } });
        }
        if (Date.now() - lastYield > 25) {
          await yieldNow();
          lastYield = Date.now();
        }
      }
    }
    flush();
    const scan = this.summarize(batchId, root, skippedDirs, Date.now() - t0);
    this.setBatch(batchId, { status: "scanned", scan, progress: { phase: "scanned", files_seen: files, bytes_seen: bytes } });
    this.brain.store.logActivity({ kind: "import", source: "user", action: "scanned", detail: { batch: batchId, notes: scan.notes, attachments: scan.attachments, bytes: scan.total_bytes, ms: scan.scan_ms } });
    return scan;
  }

  /** Earlier imports of the same vault folder that are still in MOTH (newest first). */
  private earlierImports(batchId: string, root: string): Row[] {
    return this.db.all<Row>(
      "SELECT id, root_folder_id FROM import_batches WHERE user_id = ? AND id <> ? AND source_root = ? COLLATE NOCASE AND status IN ('done','cancelled','paused','failed') ORDER BY created_at DESC LIMIT 20",
      [this.uid, batchId, root],
    );
  }

  /** Files already copied by an earlier import of the same vault: same place in the vault, same size, same
   *  modification time, and the stored copy still exists. Re-importing skips them instead of copying them again. */
  private markImportedAttachments(batchId: string, root: string, apply: boolean): number {
    let total = 0;
    for (const e of this.earlierImports(batchId, root)) {
      const match = `FROM import_items p JOIN attachments a ON a.id = p.entity_id
        WHERE p.batch_id = ? AND p.rel_path = i.rel_path AND p.kind = 'attachment' AND p.status IN ('done','duplicate')
          AND p.size = i.size AND ROUND(p.mtime_ms) = ROUND(i.mtime_ms)`;
      if (apply) {
        total += Number(this.db.run(
          `UPDATE import_items AS i SET status = 'duplicate', detail = 'Already imported earlier (same file)', entity_id = (SELECT p.entity_id ${match} LIMIT 1)
             WHERE i.batch_id = ? AND i.kind = 'attachment' AND i.status = 'pending' AND EXISTS (SELECT 1 ${match})`,
          [e.id, batchId, e.id],
        ).changes ?? 0);
      } else {
        total += Number(this.db.value(`SELECT COUNT(*) FROM import_items i WHERE i.batch_id = ? AND i.kind = 'attachment' AND i.status = 'pending' AND EXISTS (SELECT 1 ${match})`, [batchId, e.id]) ?? 0);
        if (total) break; // preview: the newest earlier import is enough for the estimate
      }
    }
    return total;
  }

  /** Preview numbers, computed from the manifest with SQL (no file list in memory). */
  private summarize(batchId: string, root: string, skippedDirs: string[], ms: number): Row {
    const n = (sql: string, p: unknown[] = [batchId]) => Number(this.db.value(sql, p) ?? 0);
    const notes = n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'note' AND status = 'pending'");
    const noteBytes = n("SELECT COALESCE(SUM(size),0) FROM import_items WHERE batch_id = ? AND kind = 'note' AND status = 'pending'");
    const atts = n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'attachment'");
    const attBytes = n("SELECT COALESCE(SUM(size),0) FROM import_items WHERE batch_id = ? AND kind = 'attachment'");
    // Files an earlier import of this vault already copied (they are reused, not copied again).
    const attExisting = this.markImportedAttachments(batchId, root, false);
    const folders = n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'folder' AND status = 'done'");
    const unsupported = this.db.all<Row>(
      `SELECT lower(CASE WHEN instr(rel_path, '.') > 0 THEN replace(rel_path, rtrim(rel_path, replace(rel_path, '.', '')), '.') ELSE '(no extension)' END) AS ext, COUNT(*) AS n, SUM(size) AS bytes
       FROM import_items WHERE batch_id = ? AND kind = 'unsupported' GROUP BY ext ORDER BY n DESC LIMIT 30`,
      [batchId],
    );
    const failed = this.db.all<Row>("SELECT rel_path, detail FROM import_items WHERE batch_id = ? AND status = 'failed' LIMIT 50", [batchId]);
    const links = n("SELECT COALESCE(SUM(links),0) FROM import_items WHERE batch_id = ? AND kind = 'note'");
    // Unresolved links: targets that match no note name, note path, alias or attachment name in this vault.
    this.db.exec("DROP TABLE IF EXISTS temp.import_names");
    this.db.exec("CREATE TEMP TABLE import_names(n TEXT PRIMARY KEY) WITHOUT ROWID");
    const ins = (sql: string) => this.db.run(sql, [batchId]);
    ins(`INSERT OR IGNORE INTO temp.import_names SELECT lower(replace(replace(CASE WHEN instr(rel_path, '/') > 0 THEN replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '') ELSE rel_path END, '.markdown', ''), '.md', '')) FROM import_items WHERE batch_id = ? AND kind = 'note'`);
    ins(`INSERT OR IGNORE INTO temp.import_names SELECT lower(replace(replace(rel_path, '.markdown', ''), '.md', '')) FROM import_items WHERE batch_id = ? AND kind = 'note'`);
    ins(`INSERT OR IGNORE INTO temp.import_names SELECT lower(CASE WHEN instr(rel_path, '/') > 0 THEN replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '') ELSE rel_path END) FROM import_items WHERE batch_id = ? AND kind = 'attachment'`);
    ins(`INSERT OR IGNORE INTO temp.import_names SELECT lower(rel_path) FROM import_items WHERE batch_id = ? AND kind = 'attachment'`);
    ins(`INSERT OR IGNORE INTO temp.import_names SELECT substr(target, 8) FROM import_link_targets WHERE batch_id = ? AND target LIKE '#alias:%'`);
    const unresolvedRows = this.db.all<Row>(
      `SELECT t.target, COUNT(*) AS n FROM import_link_targets t WHERE t.batch_id = ? AND t.target NOT LIKE '#alias:%'
         AND NOT EXISTS (SELECT 1 FROM temp.import_names x WHERE x.n IN (t.target, replace(t.target, './', ''), CASE WHEN instr(t.target, '/') > 0 THEN replace(t.target, rtrim(t.target, replace(t.target, '/', '')), '') ELSE t.target END))
       GROUP BY t.target ORDER BY n DESC`,
      [batchId],
    );
    this.db.exec("DROP TABLE IF EXISTS temp.import_names");
    const unresolved = unresolvedRows.reduce((s, r) => s + Number(r.n), 0);
    // Duplicates: notes identical to notes already in MOTH (earlier imports or your own), and identical files within the vault.
    const dupExisting = n(`SELECT COUNT(*) FROM import_items i WHERE i.batch_id = ? AND i.kind = 'note' AND i.status = 'pending' AND EXISTS (SELECT 1 FROM documents d INDEXED BY idx_docs_imported WHERE d.imported_hash = i.sha256 AND d.source_path = i.rel_path AND d.status = 'active' AND d.user_id = ?)`, [batchId, this.uid]);
    const sameTextElsewhere = n(`SELECT COUNT(*) FROM import_items i WHERE i.batch_id = ? AND i.kind = 'note' AND i.status = 'pending' AND i.size > 0 AND EXISTS (SELECT 1 FROM documents d INDEXED BY idx_docs_hash WHERE d.content_hash = i.sha256 AND COALESCE(d.source_path, '') <> i.rel_path AND d.status = 'active' AND d.user_id = ?)`, [batchId, this.uid]);
    const dupWithin = n(`SELECT COALESCE(SUM(c - 1), 0) FROM (SELECT COUNT(*) AS c FROM import_items WHERE batch_id = ? AND kind = 'note' AND status = 'pending' AND size > 0 GROUP BY sha256 HAVING c > 1)`);
    const sameTitles = this.db.all<Row>(
      `SELECT lower(replace(replace(CASE WHEN instr(rel_path, '/') > 0 THEN replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '') ELSE rel_path END, '.markdown', ''), '.md', '')) AS name, COUNT(*) AS n
       FROM import_items WHERE batch_id = ? AND kind = 'note' GROUP BY name HAVING n > 1 ORDER BY n DESC LIMIT 50`,
      [batchId],
    );
    const largest = this.db.all<Row>("SELECT rel_path, size FROM import_items WHERE batch_id = ? AND kind = 'attachment' ORDER BY size DESC LIMIT 20", [batchId]);
    const types = this.db.all<Row>(
      `SELECT lower(replace(rel_path, rtrim(rel_path, replace(rel_path, '.', '')), '.')) AS ext, kind, COUNT(*) AS n, SUM(size) AS bytes FROM import_items WHERE batch_id = ? AND kind IN ('note','attachment') GROUP BY ext, kind ORDER BY bytes DESC LIMIT 40`,
      [batchId],
    );
    const disk = this.diskSpace();
    // Destination estimate: note text roughly twice (stored + search index) plus attachments copied once each.
    const needed = Math.round(noteBytes * 2.2 + attBytes * (atts ? Math.max(0, atts - attExisting) / atts : 0));
    return {
      root, vault_name: path.basename(root), notes, note_bytes: noteBytes, folders, attachments: atts, attachment_bytes: attBytes,
      total_files: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind <> 'folder'"), total_bytes: n("SELECT COALESCE(SUM(size),0) FROM import_items WHERE batch_id = ?"),
      unsupported: unsupported.map((u) => ({ ext: u.ext, files: Number(u.n), bytes: Number(u.bytes) })), unsupported_files: unsupported.reduce((s, u) => s + Number(u.n), 0),
      failed, links, unresolved_links: unresolved, unresolved_examples: unresolvedRows.slice(0, 25).map((r) => ({ target: r.target, count: Number(r.n) })),
      duplicates_existing: dupExisting, attachments_existing: attExisting, same_text_elsewhere: sameTextElsewhere, duplicates_within: dupWithin, same_name_notes: sameTitles.map((r) => ({ name: r.name, count: Number(r.n) })),
      largest_attachments: largest, file_types: types, skipped_folders: skippedDirs.slice(0, 100),
      disk: { free_bytes: disk, needed_bytes: needed, enough: disk === null ? null : disk > needed * 1.1 + 200 * 1024 * 1024 },
      scan_ms: ms,
    };
  }

  diskSpace(): number | null {
    try {
      const s = fs.statfsSync(this.brain.paths.base);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  /** Starts (or resumes) importing a scanned vault with the chosen options. */
  start(batchId: string, opts: ImportOptions = {}): Row {
    const b = this.batch(batchId);
    if (!["scanned", "paused"].includes(String(b.status))) throw new MothError("invalid_input", `This import is ${b.status}`);
    const busy = this.db.value("SELECT id FROM import_batches WHERE user_id = ? AND status IN ('scanning','importing') AND id <> ?", [this.uid, batchId]);
    if (busy) throw new MothError("conflict", "Another import is running");
    const options: ImportOptions = b.status === "paused" ? (b.options as ImportOptions) : {
      preserveFolders: opts.preserveFolders !== false,
      copyAttachments: opts.copyAttachments !== false,
      excludeExtensions: (opts.excludeExtensions ?? []).map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()).slice(0, 50),
      maxAttachmentBytes: Math.max(0, Number(opts.maxAttachmentBytes ?? 0)),
      excludePaths: (opts.excludePaths ?? []).slice(0, 10000),
      duplicates: opts.duplicates === "separate" ? "separate" : "skip",
      folderName: opts.folderName?.trim() || undefined,
    };
    if (b.status === "scanned") {
      // Apply exclusions to the manifest now, so the counts shown during the import are the real work left.
      this.db.tx(() => {
        if (!options.copyAttachments) this.db.run("UPDATE import_items SET status = 'excluded', detail = 'Attachments not copied (your choice)' WHERE batch_id = ? AND kind = 'attachment' AND status = 'pending'", [batchId]);
        for (const ext of options.excludeExtensions ?? []) this.db.run("UPDATE import_items SET status = 'excluded', detail = 'File type left out (your choice)' WHERE batch_id = ? AND kind = 'attachment' AND status = 'pending' AND lower(rel_path) LIKE ?", [batchId, `%${ext}`]);
        if (options.maxAttachmentBytes) this.db.run("UPDATE import_items SET status = 'excluded', detail = 'Larger than your limit' WHERE batch_id = ? AND kind = 'attachment' AND status = 'pending' AND size > ?", [batchId, options.maxAttachmentBytes]);
        for (const p of options.excludePaths ?? []) this.db.run("UPDATE import_items SET status = 'excluded', detail = 'Left out (your choice)' WHERE batch_id = ? AND rel_path = ? AND status = 'pending'", [batchId, p]);
        if (options.duplicates !== "separate") this.markImportedAttachments(batchId, String(b.source_root), true);
      });
      const needed = Number(this.db.value("SELECT COALESCE(SUM(CASE kind WHEN 'note' THEN size * 2.2 ELSE size END), 0) FROM import_items WHERE batch_id = ? AND status = 'pending'", [batchId]) ?? 0);
      const free = this.diskSpace();
      if (free !== null && free < needed * 1.1 + 200 * 1024 * 1024) {
        throw new MothError("invalid_input", `Not enough free disk space: about ${fmtBytes(needed)} is needed and ${fmtBytes(free)} is free. Leave out large attachments or free up space.`);
      }
    }
    this.setBatch(batchId, { status: "importing", options, started_at: b.started_at ?? nowIso(), error: null });
    const job = this.brain.jobs.enqueue("vault_import", { batch: batchId }, { priority: 3, owner: "library", title: `Import vault ${path.basename(String(b.source_root))}`, scope: "manual", timeoutMs: 10 * 60_000, maxAttempts: 6 });
    this.setBatch(batchId, { job_id: job });
    this.brain.store.logActivity({ kind: "import", source: "user", action: b.status === "paused" ? "resumed" : "started", detail: { batch: batchId, options } });
    return this.batch(batchId);
  }

  pause(batchId: string): Row {
    const b = this.batch(batchId);
    if (b.status !== "importing") throw new MothError("invalid_input", `This import is ${b.status}`);
    this.setBatch(batchId, { status: "paused" });
    if (b.job_id) this.brain.jobs.cancel(Number(b.job_id), "Import paused");
    return this.batch(batchId);
  }

  /** Stops the import. What was imported so far stays (use Undo to remove it). */
  cancel(batchId: string): Row {
    const b = this.batch(batchId);
    if (!["scanning", "scanned", "importing", "paused"].includes(String(b.status))) throw new MothError("invalid_input", `This import is ${b.status}`);
    this.setBatch(batchId, { status: "cancelled", finished_at: nowIso() });
    if (b.job_id) this.brain.jobs.cancel(Number(b.job_id), "Import cancelled");
    this.brain.store.logActivity({ kind: "import", source: "user", action: "cancelled", detail: { batch: batchId } });
    return this.batch(batchId);
  }

  /** One slice of import work (about a minute). Schedules the next slice until everything is done. */
  async work(batchId: string, signal: AbortSignal): Promise<Row> {
    const b = this.batch(batchId);
    if (b.status !== "importing") return { skipped: `import is ${b.status}` };
    const opts = b.options as ImportOptions;
    const lib = this.brain.library;
    const root = String(b.source_root);
    const t0 = Date.now();
    const stop = () => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Cancelled");
    };
    // Each phase always makes progress (at least one batch per slice), then stops when the slice's time is up.
    let worked = false;
    const outOfTime = () => worked && Date.now() - t0 > this.sliceMs;

    // Root folder in the library (once).
    let rootFolder = (b.root_folder_id as string) ?? null;
    if (!rootFolder && !opts.folderName && opts.duplicates !== "separate") {
      // Importing the same vault again: add to the folder of the earlier import instead of making a second one.
      for (const e of this.earlierImports(batchId, root)) {
        if (e.root_folder_id && this.db.value("SELECT 1 FROM folders WHERE id = ? AND user_id = ?", [e.root_folder_id, this.uid])) {
          rootFolder = String(e.root_folder_id);
          this.setBatch(batchId, { root_folder_id: rootFolder });
          break;
        }
      }
    }
    if (!rootFolder) {
      const base = (opts.folderName ?? path.basename(root)).replace(/[\\/:*?"<>|]/g, "-").slice(0, 120) || "Vault";
      let name = base;
      for (let i = 2; this.db.value("SELECT 1 FROM folders WHERE user_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE", [this.uid, name]); i++) name = `${base} (${i})`;
      rootFolder = lib.createFolder(name, null, { batch: batchId }).id as string;
      this.setBatch(batchId, { root_folder_id: rootFolder });
    }
    const folderFor = (rel: string): string | null => {
      if (!opts.preserveFolders) return rootFolder;
      const dir = path.posix.dirname(rel);
      return dir === "." ? rootFolder : lib.ensureFolderPath(dir, rootFolder, batchId);
    };
    const progress = (phase: string, extra: Row = {}) => {
      const n = (sql: string) => Number(this.db.value(sql, [batchId]) ?? 0);
      this.setBatch(batchId, {
        progress: {
          phase,
          notes_total: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'note' AND status <> 'excluded'"),
          notes_done: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'note' AND status IN ('done','duplicate','failed','skipped')"),
          attachments_total: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'attachment' AND status <> 'excluded'"),
          attachments_done: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'attachment' AND status IN ('done','duplicate','failed','skipped')"),
          bytes_total: n("SELECT COALESCE(SUM(size),0) FROM import_items WHERE batch_id = ? AND kind IN ('note','attachment') AND status <> 'excluded'"),
          bytes_done: n("SELECT COALESCE(SUM(size),0) FROM import_items WHERE batch_id = ? AND kind IN ('note','attachment') AND status IN ('done','duplicate','failed','skipped')") + Number(extra.partial_bytes ?? 0),
          warnings: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND status = 'failed'"),
          current: extra.current ?? null,
          at: nowIso(),
        },
      });
    };

    // ---- notes
    while (!outOfTime()) {
      stop();
      const rows = this.db.all<Row>("SELECT * FROM import_items WHERE batch_id = ? AND kind = 'note' AND status = 'pending' ORDER BY rel_path LIMIT ?", [batchId, DB_BATCH]);
      if (!rows.length) break;
      worked = true;
      const prepared: { row: Row; text?: string; error?: string }[] = [];
      for (const r of rows) {
        try {
          const text = fs.readFileSync(path.join(root, String(r.rel_path)), "utf8");
          prepared.push({ row: r, text: text.length > MAX_DOC_CHARS ? undefined : text, error: text.length > MAX_DOC_CHARS ? "Note too large (over 5 million characters)" : undefined });
        } catch (e) {
          prepared.push({ row: r, error: `Can't read: ${(e as Error).message}` });
        }
      }
      this.db.tx(() => {
        for (const p of prepared) {
          const rel = String(p.row.rel_path);
          if (p.error || p.text === undefined) {
            this.db.run("UPDATE import_items SET status = 'failed', detail = ? WHERE batch_id = ? AND rel_path = ?", [p.error ?? "Unreadable", batchId, rel]);
            continue;
          }
          const hash = sha(p.text);
          if (opts.duplicates !== "separate") {
            // A confirmed duplicate is the same file (same place in the vault, same content) from an earlier import.
            // Identical text elsewhere (e.g. two empty notes) is NOT treated as a duplicate: those are separate notes.
            const dup = this.db.get<Row>("SELECT id FROM documents INDEXED BY idx_docs_imported WHERE imported_hash = ? AND source_path = ? AND status = 'active' AND user_id = ? LIMIT 1", [hash, rel, this.uid]);
            if (dup) {
              this.db.run("UPDATE import_items SET status = 'duplicate', entity_id = ?, detail = 'Already imported earlier (same file, same content)' WHERE batch_id = ? AND rel_path = ?", [dup.id, batchId, rel]);
              continue;
            }
          }
          const title = path.posix.basename(rel).replace(/\.(md|markdown)$/i, "");
          const st = (() => {
            try {
              return fs.statSync(path.join(root, rel));
            } catch {
              return null;
            }
          })();
          const d = lib.create({
            title, content: p.text, folder_id: folderFor(rel), source: "obsidian", source_path: rel, batch: batchId, skipLinks: true,
            created_at: st ? new Date(st.birthtimeMs || st.mtimeMs).toISOString() : undefined, updated_at: st ? new Date(st.mtimeMs).toISOString() : undefined,
          });
          const changed = st && (st.size !== Number(p.row.size) || Math.round(st.mtimeMs) !== Math.round(Number(p.row.mtime_ms)));
          this.db.run("UPDATE import_items SET status = 'done', entity_id = ?, sha256 = ?, detail = ? WHERE batch_id = ? AND rel_path = ?", [d.id, hash, changed ? "The file changed after the scan; the current version was imported" : null, batchId, rel]);
        }
      });
      this.db.run("INSERT INTO db_changes(entity, entity_id, op) VALUES ('document', ?, 'insert')", [batchId]);
      progress("notes", { current: String(rows[rows.length - 1].rel_path) });
      await yieldNow();
    }

    // ---- attachments (streamed)
    if (!outOfTime() && !this.db.value("SELECT 1 FROM import_items WHERE batch_id = ? AND kind = 'note' AND status = 'pending'", [batchId])) {
      const dir = lib.attachmentDir();
      fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
      while (!outOfTime()) {
        stop();
        const r = this.db.get<Row>("SELECT * FROM import_items WHERE batch_id = ? AND kind = 'attachment' AND status = 'pending' ORDER BY rel_path LIMIT 1", [batchId]);
        if (!r) break;
        worked = true;
        const rel = String(r.rel_path);
        try {
          const id = await this.copyAttachment(path.join(root, rel), path.posix.basename(rel), batchId, signal, (partial) => {
            if (partial % (64 * 1024 * 1024) < 1024 * 1024) progress("attachments", { current: rel, partial_bytes: partial });
          });
          this.db.run("UPDATE import_items SET status = 'done', entity_id = ? WHERE batch_id = ? AND rel_path = ?", [id, batchId, rel]);
        } catch (e) {
          if (signal.aborted) throw e;
          this.db.run("UPDATE import_items SET status = 'failed', detail = ? WHERE batch_id = ? AND rel_path = ?", [`Copy failed: ${(e as Error).message}`, batchId, rel]);
        }
        progress("attachments", { current: rel });
      }
    }

    const pendingFiles = Number(this.db.value("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind IN ('note','attachment') AND status = 'pending'", [batchId]) ?? 0);
    // ---- links (after every note and file exists, so resolution sees the whole vault)
    if (!pendingFiles && !outOfTime()) {
      const pr = safeJson<Row>(String(this.db.value("SELECT progress FROM import_batches WHERE id = ?", [batchId]) ?? "{}"), {});
      let after = String(pr.links_after ?? "");
      while (!outOfTime()) {
        stop();
        const docs = this.db.all<Row>("SELECT id FROM documents WHERE import_batch_id = ? AND id > ? ORDER BY id LIMIT ?", [batchId, after, DB_BATCH]);
        if (!docs.length) {
          after = "~done";
          break;
        }
        worked = true;
        this.db.tx(() => {
          for (const d of docs) lib.indexLinks(d.id as string);
        });
        after = String(docs[docs.length - 1].id);
        const cur = safeJson<Row>(String(this.db.value("SELECT progress FROM import_batches WHERE id = ?", [batchId]) ?? "{}"), {});
        this.setBatch(batchId, { progress: { ...cur, phase: "links", links_after: after } });
        await yieldNow();
      }
      if (after === "~done") {
        // Links in notes you already had (including notes from an earlier import of this vault) may now find the
        // imported notes or files: those notes are indexed again (same resolution rules as during the import).
        const others = this.db.all<Row>(
          `SELECT DISTINCT l.source_id AS id FROM document_links l JOIN documents s ON s.id = l.source_id WHERE s.user_id = ? AND (s.import_batch_id IS NULL OR s.import_batch_id <> ?) AND l.created_by = 'parser' AND l.status IN ('unresolved','ambiguous') LIMIT 20000`,
          [this.uid, batchId],
        );
        for (let i = 0; i < others.length; i += DB_BATCH) {
          this.db.tx(() => {
            for (const o of others.slice(i, i + DB_BATCH)) lib.indexLinks(String(o.id));
          });
          await yieldNow();
        }
        const result = this.result(batchId, Date.now());
        this.setBatch(batchId, { status: "done", finished_at: nowIso(), result, progress: { phase: "done", at: nowIso() } });
        this.db.run("INSERT INTO db_changes(entity, entity_id, op) VALUES ('document', ?, 'update')", [batchId]);
        this.brain.store.logActivity({ kind: "import", source: "user", action: "done", detail: { batch: batchId, ...result } });
        this.brain.store.recordEvent({ kind: "imported", actor: "user", description: `Imported ${result.notes} notes and ${result.attachments} files from the vault "${path.basename(root)}"`, reason: "Obsidian import (one-time copy; the vault itself was not changed)", undo: null });
        return result;
      }
    }
    // More to do: hand over to the next slice (other background work can run in between).
    if (this.batch(batchId).status === "importing") {
      const job = this.brain.jobs.enqueue("vault_import", { batch: batchId }, { priority: 3, owner: "library", title: `Import vault ${path.basename(root)} (continued)`, scope: "manual", timeoutMs: 10 * 60_000, maxAttempts: 6 });
      this.setBatch(batchId, { job_id: job });
    }
    return { continued: true, pending_files: pendingFiles };
  }

  private async copyAttachment(src: string, name: string, batchId: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<string> {
    const dir = this.brain.library.attachmentDir();
    const tmp = path.join(dir, "tmp", `${batchId}-${crypto.randomBytes(6).toString("hex")}`);
    const hash = crypto.createHash("sha256");
    let n = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        n += chunk.length;
        onBytes(n);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(fs.createReadStream(src, { highWaterMark: 1024 * 1024 }), meter, fs.createWriteStream(tmp), { signal });
      const digest = hash.digest("hex");
      // Stored once per content: the same file under another name gets its own entry pointing at the same stored file.
      const same = this.db.get<Row>("SELECT id FROM attachments WHERE user_id = ? AND sha256 = ? AND original_name = ? COLLATE NOCASE", [this.brain.store.userId, digest, name]);
      if (same) {
        fs.rmSync(tmp, { force: true });
        return same.id as string;
      }
      const stored = this.db.get<Row>("SELECT storage_path FROM attachments WHERE user_id = ? AND sha256 = ? LIMIT 1", [this.brain.store.userId, digest]);
      if (stored && fs.existsSync(path.join(dir, String(stored.storage_path)))) {
        fs.rmSync(tmp, { force: true });
        const id = newId("att");
        this.db.run("INSERT INTO attachments(id, user_id, original_name, storage_path, sha256, size, media_type, import_batch_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, this.brain.store.userId, name, stored.storage_path, digest, n, mediaType(name), batchId, nowIso()]);
        return id;
      }
      const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
      const rel = `${digest.slice(0, 2)}/${digest}${ext}`;
      const final = path.join(dir, rel);
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.renameSync(tmp, final);
      const id = newId("att");
      this.db.run("INSERT INTO attachments(id, user_id, original_name, storage_path, sha256, size, media_type, import_batch_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, this.brain.store.userId, name, rel, digest, n, mediaType(name), batchId, nowIso()]);
      return id;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Final numbers, from the manifest and the database. */
  result(batchId: string, at: number): Row {
    const n = (sql: string, p: unknown[] = [batchId]) => Number(this.db.value(sql, p) ?? 0);
    const b = this.db.get<Row>("SELECT started_at FROM import_batches WHERE id = ?", [batchId]);
    return {
      notes: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'note' AND status = 'done'"),
      folders: n("SELECT COUNT(*) FROM folders WHERE import_batch_id = ?"),
      attachments: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND kind = 'attachment' AND status = 'done'"),
      links_resolved: n("SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.source_id WHERE d.import_batch_id = ? AND l.status = 'resolved'"),
      links_unresolved: n("SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.source_id WHERE d.import_batch_id = ? AND l.status = 'unresolved'"),
      links_ambiguous: n("SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.source_id WHERE d.import_batch_id = ? AND l.status = 'ambiguous'"),
      skipped: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND status IN ('skipped','excluded')"),
      duplicates: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND status = 'duplicate'"),
      errors: n("SELECT COUNT(*) FROM import_items WHERE batch_id = ? AND status = 'failed'"),
      duration_ms: b?.started_at ? at - Date.parse(String(b.started_at)) : null,
    };
  }

  /** Files of an import with a given outcome (for the completion screen). */
  items(batchId: string, f: { status?: string; kind?: string; offset?: number; limit?: number } = {}): Row {
    this.batch(batchId);
    const where = ["batch_id = ?"];
    const p: unknown[] = [batchId];
    if (f.status) (where.push("status = ?"), p.push(f.status));
    if (f.kind) (where.push("kind = ?"), p.push(f.kind));
    const total = Number(this.db.value(`SELECT COUNT(*) FROM import_items WHERE ${where.join(" AND ")}`, p) ?? 0);
    const items = this.db.all<Row>(`SELECT rel_path, kind, size, status, entity_id, detail FROM import_items WHERE ${where.join(" AND ")} ORDER BY rel_path LIMIT ${Math.min(500, f.limit ?? 100)} OFFSET ${Math.max(0, f.offset ?? 0)}`, p);
    return { items, total };
  }

  /**
   * What undo would do. Notes you edited after the import, and notes connected to your own later work (links you
   * added by hand, notes outside this import that link to them) are kept.
   */
  undoPreview(batchId: string): Row {
    const b = this.batch(batchId);
    if (["scanning", "importing"].includes(String(b.status))) throw new MothError("invalid_input", "Pause or cancel the import first");
    const docs = Number(this.db.value("SELECT COUNT(*) FROM documents WHERE import_batch_id = ?", [batchId]) ?? 0);
    const edited = this.db.all<Row>("SELECT id, title FROM documents WHERE import_batch_id = ? AND (version > 1 OR imported_hash IS NULL OR content_hash <> imported_hash) LIMIT 500", [batchId]);
    const linkedFromOutside = this.db.all<Row>(
      `SELECT DISTINCT t.id, t.title FROM document_links l JOIN documents s ON s.id = l.source_id JOIN documents t ON t.id = l.target_id
       WHERE l.target_kind = 'document' AND t.import_batch_id = ? AND (s.import_batch_id IS NULL OR s.import_batch_id <> ?) LIMIT 500`,
      [batchId, batchId],
    );
    const manual = this.db.all<Row>(
      `SELECT DISTINCT d.id, d.title FROM document_links l JOIN documents d ON (d.id = l.source_id OR d.id = l.target_id) WHERE l.created_by = 'user' AND d.import_batch_id = ? LIMIT 500`,
      [batchId],
    );
    const keep = new Map<string, Row>();
    for (const r of [...edited, ...linkedFromOutside, ...manual]) keep.set(r.id as string, r);
    return {
      batch: batchId, imported_notes: docs, will_remove: docs - keep.size,
      kept_edited: edited, kept_linked_from_your_notes: linkedFromOutside, kept_with_your_links: manual,
      attachments: Number(this.db.value("SELECT COUNT(*) FROM attachments WHERE import_batch_id = ?", [batchId]) ?? 0),
      note: "Kept notes stay in the library. Attachments are removed only when no remaining note uses them. The vault itself is not touched.",
    };
  }

  /** Removes what an import added, except the notes listed as kept in the preview. */
  undo(batchId: string): Row {
    const pre = this.undoPreview(batchId);
    const keep = new Set([...(pre.kept_edited as Row[]), ...(pre.kept_linked_from_your_notes as Row[]), ...(pre.kept_with_your_links as Row[])].map((r) => r.id as string));
    let removed = 0;
    let attRemoved = 0;
    const lib = this.brain.library;
    for (;;) {
      const docs = this.db.all<Row>("SELECT id FROM documents WHERE import_batch_id = ? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 500", [batchId, JSON.stringify([...keep])]);
      if (!docs.length) break;
      this.db.tx(() => {
        for (const d of docs) {
          const atts = this.db.all<Row>("SELECT attachment_id FROM attachment_refs WHERE document_id = ?", [d.id]).map((r) => r.attachment_id as string);
          this.db.run("UPDATE document_links SET target_id = NULL, target_kind = NULL, status = 'unresolved' WHERE target_kind = 'document' AND target_id = ?", [d.id]);
          this.db.run("DELETE FROM documents WHERE id = ?", [d.id]);
          removed++;
          for (const a of atts) attRemoved += lib.removeAttachmentIfUnused(a) ? 1 : 0;
        }
      });
    }
    // Attachments from this import that no note uses.
    for (const a of this.db.all<Row>("SELECT id FROM attachments WHERE import_batch_id = ?", [batchId])) attRemoved += lib.removeAttachmentIfUnused(a.id as string) ? 1 : 0;
    // Empty folders created by this import (deepest first).
    let foldersRemoved = 0;
    for (let pass = 0; pass < 64; pass++) {
      const empty = this.db.all<Row>("SELECT id FROM folders f WHERE import_batch_id = ? AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = f.id) AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id)", [batchId]);
      if (!empty.length) break;
      for (const f of empty) this.db.run("DELETE FROM folders WHERE id = ?", [f.id]);
      foldersRemoved += empty.length;
    }
    const result = { removed_notes: removed, kept_notes: keep.size, removed_attachments: attRemoved, removed_folders: foldersRemoved };
    this.setBatch(batchId, { status: "undone", result: { ...(this.batch(batchId).result as Row), undo: result } });
    this.db.run("INSERT INTO db_changes(entity, entity_id, op) VALUES ('document', ?, 'delete')", [batchId]);
    this.brain.store.logActivity({ kind: "import", source: "user", action: "undone", detail: { batch: batchId, ...result } });
    return result;
  }

  /**
   * Optional, after an import: lets Cortex (the local AI) read up to `limit` imported notes and propose memories
   * from them, through the normal learning pipeline (your review settings apply; each memory keeps the note as its
   * source). Never required for importing; never rewrites the notes. Each note is its own cancellable job.
   */
  analyze(batchId: string, opts: { limit?: number } = {}): Row {
    this.batch(batchId);
    const ready = this.brain.cortex.readiness();
    if (!ready.ok) throw new MothError("unavailable", `Cortex isn't available: ${ready.reason}. Importing works without it.`);
    if (this.brain.learningHeld()) throw new MothError("paused", "Learning is paused or Privacy Mode is on, so Cortex won't analyse notes now.");
    const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 25)));
    const docs = this.db.all<Row>("SELECT id, title, content FROM documents WHERE import_batch_id = ? AND status = 'active' AND words >= 30 ORDER BY words DESC LIMIT ?", [batchId, limit]);
    const jobs: number[] = [];
    for (const d of docs) {
      const text = String(d.content).replace(/^---[\s\S]*?\n---\s*/, "").slice(0, 20000);
      jobs.push(this.brain.cortex.enqueueLearn({ text: `${d.title}\n\n${text}`, source: "library", source_ref: `document:${d.id}` } as any, "user"));
    }
    this.brain.store.logActivity({ kind: "import", source: "user", action: "analyze", detail: { batch: batchId, notes: docs.length } });
    return { queued: jobs.length, job_ids: jobs, skipped_short: Number(this.db.value("SELECT COUNT(*) FROM documents WHERE import_batch_id = ? AND status = 'active' AND words < 30", [batchId]) ?? 0) };
  }

  registerJobs(): void {
    this.brain.jobs.register("vault_scan", async (job, signal) => {
      try {
        return await this.scan(String(job.payload.batch), signal);
      } catch (e) {
        const b = this.db.get<Row>("SELECT status FROM import_batches WHERE id = ?", [job.payload.batch]);
        if (b?.status === "scanning" && !signal.aborted) this.setBatch(String(job.payload.batch), { status: "failed", error: (e as Error).message });
        throw e;
      }
    }, { owner: "library", resumable: true });
    this.brain.jobs.register("vault_import", async (job, signal) => {
      try {
        return await this.work(String(job.payload.batch), signal);
      } catch (e) {
        if (!signal.aborted && Number(job.attempts) >= Number(job.max_attempts)) this.setBatch(String(job.payload.batch), { status: "failed", error: (e as Error).message });
        throw e;
      }
    }, { owner: "library", resumable: true });
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
