// Watched folders: how knowledge reaches MOTH without an MCP call.
//
// 1. Claude Inbox: any Claude (a cloud chat, Claude Code, a script, you) can drop a .md / .txt / .json file
//    into this folder. MOTH imports it, optionally lets Cortex learn from it, then moves it to Imported/
//    (files are never deleted). Duplicates are detected by content hash.
// 2. Vault sync: re-imports an Obsidian vault periodically (updates notes instead of duplicating them).
// 3. Manual import of single MD / TXT / JSON files (Settings → Data).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "./brain.ts";
import { safeJson } from "./store.ts";
import { deriveTitle, truncate } from "./text.ts";
import { CATEGORIES, MothError, type Category, type ChangeContext } from "./types.ts";

const MAX_FILE = 1_000_000;
const EXTS = [".md", ".markdown", ".txt", ".json"];

export interface ParsedEntry {
  kind: "note" | "learn" | "research" | "lesson" | "preference";
  title?: string;
  content: string;
  project?: string | null;
  category?: Category;
  tags?: string[];
  raw?: any;
}

export function parseFrontmatterMap(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

function tagsFrom(v: string | undefined): string[] {
  if (!v) return [];
  return v.replace(/^\[|\]$/g, "").split(/[,\s]+/).map((x) => x.replace(/["'#]/g, "").trim().toLowerCase()).filter(Boolean).slice(0, 12);
}

/** Turns one file into entries MOTH understands. Unknown JSON shapes are rejected rather than guessed. */
export function parseFile(name: string, raw: string): ParsedEntry[] {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, ext);
  if (ext === ".json") {
    const data = safeJson<any>(raw, undefined);
    if (data === undefined) throw new MothError("invalid_input", `${name} is not valid JSON`);
    const list = Array.isArray(data) ? data : Array.isArray(data?.memories) && data.format !== "moth-export" ? data.memories : data?.format === "moth-export" ? (data.memories ?? []).filter((m: any) => m.status === "active") : [data];
    const out: ParsedEntry[] = [];
    for (const it of list.slice(0, 2000)) {
      if (!it || typeof it !== "object") continue;
      const type = String(it.type ?? it.moth_type ?? "note").toLowerCase();
      if (type === "research" && it.topic && Array.isArray(it.findings)) out.push({ kind: "research", content: String(it.summary ?? it.topic), raw: it });
      else if (type === "lesson" && it.lesson) out.push({ kind: "lesson", content: String(it.lesson), raw: it });
      else if (type === "preference" && (it.content || it.preference)) out.push({ kind: "preference", content: String(it.content ?? it.preference), project: it.project ?? null, raw: it });
      else if (typeof it.content === "string" && it.content.trim())
        out.push({ kind: type === "learn" ? "learn" : "note", title: typeof it.title === "string" ? it.title : undefined, content: it.content, project: typeof it.project === "string" ? it.project : null, category: CATEGORIES.includes(it.category) ? it.category : undefined, tags: Array.isArray(it.tags) ? it.tags.filter((t: unknown) => typeof t === "string") : [] });
    }
    if (!out.length) throw new MothError("invalid_input", `${name}: no memories found (expected objects with a "content" field, a research/lesson/preference object, or a MOTH export)`);
    return out;
  }
  const { meta, body } = parseFrontmatterMap(raw);
  if (!body) return [];
  const h1 = body.match(/^#\s+(.+)$/m);
  const type = (meta.moth_type ?? meta.type ?? "note").toLowerCase();
  const cat = (meta.moth_category ?? meta.category ?? "").toLowerCase() as Category;
  return [{
    kind: type === "learn" ? "learn" : "note",
    title: meta.title || h1?.[1]?.trim() || base,
    content: body,
    project: meta.moth_project || meta.project || null,
    category: CATEGORIES.includes(cat) ? cat : undefined,
    tags: [...tagsFrom(meta.tags), ...(ext === ".txt" ? ["text-import"] : [])],
  }];
}

export class WatchedFolders {
  scanning = false;
  constructor(private brain: Brain) {}

  private get s() {
    return this.brain.settings;
  }

  inboxStatus(): Row {
    const folder = this.s.get("inbox.folder");
    const exists = !!folder && fs.existsSync(folder);
    let waiting = 0;
    if (exists) try { waiting = fs.readdirSync(folder).filter((f) => EXTS.includes(path.extname(f).toLowerCase())).length; } catch { /* unreadable */ }
    return {
      enabled: this.s.get("inbox.enabled"), folder, exists, waiting, learn: this.s.get("inbox.learn"), last_scan: this.s.get("inbox.lastScan"),
      recent: this.brain.db.all("SELECT * FROM inbox_files ORDER BY created_at DESC LIMIT 20").map((r) => ({ ...r, memory_ids: safeJson(r.memory_ids as string, []) })),
      vault: { enabled: this.s.get("vault.sync"), folder: this.s.get("vault.folder"), last_sync: this.s.get("vault.lastSync") },
    };
  }

  /** Creates the inbox folder with a short README so anyone opening it knows what it is for. */
  setupInbox(folder: string): Row {
    const dir = path.resolve(folder);
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, "README - MOTH Inbox.txt");
    if (!fs.existsSync(readme))
      fs.writeFileSync(readme, "MOTH Claude Inbox\r\n\r\nDrop .md, .txt or .json files here (for example a summary of a Claude chat).\r\nMOTH imports them automatically while it is running and moves them into the Imported folder.\r\nNothing in this folder is deleted.\r\n\r\nOptional Markdown front matter:\r\n---\r\nmoth_project: My Game\r\nmoth_category: decision\r\ntags: [roblox, ui]\r\n---\r\n");
    this.s.set("inbox.folder", dir);
    this.s.set("inbox.enabled", true);
    this.brain.store.logActivity({ kind: "system", source: "user", action: "inbox_configured", detail: { folder: dir } });
    return this.inboxStatus();
  }

  private moveToImported(dir: string, file: string): string {
    const month = nowIso().slice(0, 7);
    const target = path.join(dir, "Imported", month);
    fs.mkdirSync(target, { recursive: true });
    let dest = path.join(target, path.basename(file));
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(target, `${path.basename(file, path.extname(file))} (${i})${path.extname(file)}`);
    try {
      fs.renameSync(file, dest);
    } catch {
      fs.copyFileSync(file, dest); // across devices / locked: keep a copy, leave the original (never delete)
    }
    return dest;
  }

  /** Imports entries with the right engine for each kind. Returns memory ids touched. */
  ingest(entries: ParsedEntry[], origin: { source: string; ref: string; actor: ChangeContext["actor"]; learn: boolean }): { ids: string[]; queued: number[]; notes: string[] } {
    const ids: string[] = [];
    const queued: number[] = [];
    const notes: string[] = [];
    const ctx: ChangeContext = { actor: origin.actor, reason: `Imported from ${origin.ref}` };
    for (const e of entries) {
      try {
        if (e.kind === "research") {
          const r = this.brain.adaptation.submitResearch({ ...e.raw, source: origin.source });
          ids.push(...(r.stored as Row[]).map((x) => String(x.id)), String(r.hub_id));
          if ((r.needs_review as Row[]).length) notes.push(`${(r.needs_review as Row[]).length} research insight(s) need review (no sources)`);
          continue;
        }
        if (e.kind === "lesson") {
          const r = this.brain.adaptation.recordLesson({ ...e.raw, source: origin.source });
          if (r.id) ids.push(String(r.id));
          else notes.push("lesson waiting for review");
          continue;
        }
        if (e.kind === "preference") {
          const r = this.brain.adaptation.recordPreference({ content: e.content, explicit: e.raw?.explicit !== false, project: e.project, area: e.raw?.area, source: origin.source, source_ref: origin.ref }, origin.actor);
          ids.push(String(r.id));
          continue;
        }
        const content = e.content.length > 59_000 ? e.content.slice(0, 59_000) : e.content;
        const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
        const dup = this.brain.db.value<string>("SELECT id FROM memories WHERE user_id = ? AND source_ref = ? AND status <> 'merged'", [this.brain.store.userId, `sha:${hash}`]);
        if (dup) {
          notes.push(`"${truncate(e.title ?? "", 60)}" was already imported`);
          ids.push(dup);
          continue;
        }
        const m = this.brain.createMemoryWithLinks(
          {
            title: e.title ? truncate(e.title, 180) : deriveTitle(content), content, category: e.category ?? "fact", memory_type: e.category ? undefined : "episodic",
            project: e.project ?? undefined, tags: [...new Set([...(e.tags ?? []), origin.source])].slice(0, 12), source: origin.source, source_ref: `sha:${hash}`,
          },
          ctx,
        );
        this.brain.db.run("INSERT INTO memory_sources(memory_id, url, title, kind, created_at) VALUES (?, NULL, ?, 'import', ?)", [m.id, origin.ref, nowIso()]);
        ids.push(m.id);
        // Let Cortex pull individual facts out of a longer note (it compares with what MOTH already knows).
        if (origin.learn && (e.kind === "learn" || content.length > 200)) {
          const ready = this.brain.cortex.readiness();
          if (ready.ok && !this.brain.learningHeld()) queued.push(this.brain.cortex.enqueueLearn({ text: content.slice(0, 20000), project: e.project ?? undefined, source: origin.source, source_ref: origin.ref } as any, origin.source));
          else notes.push(`Cortex did not analyse it: ${ready.ok ? "learning is paused" : ready.reason}`);
        }
      } catch (err) {
        notes.push(`${truncate(e.title ?? e.content, 60)}: ${(err as Error).message}`);
      }
    }
    return { ids: [...new Set(ids)], queued, notes };
  }

  /** One pass over the Claude Inbox folder. Safe to call often; does nothing in Privacy Mode or when learning is paused. */
  scanInbox(force = false): Row {
    if (!force && !this.s.get("inbox.enabled")) return { skipped: "Claude Inbox is off" };
    if (this.brain.privacyMode()) return { skipped: "Privacy Mode is on: files stay in the inbox until you turn it off" };
    if (this.s.get("automation.paused")) return { skipped: "Learning is paused: files stay in the inbox until you resume" };
    const dir = this.s.get("inbox.folder");
    if (!dir || !fs.existsSync(dir)) return { skipped: `Inbox folder not found: ${dir || "(not set)"}` };
    if (this.scanning) return { skipped: "already scanning" };
    this.scanning = true;
    const report = { files: 0, imported: 0, duplicates: 0, failed: 0, queued: 0, details: [] as Row[] };
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && EXTS.includes(path.extname(d.name).toLowerCase()) && !d.name.startsWith("README - MOTH Inbox")).slice(0, 50);
      for (const d of files) {
        const file = path.join(dir, d.name);
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < 3000) continue; // still being written
        report.files++;
        if (st.size > MAX_FILE) {
          this.record(`size:${d.name}:${st.size}`, d.name, "skipped", [], "File is larger than 1 MB");
          report.failed++;
          continue;
        }
        const raw = fs.readFileSync(file, "utf8");
        const hash = crypto.createHash("sha256").update(raw).digest("hex");
        if (this.brain.db.value("SELECT 1 FROM inbox_files WHERE hash = ?", [hash])) {
          this.moveToImported(dir, file);
          report.duplicates++;
          continue;
        }
        try {
          const entries = parseFile(d.name, raw);
          const r = this.ingest(entries, { source: "claude-inbox", ref: d.name, actor: "claude", learn: this.s.get("inbox.learn") });
          this.record(hash, d.name, r.queued.length ? "queued" : "imported", r.ids, r.notes.join("; "));
          this.moveToImported(dir, file);
          report.imported += r.ids.length;
          report.queued += r.queued.length;
          report.details.push({ file: d.name, memories: r.ids.length, queued: r.queued.length, notes: r.notes });
        } catch (e) {
          this.record(hash, d.name, "failed", [], (e as Error).message);
          report.failed++;
          report.details.push({ file: d.name, error: (e as Error).message });
        }
      }
      this.s.set("inbox.lastScan", nowIso());
      if (report.files) {
        this.brain.store.logActivity({ kind: "inbox", source: "claude-inbox", action: "scan", detail: report });
        this.brain.store.recordEvent({ kind: "inbox_import", actor: "claude", description: `Claude Inbox: imported ${report.imported} memories from ${report.files - report.duplicates - report.failed} file(s)`, reason: `Files found in ${dir}`, undo: null });
      }
      return report;
    } finally {
      this.scanning = false;
    }
  }

  private record(hash: string, name: string, status: string, ids: string[], detail: string): void {
    this.brain.db.run("INSERT OR REPLACE INTO inbox_files(hash, name, status, memory_ids, detail, created_at) VALUES (?,?,?,?,?,?)", [hash, name, status, JSON.stringify(ids), truncate(detail, 1000), nowIso()]);
  }

  /** Manual import of individual files (MD / TXT / JSON) chosen by the user. */
  importFiles(files: string[]): Row {
    const out = { imported: 0, files: 0, notes: [] as string[], ids: [] as string[] };
    for (const f of files.slice(0, 200)) {
      const ext = path.extname(f).toLowerCase();
      if (!EXTS.includes(ext)) {
        out.notes.push(`${path.basename(f)}: only .md, .txt and .json are supported`);
        continue;
      }
      if (!fs.existsSync(f)) throw new MothError("not_found", `File not found: ${f}`);
      if (fs.statSync(f).size > 20 * MAX_FILE) throw new MothError("invalid_input", `${path.basename(f)} is larger than 20 MB`);
      const r = this.ingest(parseFile(path.basename(f), fs.readFileSync(f, "utf8")), { source: "import", ref: path.basename(f), actor: "user", learn: false });
      out.files++;
      out.imported += r.ids.length;
      out.ids.push(...r.ids);
      out.notes.push(...r.notes);
    }
    this.brain.store.recordEvent({ kind: "imported", actor: "user", description: `Imported ${out.imported} memories from ${out.files} file(s)`, reason: "Import from Settings", undo: null });
    return out;
  }

  syncVault(): Row {
    if (!this.s.get("vault.sync")) return { skipped: "vault sync is off" };
    if (this.brain.privacyMode()) return { skipped: "Privacy Mode is on" };
    const folder = this.s.get("vault.folder");
    if (!folder || !fs.existsSync(folder)) return { skipped: `Vault folder not found: ${folder || "(not set)"}` };
    const r = this.brain.importMarkdownFolder(folder, { actor: "user", reason: "Vault sync" });
    this.s.set("vault.lastSync", nowIso());
    return r;
  }
}
