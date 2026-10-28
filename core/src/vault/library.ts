// Knowledge Library: documents (notes), folders, tags, collections, revisions, attachments and links.
//
// Documents are not memories: they are the user's own writing (or copies of imported notes). Both live in the
// same database and can be linked, searched together and shown together in The Mind.
//
// Safety rules implemented here:
// - Saves carry the version they were based on; a save based on an older version is refused (no stale overwrite).
// - Earlier states are kept as revisions (at most one automatic revision per 10 minutes of editing, plus one before
//   every rename, move, restore or link rewrite). Restoring keeps the current state as a revision first.
// - Deleting is two-step: archive first; permanent deletion only from the archive.
// - Folders are deleted only when empty. Moves that would put a folder inside itself are refused.
// - Links are resolved deterministically (see `resolveTarget`); ambiguous and unresolved links are recorded, never guessed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { newId, safeJson } from "../engine/store.ts";
import { rawWords } from "../engine/search.ts";
import { truncate } from "../engine/text.ts";
import { MothError } from "../engine/types.ts";
import { deriveDocTitle, extractAliases, extractLinks, extractTags, normTarget, rewriteLinkTargets, validName, wordCount, type ParsedLink } from "./markdown.ts";

export const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const REVISION_INTERVAL_MS = 10 * 60_000;
export const MAX_DOC_CHARS = 5_000_000;

export type DocSort = "updated" | "title" | "created";

export interface DocListFilter {
  folder_id?: string | null;
  /** Include notes in sub-folders of folder_id. */
  recursive?: boolean;
  tag?: string;
  q?: string;
  source?: "note" | "obsidian";
  batch?: string;
  collection?: string;
  status?: "active" | "archived";
  sort?: DocSort;
  offset?: number;
  limit?: number;
}

function validTitle(t: string): string {
  const n = String(t ?? "").replace(/\s+/g, " ").trim();
  if (!n) throw new MothError("invalid_input", "A note needs a title");
  if (n.length > 180) throw new MothError("invalid_input", "Titles can be 180 characters at most");
  if (/[\[\]|#^\\/]|[\u0000-\u001f]/.test(n)) throw new MothError("invalid_input", 'Titles can\'t contain [ ] | # ^ / or \\ (they would break links to the note)');
  return n;
}

export class Library {
  constructor(private brain: Brain) {}

  private get db() {
    return this.brain.db;
  }
  private get uid() {
    return this.brain.store.userId;
  }

  /** One change-feed row (the live UI refreshes from these). */
  changed(entity: "document" | "folder" | "collection" | "attachment", id: string, op: "insert" | "update" | "delete"): void {
    this.db.run("INSERT INTO db_changes(entity, entity_id, op) VALUES (?, ?, ?)", [entity, id, op]);
  }

  // ------------------------------------------------------------------ folders
  folder(id: string): Row {
    const f = this.db.get<Row>("SELECT * FROM folders WHERE id = ? AND user_id = ?", [id, this.uid]);
    if (!f) throw new MothError("not_found", "Folder not found");
    return f;
  }

  folderPath(id: string | null | undefined): string {
    const parts: string[] = [];
    let cur = id ?? null;
    for (let i = 0; cur && i < 64; i++) {
      const f = this.db.get<Row>("SELECT name, parent_id FROM folders WHERE id = ?", [cur]);
      if (!f) break;
      parts.unshift(String(f.name));
      cur = (f.parent_id as string) ?? null;
    }
    return parts.join("/");
  }

  createFolder(name: string, parentId: string | null = null, opts: { batch?: string | null } = {}): Row {
    const n = this.safeName(name, "Folder name");
    if (parentId) this.folder(parentId);
    const clash = this.db.get<Row>("SELECT * FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ? COLLATE NOCASE", [this.uid, parentId ?? "", n]);
    if (clash) throw new MothError("conflict", `A folder called "${n}" already exists here`);
    const t = nowIso();
    const id = newId("fld");
    this.db.run("INSERT INTO folders(id, user_id, parent_id, name, import_batch_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [id, this.uid, parentId, n, opts.batch ?? null, t, t]);
    this.changed("folder", id, "insert");
    return this.folder(id);
  }

  /** Finds or creates a nested folder path ("A/B/C") under `parentId`. Used by the importer. */
  ensureFolderPath(rel: string, parentId: string | null, batch: string | null): string | null {
    let cur = parentId;
    for (const part of rel.split("/").filter(Boolean)) {
      const name = this.safeName(part, "Folder name");
      const hit = this.db.value<string>("SELECT id FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ? COLLATE NOCASE", [this.uid, cur ?? "", name]);
      cur = hit ?? this.createFolder(name, cur, { batch }).id as string;
    }
    return cur;
  }

  renameFolder(id: string, name: string): Row {
    const f = this.folder(id);
    const n = this.safeName(name, "Folder name");
    const clash = this.db.value("SELECT 1 FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ? COLLATE NOCASE AND id <> ?", [this.uid, f.parent_id ?? "", n, id]);
    if (clash) throw new MothError("conflict", `A folder called "${n}" already exists here`);
    this.db.run("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?", [n, nowIso(), id]);
    this.changed("folder", id, "update");
    return this.folder(id);
  }

  moveFolder(id: string, parentId: string | null): Row {
    const f = this.folder(id);
    if (parentId) {
      this.folder(parentId);
      for (let cur: string | null = parentId, i = 0; cur && i < 256; i++) {
        if (cur === id) throw new MothError("invalid_input", "A folder can't be moved into itself or one of its sub-folders");
        cur = (this.db.value<string>("SELECT parent_id FROM folders WHERE id = ?", [cur]) as string) ?? null;
      }
    }
    const clash = this.db.value("SELECT 1 FROM folders WHERE user_id = ? AND COALESCE(parent_id, '') = ? AND name = ? COLLATE NOCASE AND id <> ?", [this.uid, parentId ?? "", f.name, id]);
    if (clash) throw new MothError("conflict", `The destination already has a folder called "${f.name}"`);
    this.db.run("UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?", [parentId, nowIso(), id]);
    this.changed("folder", id, "update");
    return this.folder(id);
  }

  /** Only empty folders can be deleted (archived notes count: restore or delete them first). */
  deleteFolder(id: string): { ok: true } {
    this.folder(id);
    const subs = Number(this.db.value("SELECT COUNT(*) FROM folders WHERE parent_id = ?", [id]) ?? 0);
    const docs = Number(this.db.value("SELECT COUNT(*) FROM documents WHERE folder_id = ?", [id]) ?? 0);
    if (subs || docs) throw new MothError("invalid_input", `This folder isn't empty (${subs} folder${subs === 1 ? "" : "s"}, ${docs} note${docs === 1 ? "" : "s"} including archived). Move or delete them first.`);
    this.db.run("DELETE FROM folders WHERE id = ?", [id]);
    this.changed("folder", id, "delete");
    return { ok: true };
  }

  /** The whole folder tree with note counts (active notes only). */
  tree(): Row[] {
    const folders = this.db.all<Row>("SELECT id, parent_id, name, import_batch_id FROM folders WHERE user_id = ? ORDER BY name COLLATE NOCASE", [this.uid]);
    const counts = new Map(this.db.all<Row>("SELECT folder_id, COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'active' GROUP BY folder_id", [this.uid]).map((r) => [r.folder_id as string, Number(r.n)]));
    return folders.map((f) => ({ ...f, notes: counts.get(f.id as string) ?? 0 }));
  }

  private safeName(name: string, what: string): string {
    try {
      return validName(name, what);
    } catch (e) {
      throw new MothError("invalid_input", (e as Error).message);
    }
  }

  // ------------------------------------------------------------------ documents
  doc(id: string): Row {
    const d = this.db.get<Row>("SELECT * FROM documents WHERE id = ? AND user_id = ?", [id, this.uid]);
    if (!d) throw new MothError("not_found", "Note not found (it may have been deleted)");
    return { ...d, tags: safeJson<string[]>(d.tags as string, []), aliases: safeJson<string[]>(d.aliases as string, []), frontmatter: safeJson(d.frontmatter as string, {}) };
  }

  get(id: string): Row {
    const d = this.doc(id);
    const folder_path = this.folderPath(d.folder_id as string);
    const backlinks = Number(this.db.value("SELECT COUNT(*) FROM document_links l JOIN documents s ON s.id = l.source_id WHERE l.target_kind = 'document' AND l.target_id = ? AND l.status = 'resolved' AND s.status = 'active' AND l.source_id <> ?", [id, id]) ?? 0);
    const revisions = Number(this.db.value("SELECT COUNT(*) FROM document_revisions WHERE document_id = ?", [id]) ?? 0);
    const batch = d.import_batch_id ? this.db.get<Row>("SELECT id, source_root, created_at FROM import_batches WHERE id = ?", [d.import_batch_id]) : null;
    return { ...d, folder_path, path: folder_path ? `${folder_path}/${d.title}` : d.title, backlinks, revisions, import: batch ?? null };
  }

  private uniqueTitle(title: string, folderId: string | null, exceptId?: string): string {
    let t = title;
    for (let i = 2; i < 1000; i++) {
      const clash = this.db.value("SELECT 1 FROM documents WHERE user_id = ? AND COALESCE(folder_id, '') = ? AND title = ? COLLATE NOCASE AND status = 'active' AND id <> ?", [this.uid, folderId ?? "", t, exceptId ?? ""]);
      if (!clash) return t;
      t = `${title} ${i}`;
    }
    return `${title} ${Date.now()}`;
  }

  create(input: { title?: string; content?: string; folder_id?: string | null; project_id?: string | null; source?: "note" | "obsidian"; source_path?: string | null; batch?: string | null; created_at?: string; updated_at?: string; by?: string; skipLinks?: boolean }): Row {
    const content = String(input.content ?? "");
    if (content.length > MAX_DOC_CHARS) throw new MothError("invalid_input", `This note is too large (${Math.round(content.length / 1e6)} million characters; the limit is 5 million)`);
    if (input.folder_id) this.folder(input.folder_id);
    const imported = input.source === "obsidian";
    const base = imported ? String(input.title ?? "Untitled").trim().slice(0, 180) || "Untitled" : validTitle(input.title?.trim() ? input.title : deriveDocTitle(content, "Untitled"));
    const title = imported ? base : this.uniqueTitle(base, input.folder_id ?? null);
    const t = nowIso();
    const id = newId("doc");
    const hash = sha(content);
    const tags = extractTags(content);
    const aliases = extractAliases(content);
    this.db.run(
      `INSERT INTO documents(id, user_id, folder_id, title, content, source, source_path, import_batch_id, content_hash, imported_hash, frontmatter, aliases, tags, project_id, status, version, words, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'{}',?,?,?,'active',1,?,?,?)`,
      [id, this.uid, input.folder_id ?? null, title, content, input.source ?? "note", input.source_path ?? null, input.batch ?? null, hash, imported ? hash : null, JSON.stringify(aliases), JSON.stringify(tags), input.project_id ?? null, wordCount(content), input.created_at ?? t, input.updated_at ?? t],
    );
    this.writeTagsAliases(id, tags, aliases);
    if (!input.skipLinks) {
      this.indexLinks(id);
      this.reresolveFor([title, ...aliases], id);
    }
    if (!input.batch) this.changed("document", id, "insert");
    return this.doc(id);
  }

  private writeTagsAliases(id: string, tags: string[], aliases: string[]): void {
    this.db.run("DELETE FROM document_tags WHERE document_id = ?", [id]);
    for (const tg of tags) this.db.run("INSERT OR IGNORE INTO document_tags(document_id, tag) VALUES (?, ?)", [id, tg]);
    this.db.run("DELETE FROM document_aliases WHERE document_id = ?", [id]);
    for (const a of aliases) this.db.run("INSERT OR IGNORE INTO document_aliases(document_id, alias) VALUES (?, ?)", [id, a]);
  }

  private snapshot(d: Row, reason: string, by: string): void {
    this.db.run("INSERT INTO document_revisions(document_id, version, title, content, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?)", [d.id, d.version, d.title, d.content, reason, by, nowIso()]);
  }

  /**
   * Saves new content and/or title. `base_version` is the version the editor started from; if the note changed
   * since, the save is refused with code "conflict" (the editor keeps its draft and shows both).
   */
  update(id: string, patch: { content?: string; title?: string }, opts: { base_version?: number; by?: string; reason?: string; forceRevision?: boolean } = {}): Row {
    const d = this.doc(id);
    if (d.status !== "active") throw new MothError("invalid_input", "This note is archived: restore it before editing");
    if (opts.base_version !== undefined && Number(opts.base_version) !== Number(d.version)) {
      throw new MothError("conflict", `This note changed since you opened it (now version ${d.version}, you edited version ${opts.base_version}). Your text is kept as a draft.`);
    }
    const content = patch.content !== undefined ? String(patch.content) : (d.content as string);
    if (content.length > MAX_DOC_CHARS) throw new MothError("invalid_input", "This note is too large (5 million characters at most)");
    let title = d.title as string;
    if (patch.title !== undefined && patch.title.trim() !== d.title) {
      title = validTitle(patch.title);
      const clash = this.db.value("SELECT 1 FROM documents WHERE user_id = ? AND COALESCE(folder_id, '') = ? AND title = ? COLLATE NOCASE AND status = 'active' AND id <> ?", [this.uid, d.folder_id ?? "", title, id]);
      if (clash) throw new MothError("conflict", `Another note in this folder is already called "${title}"`);
    }
    if (content === d.content && title === d.title) return this.get(id);
    const by = opts.by ?? "user";
    this.db.tx(() => {
      const lastRev = this.db.value<string>("SELECT MAX(created_at) FROM document_revisions WHERE document_id = ?", [id]);
      const due = opts.forceRevision || title !== d.title || !lastRev || Date.now() - Date.parse(lastRev) > REVISION_INTERVAL_MS;
      if (due) this.snapshot(d, opts.reason ?? (title !== d.title ? "Before renaming" : "Earlier version"), by);
      const tags = extractTags(content);
      const aliases = extractAliases(content);
      this.db.run("UPDATE documents SET title = ?, content = ?, content_hash = ?, tags = ?, aliases = ?, words = ?, version = version + 1, updated_at = ? WHERE id = ?", [
        title, content, sha(content), JSON.stringify(tags), JSON.stringify(aliases), wordCount(content), nowIso(), id,
      ]);
      this.writeTagsAliases(id, tags, aliases);
      if (content !== d.content) this.indexLinks(id);
      if (title !== d.title || JSON.stringify(aliases) !== JSON.stringify(d.aliases)) this.reresolveFor([d.title as string, title, ...(d.aliases as string[]), ...aliases], id);
    });
    this.changed("document", id, "update");
    return this.get(id);
  }

  /** Rename; by default links in other notes that point at it are rewritten to the new name (like Obsidian). */
  rename(id: string, newTitle: string, opts: { updateLinks?: boolean } = {}): Row {
    const d = this.doc(id);
    const pre = this.incomingTargets(id);
    const r = this.update(id, { title: newTitle }, { reason: "Before renaming" });
    const rewritten = opts.updateLinks === false ? 0 : this.rewriteSources(id, pre, false);
    return { ...this.get(id), links_updated: rewritten, renamed_from: d.title, version: r.version };
  }

  move(id: string, folderId: string | null, opts: { updateLinks?: boolean } = {}): Row {
    const d = this.doc(id);
    if (folderId) this.folder(folderId);
    if ((d.folder_id ?? null) === folderId) return this.get(id);
    const clash = this.db.value("SELECT 1 FROM documents WHERE user_id = ? AND COALESCE(folder_id, '') = ? AND title = ? COLLATE NOCASE AND status = 'active' AND id <> ?", [this.uid, folderId ?? "", d.title, id]);
    if (clash) throw new MothError("conflict", `The destination already has a note called "${d.title}"`);
    const pre = this.incomingTargets(id);
    this.db.run("UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ?", [folderId, nowIso(), id]);
    const rewritten = opts.updateLinks === false ? 0 : this.rewriteSources(id, pre, true);
    this.reresolveFor([d.title as string], id);
    this.changed("document", id, "update");
    return { ...this.get(id), links_updated: rewritten };
  }

  archive(id: string): Row {
    const d = this.doc(id);
    if (d.status === "archived") return this.get(id);
    this.db.tx(() => {
      this.db.run("UPDATE documents SET status = 'archived', updated_at = ? WHERE id = ?", [nowIso(), id]);
      // Links pointing at an archived note become unresolved (their text is kept).
      this.reresolveIncoming(id);
    });
    this.changed("document", id, "update");
    return this.get(id);
  }

  restore(id: string): Row {
    const d = this.doc(id);
    if (d.status === "active") return this.get(id);
    const title = this.uniqueTitle(d.title as string, (d.folder_id as string) ?? null, id);
    this.db.tx(() => {
      this.db.run("UPDATE documents SET status = 'active', title = ?, updated_at = ? WHERE id = ?", [title, nowIso(), id]);
      this.reresolveFor([title, ...(d.aliases as string[])], id);
    });
    this.changed("document", id, "update");
    return this.get(id);
  }

  /** Permanent deletion, only for archived notes. Its revisions go too; attachments stay while other notes use them. */
  deletePermanently(id: string): { ok: true; attachments_removed: number } {
    const d = this.doc(id);
    if (d.status !== "archived") throw new MothError("invalid_input", "Archive the note first; only archived notes can be deleted permanently");
    let removed = 0;
    this.db.tx(() => {
      const atts = this.db.all<Row>("SELECT attachment_id FROM attachment_refs WHERE document_id = ?", [id]).map((r) => r.attachment_id as string);
      this.db.run("UPDATE document_links SET target_id = NULL, status = 'unresolved' WHERE target_kind = 'document' AND target_id = ?", [id]);
      this.db.run("DELETE FROM documents WHERE id = ?", [id]);
      for (const a of atts) removed += this.removeAttachmentIfUnused(a) ? 1 : 0;
    });
    this.changed("document", id, "delete");
    return { ok: true, attachments_removed: removed };
  }

  notePath(d: Row): string {
    const fp = this.folderPath(d.folder_id as string);
    return fp ? `${fp}/${d.title}` : String(d.title);
  }

  list(f: DocListFilter = {}): { items: Row[]; total: number } {
    const where = ["d.user_id = :u", "d.status = :st"];
    const p: Record<string, unknown> = { u: this.uid, st: f.status ?? "active" };
    if (f.folder_id !== undefined) {
      if (f.folder_id === null) where.push("d.folder_id IS NULL");
      else if (f.recursive) {
        where.push("d.folder_id IN (WITH RECURSIVE sub(id) AS (SELECT :fid UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub)");
        p.fid = f.folder_id;
      } else {
        where.push("d.folder_id = :fid");
        p.fid = f.folder_id;
      }
    }
    if (f.tag) (where.push("EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND (t.tag = :tag OR t.tag LIKE :tagp))"), (p.tag = f.tag.toLowerCase()), (p.tagp = `${f.tag.toLowerCase()}/%`));
    if (f.source) (where.push("d.source = :src"), (p.src = f.source));
    if (f.batch) (where.push("d.import_batch_id = :batch"), (p.batch = f.batch));
    if (f.collection) (where.push("EXISTS (SELECT 1 FROM collection_items c WHERE c.collection_id = :col AND c.entity_kind = 'document' AND c.entity_id = d.id)"), (p.col = f.collection));
    let from = "documents d";
    let order = f.sort === "title" ? "d.title COLLATE NOCASE" : f.sort === "created" ? "d.created_at DESC" : "d.updated_at DESC";
    const q = (f.q ?? "").trim();
    if (q) {
      const terms = [...new Set(rawWords(q))].slice(0, 12);
      if (!terms.length) return { items: [], total: 0 };
      from = "documents_fts JOIN documents d ON d.rowid = documents_fts.rowid";
      where.push("documents_fts MATCH :q");
      p.q = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" AND ");
      if (!f.sort) order = "bm25(documents_fts, 8.0, 1.0, 3.0)";
    }
    const limit = Math.max(1, Math.min(500, f.limit ?? 100));
    const offset = Math.max(0, f.offset ?? 0);
    const total = Number(this.db.value(`SELECT COUNT(*) FROM ${from} WHERE ${where.join(" AND ")}`, p) ?? 0);
    const items = this.db.all<Row>(
      `SELECT d.id, d.title, d.folder_id, d.source, d.source_path, d.import_batch_id, d.tags, d.words, d.version, d.status, d.created_at, d.updated_at, d.project_id,
              substr(d.content, 1, 400) AS head
       FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      p,
    ).map((r) => ({ ...r, tags: safeJson<string[]>(r.tags as string, []), excerpt: excerpt(r.head as string, q) }));
    return { items, total };
  }

  tags(): Row[] {
    return this.db.all<Row>("SELECT t.tag, COUNT(*) AS n FROM document_tags t JOIN documents d ON d.id = t.document_id WHERE d.user_id = ? AND d.status = 'active' GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 2000", [this.uid]);
  }

  // ------------------------------------------------------------------ revisions
  revisions(id: string): Row[] {
    this.doc(id);
    return this.db.all<Row>("SELECT id, version, title, reason, created_by, created_at, length(content) AS chars FROM document_revisions WHERE document_id = ? ORDER BY id DESC LIMIT 500", [id]);
  }

  revision(revId: number): Row {
    const r = this.db.get<Row>("SELECT r.* FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE r.id = ? AND d.user_id = ?", [revId, this.uid]);
    if (!r) throw new MothError("not_found", "Revision not found");
    return r;
  }

  /** Restores an earlier revision. The current text is saved as a revision first, so this can be undone. */
  restoreRevision(revId: number): Row {
    const r = this.revision(revId);
    const d = this.doc(r.document_id as string);
    if (d.status !== "active") throw new MothError("invalid_input", "Restore the note from the archive first");
    this.db.tx(() => this.snapshot(d, `Before restoring version ${r.version}`, "user"));
    return this.update(d.id as string, { content: r.content as string }, { reason: `Restored version ${r.version}` });
  }

  // ------------------------------------------------------------------ links
  /** Re-reads a note's links from its text (manual links are kept). */
  indexLinks(id: string): void {
    const d = this.db.get<Row>("SELECT id, content, folder_id, import_batch_id, source_path FROM documents WHERE id = ?", [id]);
    if (!d) return;
    this.db.run("DELETE FROM document_links WHERE source_id = ? AND created_by = 'parser'", [id]);
    this.db.run("DELETE FROM attachment_refs WHERE document_id = ?", [id]);
    const t = nowIso();
    for (const l of extractLinks(d.content as string).slice(0, 5000)) {
      const r = this.resolveLink(l, d);
      this.db.run(
        `INSERT INTO document_links(source_id, kind, raw, target_text, alias, heading, target_kind, target_id, status, candidates, position, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'parser', ?)`,
        [id, l.kind, l.raw.slice(0, 2000), l.target.slice(0, 1000), l.alias?.slice(0, 500) ?? null, l.heading?.slice(0, 500) ?? null, r.target_kind, r.target_id, r.status, JSON.stringify(r.candidates.slice(0, 20)), l.position, t],
      );
      if (r.target_kind === "attachment" && r.target_id) this.db.run("INSERT OR IGNORE INTO attachment_refs(attachment_id, document_id) VALUES (?, ?)", [r.target_id, id]);
    }
  }

  private resolveLink(l: ParsedLink, src: Row): { status: string; target_kind: string | null; target_id: string | null; candidates: { id: string; title: string; path: string }[] } {
    if (l.unsafe) return { status: "unsafe", target_kind: null, target_id: null, candidates: [] };
    if (l.external) return { status: "external", target_kind: "url", target_id: null, candidates: [] };
    if (!l.target) {
      // [[#Heading]] or (#heading): a link inside the same note.
      return { status: "resolved", target_kind: "document", target_id: src.id as string, candidates: [] };
    }
    if (/^memory:/i.test(l.target)) {
      const mid = l.target.slice(7).trim();
      const ok = this.db.value("SELECT 1 FROM memories WHERE id = ? AND user_id = ?", [mid, this.uid]);
      return ok ? { status: "resolved", target_kind: "memory", target_id: mid, candidates: [] } : { status: "unresolved", target_kind: "memory", target_id: null, candidates: [] };
    }
    const r = this.resolveTarget(l.target, src);
    if (r.status !== "unresolved" || l.kind === "wikilink" && !/\.[a-z0-9]{2,5}$/i.test(l.target)) return { ...r, target_kind: r.status === "resolved" ? "document" : null };
    // Not a note: maybe a file (image, pdf…).
    const att = this.resolveAttachment(l.target, src);
    if (att.status !== "unresolved") return att;
    return { ...r, target_kind: null };
  }

  /**
   * Deterministic note resolution:
   * 1. A path ("Folder/Note", "./Note", "../x/Note", "Note.md" relative to this note) → the note at that path
   *    (vault-relative for imported notes, MOTH folder path otherwise).
   * 2. A name → notes with that title or alias. One match → resolved. Several → prefer the one in the same folder
   *    as the linking note, then the same import; if still several → "ambiguous" with the candidates listed.
   * Archived notes are never targets.
   */
  resolveTarget(target: string, src: Row): { status: "resolved" | "unresolved" | "ambiguous"; target_id: string | null; candidates: { id: string; title: string; path: string }[] } {
    const t = normTarget(target);
    if (!t) return { status: "unresolved", target_id: null, candidates: [] };
    const cand = (rows: Row[]) => rows.map((r) => ({ id: r.id as string, title: r.title as string, path: this.notePath(r) }));
    if (t.includes("/")) {
      const srcDir = src.source_path ? path.posix.dirname(String(src.source_path)) : this.folderPath(src.folder_id as string);
      const tries = new Set<string>();
      if (t.startsWith("./") || t.startsWith("../")) tries.add(path.posix.normalize(path.posix.join(srcDir === "." ? "" : srcDir, t)));
      tries.add(t.replace(/^\//, ""));
      if (srcDir && srcDir !== ".") tries.add(path.posix.normalize(path.posix.join(srcDir, t)));
      for (const p of tries) {
        const lp = p.toLowerCase();
        if (src.import_batch_id) {
          const hit = this.db.all<Row>("SELECT id, title, folder_id FROM documents WHERE user_id = ? AND status = 'active' AND import_batch_id = ? AND (lower(source_path) = ? OR lower(source_path) = ?)", [this.uid, src.import_batch_id, `${lp}.md`, `${lp}.markdown`]);
          if (hit.length === 1) return { status: "resolved", target_id: hit[0].id as string, candidates: [] };
        }
        const base = path.posix.basename(p);
        const dir = path.posix.dirname(p);
        const byName = this.db.all<Row>("SELECT id, title, folder_id FROM documents WHERE user_id = ? AND status = 'active' AND title = ? COLLATE NOCASE", [this.uid, base]);
        const exact = byName.filter((r) => this.folderPath(r.folder_id as string).toLowerCase().endsWith(dir.toLowerCase()));
        if (exact.length === 1) return { status: "resolved", target_id: exact[0].id as string, candidates: [] };
        if (exact.length > 1) return { status: "ambiguous", target_id: null, candidates: cand(exact) };
      }
      return { status: "unresolved", target_id: null, candidates: [] };
    }
    const name = t.replace(/\.(md|markdown)$/i, "");
    let rows = this.db.all<Row>(
      `SELECT id, title, folder_id, import_batch_id FROM documents WHERE user_id = ? AND status = 'active' AND title = ? COLLATE NOCASE
       UNION SELECT d.id, d.title, d.folder_id, d.import_batch_id FROM document_aliases a JOIN documents d ON d.id = a.document_id WHERE d.user_id = ? AND d.status = 'active' AND a.alias = ? COLLATE NOCASE`,
      [this.uid, name, this.uid, name],
    );
    if (rows.length === 1) return { status: "resolved", target_id: rows[0].id as string, candidates: [] };
    if (!rows.length) return { status: "unresolved", target_id: null, candidates: [] };
    const sameFolder = rows.filter((r) => (r.folder_id ?? null) === (src.folder_id ?? null));
    if (sameFolder.length === 1) return { status: "resolved", target_id: sameFolder[0].id as string, candidates: [] };
    const sameBatch = (sameFolder.length ? sameFolder : rows).filter((r) => src.import_batch_id && r.import_batch_id === src.import_batch_id);
    if (sameBatch.length === 1) return { status: "resolved", target_id: sameBatch[0].id as string, candidates: [] };
    rows = sameFolder.length ? sameFolder : rows;
    return { status: "ambiguous", target_id: null, candidates: cand(rows) };
  }

  private resolveAttachment(target: string, src: Row): { status: string; target_kind: string | null; target_id: string | null; candidates: { id: string; title: string; path: string }[] } {
    const base = path.posix.basename(target.replace(/\\/g, "/"));
    const rows = this.db.all<Row>("SELECT id, original_name FROM attachments WHERE user_id = ? AND original_name = ? COLLATE NOCASE", [this.uid, base]);
    if (!rows.length) return { status: "unresolved", target_kind: null, target_id: null, candidates: [] };
    if (rows.length === 1) return { status: "resolved", target_kind: "attachment", target_id: rows[0].id as string, candidates: [] };
    // Same name, different files: prefer the one imported with this note.
    if (src.import_batch_id) {
      const viaBatch = this.db.all<Row>("SELECT a.id FROM attachments a JOIN import_items i ON i.entity_id = a.id WHERE i.batch_id = ? AND a.original_name = ? COLLATE NOCASE", [src.import_batch_id, base]);
      if (viaBatch.length === 1) return { status: "resolved", target_kind: "attachment", target_id: viaBatch[0].id as string, candidates: [] };
    }
    return { status: "ambiguous", target_kind: "attachment", target_id: null, candidates: rows.map((r) => ({ id: r.id as string, title: r.original_name as string, path: r.original_name as string })) };
  }

  /** After a note appears, is renamed or gets aliases: links naming it (or that pointed at it) are resolved again. */
  reresolveFor(names: string[], docId?: string): number {
    const keys = [...new Set(names.filter(Boolean).map((n) => normTarget(n)))];
    const rows: Row[] = [];
    for (const k of keys) {
      rows.push(...this.db.all<Row>("SELECT l.*, d.folder_id, d.import_batch_id, d.source_path FROM document_links l JOIN documents d ON d.id = l.source_id WHERE l.created_by = 'parser' AND l.status IN ('unresolved','ambiguous','resolved') AND (lower(l.target_text) = ? OR lower(l.target_text) = ? OR lower(l.target_text) LIKE ?)", [k, `${k}.md`, `%/${k}`]));
    }
    if (docId) rows.push(...this.db.all<Row>("SELECT l.*, d.folder_id, d.import_batch_id, d.source_path FROM document_links l JOIN documents d ON d.id = l.source_id WHERE l.created_by = 'parser' AND l.target_kind = 'document' AND l.target_id = ?", [docId]));
    const seen = new Set<number>();
    let n = 0;
    for (const l of rows) {
      if (seen.has(Number(l.id))) continue;
      seen.add(Number(l.id));
      if (!l.target_text) continue;
      const r = this.resolveTarget(String(l.target_text), { id: l.source_id, folder_id: l.folder_id, import_batch_id: l.import_batch_id, source_path: l.source_path });
      const kind = r.status === "resolved" ? "document" : null;
      if (r.status !== l.status || r.target_id !== l.target_id) {
        this.db.run("UPDATE document_links SET status = ?, target_kind = ?, target_id = ?, candidates = ? WHERE id = ?", [r.status, kind, r.target_id, JSON.stringify(r.candidates.slice(0, 20)), l.id]);
        n++;
      }
    }
    return n;
  }

  private reresolveIncoming(docId: string): void {
    const titles = this.db.all<Row>("SELECT DISTINCT target_text FROM document_links WHERE target_kind = 'document' AND target_id = ?", [docId]).map((r) => r.target_text as string);
    this.reresolveFor(titles, docId);
  }

  /** Which notes link to `docId` right now, and with which link text (captured before a rename or move). */
  private incomingTargets(docId: string): Map<string, string[]> {
    const rows = this.db.all<Row>("SELECT l.source_id, l.target_text FROM document_links l JOIN documents s ON s.id = l.source_id WHERE l.target_kind = 'document' AND l.target_id = ? AND l.created_by = 'parser' AND s.status = 'active' AND l.source_id <> ?", [docId, docId]);
    const m = new Map<string, string[]>();
    for (const r of rows) (m.get(r.source_id as string) ?? m.set(r.source_id as string, []).get(r.source_id as string)!).push(r.target_text as string);
    return m;
  }

  /**
   * Rewrites the links captured by `incomingTargets` so they keep pointing at the same note after a rename or move.
   * Only those links are touched (a rename never redirects links to another note with the old name). A revision of
   * each changed note is kept. Imported source vaults are never touched — only MOTH's own copies.
   */
  private rewriteSources(docId: string, pre: Map<string, string[]>, pathOnly: boolean): number {
    const d = this.doc(docId);
    const newPath = this.notePath(d);
    const titleUnique = Number(this.db.value("SELECT COUNT(*) FROM documents WHERE user_id = ? AND status = 'active' AND title = ? COLLATE NOCASE", [this.uid, d.title]) ?? 0) === 1;
    let changed = 0;
    for (const [sid, targets] of pre) {
      const s = this.doc(sid);
      let text = s.content as string;
      let n = 0;
      for (const tt of new Set(targets)) {
        const isPath = tt.includes("/");
        if (pathOnly && !isPath) continue;
        // Links that still find the note (e.g. through an alias) are left exactly as written.
        if (this.resolveTarget(tt, s).target_id === docId) continue;
        const to = isPath || !titleUnique ? newPath : (d.title as string);
        if (normTarget(tt) === normTarget(to)) continue;
        const r = rewriteLinkTargets(text, [tt], to);
        text = r.text;
        n += r.changed;
      }
      if (n) {
        this.update(sid, { content: text }, { reason: `Before updating links to "${d.title}"`, forceRevision: true, by: "moth" });
        changed += n;
      }
    }
    // Links that pointed at the note by id but were not rewritten (e.g. path links after a rename) are re-resolved.
    this.reresolveFor([], docId);
    return changed;
  }

  /** Incoming, outgoing and unresolved links of a note, plus related notes by shared words (suggestions only). */
  backlinks(id: string): Row {
    const d = this.doc(id);
    const incoming = this.db.all<Row>(
      `SELECT l.id, l.kind, l.raw, l.alias, l.heading, l.position, s.id AS source_id, s.title AS source_title, s.folder_id, substr(s.content, max(1, l.position - 80), 220) AS context
       FROM document_links l JOIN documents s ON s.id = l.source_id
       WHERE l.target_kind = 'document' AND l.target_id = ? AND l.status = 'resolved' AND s.status = 'active' AND l.source_id <> ? ORDER BY s.title COLLATE NOCASE LIMIT 500`,
      [id, id],
    ).map((r): Row => ({ ...r, context: String(r.context ?? "").replace(/\s+/g, " ").trim() }));
    const outgoing = this.db.all<Row>(
      `SELECT l.id, l.kind, l.raw, l.target_text, l.alias, l.heading, l.target_kind, l.target_id, l.status, l.candidates, l.created_by,
              CASE l.target_kind WHEN 'document' THEN (SELECT title FROM documents WHERE id = l.target_id) WHEN 'memory' THEN (SELECT title FROM memories WHERE id = l.target_id) WHEN 'attachment' THEN (SELECT original_name FROM attachments WHERE id = l.target_id) END AS target_title
       FROM document_links l WHERE l.source_id = ? ORDER BY l.position LIMIT 2000`,
      [id],
    ).map((r): Row => ({ ...r, candidates: safeJson(r.candidates as string, []) }));
    const memoryLinks = outgoing.filter((o) => o.target_kind === "memory" && o.status === "resolved");
    // Suggestions: notes and memories sharing this note's most distinctive words. Clearly marked as suggestions.
    const suggestions: Row[] = [];
    const linked = new Set([...incoming.map((x) => x.source_id), ...outgoing.map((x) => x.target_id)].filter(Boolean) as string[]);
    const text = `${d.title} ${String(d.content).slice(0, 4000)}`;
    const words = [...new Set(rawWords(text))].filter((w) => w.length > 3).slice(0, 400);
    if (words.length) {
      const rare = words
        .map((w) => ({ w, n: Number(this.db.value("SELECT COUNT(*) FROM (SELECT 1 FROM documents_fts WHERE documents_fts MATCH ? LIMIT 200)", [`"${w}"`]) ?? 0) }))
        .filter((x) => x.n > 1 && x.n < 200)
        .sort((a, b) => a.n - b.n)
        .slice(0, 6)
        .map((x) => x.w);
      if (rare.length >= 2) {
        const hits = this.db.all<Row>(`SELECT d.id, d.title FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid WHERE documents_fts MATCH ? AND d.status = 'active' AND d.id <> ? ORDER BY bm25(documents_fts) LIMIT 8`, [rare.map((w) => `"${w}"`).join(" OR "), id]);
        for (const h of hits) if (!linked.has(h.id as string)) suggestions.push({ kind: "document", id: h.id, title: h.title, why: "shares distinctive words (word-based suggestion, not a link)" });
      }
    }
    const mems = this.brain.search.candidates(text, 5);
    for (const [mid] of mems) {
      if (linked.has(mid)) continue;
      const m = this.db.get<Row>("SELECT id, title, status FROM memories WHERE id = ?", [mid]);
      if (m && m.status === "active") suggestions.push({ kind: "memory", id: m.id, title: m.title, why: "a memory with overlapping words (suggestion)" });
    }
    return {
      incoming,
      outgoing: outgoing.filter((o) => o.status !== "unresolved" && o.status !== "ambiguous"),
      unresolved: outgoing.filter((o) => o.status === "unresolved" || o.status === "ambiguous"),
      memories: memoryLinks,
      suggestions: suggestions.slice(0, 10),
    };
  }

  /** A link the user makes by hand (note → note or note → memory). Kept when the note's text changes. */
  addManualLink(sourceId: string, targetKind: "document" | "memory", targetId: string): Row {
    this.doc(sourceId);
    const title = targetKind === "document" ? this.doc(targetId).title : this.brain.store.requireMemory(targetId).title;
    const exists = this.db.value("SELECT id FROM document_links WHERE source_id = ? AND created_by = 'user' AND target_kind = ? AND target_id = ?", [sourceId, targetKind, targetId]);
    if (exists) return { id: exists, existing: true };
    const r = this.db.run(
      "INSERT INTO document_links(source_id, kind, raw, target_text, target_kind, target_id, status, created_by, created_at) VALUES (?, 'manual', '', ?, ?, ?, 'resolved', 'user', ?)",
      [sourceId, String(title), targetKind, targetId, nowIso()],
    );
    this.changed("document", sourceId, "update");
    return { id: r.lastInsertRowid };
  }

  removeManualLink(linkId: number): { ok: true } {
    const l = this.db.get<Row>("SELECT l.* FROM document_links l JOIN documents d ON d.id = l.source_id WHERE l.id = ? AND d.user_id = ?", [linkId, this.uid]);
    if (!l) throw new MothError("not_found", "Link not found");
    if (l.created_by !== "user") throw new MothError("invalid_input", "This link comes from the note's text: edit the text to remove it");
    this.db.run("DELETE FROM document_links WHERE id = ?", [linkId]);
    this.changed("document", l.source_id as string, "update");
    return { ok: true };
  }

  /** Unresolved and ambiguous links across the library (Knowledge Health uses this). */
  unresolvedLinks(limit = 500): Row[] {
    return this.db.all<Row>(
      `SELECT l.id, l.raw, l.target_text, l.status, l.candidates, d.id AS source_id, d.title AS source_title FROM document_links l JOIN documents d ON d.id = l.source_id
       WHERE d.user_id = ? AND d.status = 'active' AND l.status IN ('unresolved','ambiguous') ORDER BY d.title COLLATE NOCASE LIMIT ?`,
      [this.uid, limit],
    ).map((r): Row => ({ ...r, candidates: safeJson(r.candidates as string, []) }));
  }

  // ------------------------------------------------------------------ collections
  collections(): Row[] {
    return this.db.all<Row>("SELECT c.*, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) AS items FROM collections c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE", [this.uid]);
  }
  createCollection(name: string, description = ""): Row {
    const n = String(name ?? "").trim().slice(0, 120);
    if (!n) throw new MothError("invalid_input", "A collection needs a name");
    if (this.db.value("SELECT 1 FROM collections WHERE user_id = ? AND name = ? COLLATE NOCASE", [this.uid, n])) throw new MothError("conflict", `A collection called "${n}" already exists`);
    const id = newId("col");
    const t = nowIso();
    this.db.run("INSERT INTO collections(id, user_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)", [id, this.uid, n, String(description).slice(0, 1000), t, t]);
    this.changed("collection", id, "insert");
    return this.db.get<Row>("SELECT * FROM collections WHERE id = ?", [id])!;
  }
  renameCollection(id: string, name: string): Row {
    const n = String(name ?? "").trim().slice(0, 120);
    if (!n) throw new MothError("invalid_input", "A collection needs a name");
    if (this.db.value("SELECT 1 FROM collections WHERE user_id = ? AND name = ? COLLATE NOCASE AND id <> ?", [this.uid, n, id])) throw new MothError("conflict", `A collection called "${n}" already exists`);
    const r = this.db.run("UPDATE collections SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?", [n, nowIso(), id, this.uid]);
    if (!r.changes) throw new MothError("not_found", "Collection not found");
    this.changed("collection", id, "update");
    return this.db.get<Row>("SELECT * FROM collections WHERE id = ?", [id])!;
  }
  /** Removes the collection only; the notes and memories in it are untouched. */
  deleteCollection(id: string): { ok: true } {
    this.db.run("DELETE FROM collections WHERE id = ? AND user_id = ?", [id, this.uid]);
    this.changed("collection", id, "delete");
    return { ok: true };
  }
  setInCollection(id: string, kind: "document" | "memory" | "project", entityId: string, inIt: boolean): { ok: true } {
    if (!this.db.value("SELECT 1 FROM collections WHERE id = ? AND user_id = ?", [id, this.uid])) throw new MothError("not_found", "Collection not found");
    if (inIt) this.db.run("INSERT OR IGNORE INTO collection_items(collection_id, entity_kind, entity_id, added_at) VALUES (?,?,?,?)", [id, kind, entityId, nowIso()]);
    else this.db.run("DELETE FROM collection_items WHERE collection_id = ? AND entity_kind = ? AND entity_id = ?", [id, kind, entityId]);
    this.changed("collection", id, "update");
    return { ok: true };
  }
  collectionItems(id: string): Row[] {
    return this.db.all<Row>(
      `SELECT i.entity_kind, i.entity_id, i.added_at,
              CASE i.entity_kind WHEN 'document' THEN (SELECT title FROM documents WHERE id = i.entity_id) WHEN 'memory' THEN (SELECT title FROM memories WHERE id = i.entity_id) ELSE (SELECT name FROM projects WHERE id = i.entity_id) END AS title
       FROM collection_items i WHERE i.collection_id = ? ORDER BY i.added_at DESC LIMIT 2000`,
      [id],
    );
  }

  // ------------------------------------------------------------------ attachments
  attachmentDir(): string {
    return path.join(this.brain.paths.base, "attachments");
  }

  /** Absolute path of a stored attachment (inside MOTH's attachments folder, never elsewhere). */
  attachmentFile(id: string): { file: string; row: Row } {
    const a = this.db.get<Row>("SELECT * FROM attachments WHERE id = ? AND user_id = ?", [id, this.uid]);
    if (!a) throw new MothError("not_found", "Attachment not found");
    const root = path.resolve(this.attachmentDir());
    const file = path.resolve(root, String(a.storage_path));
    if (!file.startsWith(root + path.sep)) throw new MothError("invalid_input", "Invalid attachment path");
    return { file, row: a };
  }

  attachments(f: { document_id?: string; q?: string; offset?: number; limit?: number } = {}): { items: Row[]; total: number } {
    const where = ["a.user_id = ?"];
    const p: unknown[] = [this.uid];
    if (f.document_id) (where.push("EXISTS (SELECT 1 FROM attachment_refs r WHERE r.attachment_id = a.id AND r.document_id = ?)"), p.push(f.document_id));
    if (f.q) (where.push("a.original_name LIKE ?"), p.push(`%${f.q}%`));
    const total = Number(this.db.value(`SELECT COUNT(*) FROM attachments a WHERE ${where.join(" AND ")}`, p) ?? 0);
    const items = this.db.all<Row>(`SELECT a.*, (SELECT COUNT(*) FROM attachment_refs r WHERE r.attachment_id = a.id) AS refs FROM attachments a WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ${Math.min(500, f.limit ?? 100)} OFFSET ${Math.max(0, f.offset ?? 0)}`, p);
    return { items, total };
  }

  /** Deletes the stored file only when no note references it any more. */
  removeAttachmentIfUnused(id: string): boolean {
    const refs = Number(this.db.value("SELECT COUNT(*) FROM attachment_refs WHERE attachment_id = ?", [id]) ?? 0);
    if (refs) return false;
    const { file } = this.attachmentFile(id);
    this.db.run("DELETE FROM attachments WHERE id = ?", [id]);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
    return true;
  }

  // ------------------------------------------------------------------ workspace
  workspace(): Row {
    const r = this.db.get<Row>("SELECT state, updated_at FROM workspace_sessions WHERE id = 'default' AND user_id = ?", [this.uid]);
    return { state: safeJson(r?.state as string, null), updated_at: r?.updated_at ?? null };
  }
  saveWorkspace(state: unknown): { ok: true } {
    const json = JSON.stringify(state ?? {});
    if (json.length > 500_000) throw new MothError("invalid_input", "Workspace state is too large");
    this.db.run("INSERT INTO workspace_sessions(id, user_id, state, updated_at) VALUES ('default', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at", [this.uid, json, nowIso()]);
    return { ok: true };
  }
  /** For restoring tabs: which of these documents / memories / projects still exist (and their titles). */
  resolveEntities(refs: { kind: string; id: string }[]): Row[] {
    return refs.slice(0, 50).map((r) => {
      const row =
        r.kind === "document" ? this.db.get<Row>("SELECT title, status FROM documents WHERE id = ? AND user_id = ?", [r.id, this.uid])
        : r.kind === "memory" ? this.db.get<Row>("SELECT title, status FROM memories WHERE id = ? AND user_id = ?", [r.id, this.uid])
        : r.kind === "project" ? this.db.get<Row>("SELECT name AS title, CASE WHEN archived THEN 'archived' ELSE 'active' END AS status FROM projects WHERE id = ? AND user_id = ?", [r.id, this.uid])
        : null;
      return { ...r, exists: !!row, title: row?.title ?? null, status: row?.status ?? null };
    });
  }

  /** Library-wide counts for the sidebar. */
  stats(): Row {
    const n = (sql: string, p: unknown[] = []) => Number(this.db.value(sql, p) ?? 0);
    return {
      notes: n("SELECT COUNT(*) FROM documents WHERE user_id = ? AND status = 'active' AND source = 'note'", [this.uid]),
      imported: n("SELECT COUNT(*) FROM documents WHERE user_id = ? AND status = 'active' AND source = 'obsidian'", [this.uid]),
      archived: n("SELECT COUNT(*) FROM documents WHERE user_id = ? AND status = 'archived'", [this.uid]),
      folders: n("SELECT COUNT(*) FROM folders WHERE user_id = ?", [this.uid]),
      attachments: n("SELECT COUNT(*) FROM attachments WHERE user_id = ?", [this.uid]),
      memories: n("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active'", [this.uid]),
      projects: n("SELECT COUNT(*) FROM projects WHERE user_id = ? AND archived = 0", [this.uid]),
      collections: n("SELECT COUNT(*) FROM collections WHERE user_id = ?", [this.uid]),
      unresolved_links: n("SELECT COUNT(*) FROM document_links l JOIN documents d ON d.id = l.source_id WHERE d.user_id = ? AND d.status = 'active' AND l.status IN ('unresolved','ambiguous')", [this.uid]),
    };
  }
}

function excerpt(head: string, q: string): string {
  const body = String(head ?? "").replace(/^---[\s\S]*?\n---\s*/, "").replace(/[#>*_`\[\]]/g, "").replace(/\s+/g, " ").trim();
  if (!q) return truncate(body, 160);
  const i = body.toLowerCase().indexOf(q.toLowerCase().split(/\s+/)[0] ?? "");
  return truncate(i > 40 ? `…${body.slice(i - 30)}` : body, 160);
}
