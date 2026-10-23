// MemoryStore: every read and write of memories, versions, relationships, projects and events.
// All writes are transactional, versioned and recorded as learning events with an undo recipe.
import crypto from "node:crypto";
import type { Database, Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import { LOCAL_MODEL, localEmbed, vecToBlob } from "./embeddings.ts";
import { LIMITS, sanitizeTags, sanitizeText } from "./security.ts";
import type { SettingsStore } from "./settings.ts";
import { deriveTitle, hashText, keywords, slugify, summarize, uniq } from "./text.ts";
import {
  CATEGORIES, MothError, RELATION_TYPES,
  type Actor, type Category, type ChangeContext, type Memory, type MemoryInput, type Project, type Relationship, type RelationType,
} from "./types.ts";

export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;

const DEFAULT_IMPORTANCE: Record<Category, number> = {
  project: 0.9, decision: 0.7, solution: 0.7, error: 0.6, task: 0.55, preference: 0.6,
  fact: 0.5, research: 0.5, concept: 0.5, person: 0.55, idea: 0.45,
};

export function classify(text: string): Category {
  const t = text.toLowerCase();
  if (/\b(fix(ed|es)?|solved|solution|workaround|resolved|the fix|patched)\b/.test(t)) return "solution";
  if (/\b(error|bug|crash(es|ed)?|exception|fails?|failing|broken|stack trace|nil value|attempt to index)\b/.test(t)) return "error";
  if (/\b(decided|decision|we will use|chose|going with|agreed to|settled on)\b/.test(t)) return "decision";
  if (/^(todo|to do)\b|\b(need to|next step|still need|remaining work|should add|not yet)\b/.test(t)) return "task";
  if (/\b(idea|what if|could add|might be cool|brainstorm)\b/.test(t)) return "idea";
  if (/\b(prefers?|likes it when|wants me to|always wants|never wants)\b/.test(t)) return "preference";
  if (/\b(research|paper|study|benchmark|according to)\b/.test(t)) return "research";
  return "fact";
}

export interface RecordEventInput {
  kind: string;
  description: string;
  reason: string;
  actor: Actor;
  task_id?: string | null;
  memory_id?: string | null;
  related_memory_id?: string | null;
  relationship_id?: string | null;
  project_id?: string | null;
  undo?: Record<string, unknown> | null;
}

export class MemoryStore {
  constructor(public db: Database, public settings: SettingsStore) {}

  // ---------------------------------------------------------------- users
  get userId(): string {
    return this.settings.get("auth.currentUser") || "local";
  }

  ensureLocalUser(): void {
    this.db.run("INSERT OR IGNORE INTO users(id, kind, name, created_at) VALUES ('local', 'local', 'Local user', ?)", [nowIso()]);
    const uid = this.userId;
    if (!this.db.value("SELECT 1 FROM users WHERE id = ?", [uid])) this.settings.set("auth.currentUser", "local");
  }

  // ---------------------------------------------------------------- row mapping
  toMemory(r: Row): Memory {
    return {
      ...(r as unknown as Memory),
      tags: safeJson(r.tags as string, []),
      flags: safeJson(r.flags as string, []),
      manual_lock: !!r.manual_lock,
      is_demo: !!r.is_demo,
      importance: Number(r.importance),
      confidence: Number(r.confidence),
      version: Number(r.version),
      access_count: Number(r.access_count),
    };
  }

  toProject(r: Row): Project {
    return {
      ...(r as unknown as Project),
      aliases: safeJson(r.aliases as string, []),
      files: safeJson(r.files as string, []),
      archived: !!r.archived,
      is_demo: !!r.is_demo,
    };
  }

  // ---------------------------------------------------------------- memories: read
  getMemory(id: string): Memory | null {
    const r = this.db.get("SELECT * FROM memories WHERE id = ? AND user_id = ?", [id, this.userId]);
    return r ? this.toMemory(r) : null;
  }

  requireMemory(id: string): Memory {
    if (typeof id !== "string" || !id) throw new MothError("invalid_input", "memory id is required");
    const m = this.getMemory(id);
    if (!m) throw new MothError("not_found", `No memory with id ${id}`);
    return m;
  }

  getMany(ids: string[]): Memory[] {
    if (!ids.length) return [];
    const uniqIds = uniq(ids);
    const rows = this.db.all(`SELECT * FROM memories WHERE user_id = ? AND id IN (${uniqIds.map(() => "?").join(",")})`, [this.userId, ...uniqIds]);
    const map = new Map(rows.map((r) => [r.id as string, this.toMemory(r)]));
    return uniqIds.map((i) => map.get(i)).filter(Boolean) as Memory[];
  }

  listMemories(f: {
    status?: string; category?: string; project_id?: string; tag?: string; since?: string; until?: string;
    limit?: number; offset?: number; order?: "updated" | "created" | "importance" | "title"; include_demo?: boolean;
  } = {}): { items: Memory[]; total: number } {
    const where = ["user_id = :uid"];
    const p: Record<string, unknown> = { uid: this.userId };
    if (f.status && f.status !== "all") { where.push("status = :status"); p.status = f.status; }
    if (f.category) { where.push("category = :category"); p.category = f.category; }
    if (f.project_id) { where.push("(project_id = :pid OR id IN (SELECT memory_id FROM project_memories WHERE project_id = :pid))"); p.pid = f.project_id; }
    if (f.tag) { where.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = :tag)"); p.tag = f.tag; }
    if (f.since) { where.push("updated_at >= :since"); p.since = f.since; }
    if (f.until) { where.push("updated_at <= :until"); p.until = f.until; }
    const order = { updated: "updated_at DESC", created: "created_at DESC", importance: "importance DESC, updated_at DESC", title: "title COLLATE NOCASE ASC" }[f.order ?? "updated"];
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    const total = Number(this.db.value(`SELECT COUNT(*) FROM memories WHERE ${where.join(" AND ")}`, p) ?? 0);
    const rows = this.db.all(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${Math.max(0, f.offset ?? 0)}`, p);
    return { items: rows.map((r) => this.toMemory(r)), total };
  }

  touch(ids: string[]): void {
    const t = nowIso();
    for (const id of uniq(ids)) this.db.run("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?", [t, id]);
  }

  // ---------------------------------------------------------------- memories: write
  private clean(input: Partial<MemoryInput>, existing?: Memory) {
    const opts = { redact: this.settings.get("privacy.redactSecrets"), flagInjection: this.settings.get("privacy.flagInjections") };
    const flags: string[] = [];
    let content = existing?.content ?? "";
    if (input.content !== undefined) {
      const c = sanitizeText(input.content, "content", LIMITS.content, opts);
      if (!c.text) throw new MothError("invalid_input", "content must not be empty");
      content = c.text;
      flags.push(...c.flags);
    }
    let title = existing?.title ?? "";
    if (input.title !== undefined && input.title !== null && String(input.title).trim()) {
      const t = sanitizeText(input.title, "title", LIMITS.title, opts);
      title = t.text.replace(/\n+/g, " ");
      flags.push(...t.flags);
    }
    if (!title) title = deriveTitle(content);
    let summary = existing?.summary ?? "";
    if (input.summary !== undefined && input.summary !== null) summary = sanitizeText(input.summary, "summary", 2000, opts).text;
    if (input.content !== undefined && (input.summary === undefined || input.summary === null)) summary = summarize(content);
    const category = input.category ?? existing?.category ?? classify(`${title}\n${content}`);
    if (!CATEGORIES.includes(category)) throw new MothError("invalid_input", `category must be one of: ${CATEGORIES.join(", ")}`);
    const tags = input.tags !== undefined ? sanitizeTags(input.tags) : existing?.tags ?? [];
    return { title, content, summary, category, tags, flags };
  }

  private snapshot(m: Memory, changedBy: Actor, changeType: string, reason: string): void {
    this.db.run(
      `INSERT INTO memory_versions(memory_id, version, title, content, summary, category, tags, project_id, importance, confidence, status, changed_by, change_type, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.id, m.version, m.title, m.content, m.summary, m.category, JSON.stringify(m.tags), m.project_id, m.importance, m.confidence, m.status, changedBy, changeType, reason, m.updated_at],
    );
  }

  private embedLocal(id: string, m: { title: string; content: string; summary: string; tags: string[] }): void {
    const text = embeddingText(m);
    const hash = hashText(text);
    const v = localEmbed(text);
    this.db.run(
      `INSERT INTO memory_embeddings(memory_id, model, dims, vector, content_hash, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(memory_id, model) DO UPDATE SET vector = excluded.vector, dims = excluded.dims, content_hash = excluded.content_hash, created_at = excluded.created_at`,
      [id, LOCAL_MODEL, v.length, vecToBlob(v), hash, nowIso()],
    );
    this.db.run("UPDATE memories SET embedding_ref = ? WHERE id = ?", [`${LOCAL_MODEL}:${hash}`, id]);
  }

  createMemory(input: MemoryInput, ctx: ChangeContext, opts: { recordEvent?: boolean } = {}): Memory {
    const c = this.clean(input);
    const id = newId("mem");
    const t = nowIso();
    const importance = clampNum(input.importance, DEFAULT_IMPORTANCE[c.category]);
    const confidence = clampNum(input.confidence, ctx.actor === "user" ? 0.95 : 0.75);
    if (input.project_id && !this.db.value("SELECT 1 FROM projects WHERE id = ? AND user_id = ?", [input.project_id, this.userId]))
      throw new MothError("not_found", `No project with id ${input.project_id}`);
    return this.db.tx(() => {
      this.db.run(
        `INSERT INTO memories(id, user_id, title, content, summary, category, tags, source, source_ref, source_timestamp, project_id,
          created_at, updated_at, importance, confidence, verification, status, version, manual_lock, task_state, flags, is_demo)
         VALUES (:id,:uid,:title,:content,:summary,:category,:tags,:source,:source_ref,:source_ts,:project_id,:t,:t,:importance,:confidence,:verification,'active',1,:lock,:task_state,:flags,:demo)`,
        {
          id, uid: this.userId, title: c.title, content: c.content, summary: c.summary, category: c.category, tags: JSON.stringify(c.tags),
          source: input.source ?? (ctx.actor === "user" ? "user" : ctx.actor === "claude" ? "claude" : "moth"),
          source_ref: input.source_ref ?? null, source_ts: input.source_timestamp ?? t, project_id: input.project_id ?? null, t,
          importance, confidence, verification: input.verification ?? (ctx.actor === "user" ? "user_confirmed" : "unverified"),
          lock: ctx.actor === "user" ? 1 : 0,
          task_state: c.category === "task" ? (input.task_state ?? "open") : null,
          flags: JSON.stringify(uniq(c.flags)), demo: input.is_demo ? 1 : 0,
        },
      );
      const m = this.requireMemory(id);
      this.snapshot(m, ctx.actor, "create", ctx.reason);
      this.embedLocal(id, m);
      if (m.project_id) this.attachToProject(m, m.project_id, ctx);
      if (opts.recordEvent !== false) {
        this.recordEvent({
          kind: "created", actor: ctx.actor, task_id: ctx.task_id, memory_id: id, project_id: m.project_id,
          description: `Created ${m.category} memory "${m.title}"`, reason: ctx.reason, undo: { op: "archive", memory_id: id },
        });
      }
      return this.requireMemory(id);
    });
  }

  private attachToProject(m: Memory, projectId: string, ctx: ChangeContext): void {
    this.db.run("INSERT OR IGNORE INTO project_memories(project_id, memory_id, role, added_at) VALUES (?,?,?,?)", [projectId, m.id, m.category === "project" ? "hub" : "member", nowIso()]);
    const hub = this.db.value<string>("SELECT hub_memory_id FROM projects WHERE id = ?", [projectId]);
    if (hub && hub !== m.id) {
      const project = this.db.value<string>("SELECT name FROM projects WHERE id = ?", [projectId]);
      this.link(m.id, hub, "BELONGS_TO", `Memory is part of project "${project}"`, { ...ctx, actor: ctx.actor }, { strength: 0.8, recordEvent: false });
    }
    this.db.run("UPDATE projects SET last_activity_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), projectId]);
  }

  updateMemory(id: string, patch: Partial<MemoryInput> & { status?: Memory["status"] }, ctx: ChangeContext, opts: { changeType?: string; recordEvent?: boolean; force?: boolean } = {}): Memory {
    const before = this.requireMemory(id);
    const changesText = patch.title !== undefined || patch.content !== undefined || patch.summary !== undefined || patch.category !== undefined;
    if (before.manual_lock && ctx.actor !== "user" && changesText && !opts.force) {
      throw new MothError(
        "locked",
        `"${before.title}" was written or corrected by the user, so automatic updates cannot overwrite it. Use moth_append_memory to add information instead.`,
      );
    }
    const c = this.clean(patch, before);
    const importance = patch.importance !== undefined ? clampNum(patch.importance, before.importance) : before.importance;
    const confidence = patch.confidence !== undefined ? clampNum(patch.confidence, before.confidence) : before.confidence;
    const projectId = patch.project_id !== undefined ? patch.project_id : before.project_id;
    if (projectId && projectId !== before.project_id && !this.db.value("SELECT 1 FROM projects WHERE id = ? AND user_id = ?", [projectId, this.userId]))
      throw new MothError("not_found", `No project with id ${projectId}`);
    const flags = uniq([...before.flags.filter((f) => !(patch.content !== undefined && f === "possible_prompt_injection")), ...c.flags]);
    const status = patch.status ?? before.status;
    const t = nowIso();
    const changeType = opts.changeType ?? "update";
    return this.db.tx(() => {
      this.db.run(
        `UPDATE memories SET title=:title, content=:content, summary=:summary, category=:category, tags=:tags, project_id=:pid,
           importance=:imp, confidence=:conf, verification=:ver, status=:status, task_state=:ts, flags=:flags,
           manual_lock = CASE WHEN :lock = 1 THEN 1 ELSE manual_lock END,
           archived_at = CASE WHEN :status = 'active' THEN NULL WHEN status = 'active' AND :status <> 'active' THEN :t ELSE archived_at END,
           version = version + 1, updated_at = :t
         WHERE id = :id`,
        {
          id, title: c.title, content: c.content, summary: c.summary, category: c.category, tags: JSON.stringify(c.tags), pid: projectId ?? null,
          imp: importance, conf: confidence, ver: patch.verification ?? (ctx.actor === "user" && changesText ? "user_confirmed" : before.verification),
          status, ts: c.category === "task" ? (patch.task_state ?? before.task_state ?? "open") : null, flags: JSON.stringify(flags),
          lock: ctx.actor === "user" && changesText ? 1 : 0, t,
        },
      );
      const after = this.requireMemory(id);
      this.snapshot(after, ctx.actor, changeType, ctx.reason);
      if (after.title !== before.title || after.content !== before.content || after.summary !== before.summary || after.tags.join() !== before.tags.join())
        this.embedLocal(id, after);
      if (projectId && projectId !== before.project_id) this.attachToProject(after, projectId, ctx);
      if (opts.recordEvent !== false) {
        this.recordEvent({
          kind: changeType === "update" ? "updated" : changeType, actor: ctx.actor, task_id: ctx.task_id, memory_id: id, project_id: after.project_id,
          description: describeChange(changeType, after), reason: ctx.reason,
          undo: { op: "restore_version", memory_id: id, version: before.version },
        });
      }
      return after;
    });
  }

  appendMemory(id: string, addition: string, ctx: ChangeContext, opts: { recordEvent?: boolean; heading?: string } = {}): Memory {
    const before = this.requireMemory(id);
    const add = sanitizeText(addition, "content", LIMITS.content, { redact: this.settings.get("privacy.redactSecrets"), flagInjection: false }).text;
    if (!add) throw new MothError("invalid_input", "content to append must not be empty");
    if (before.content.includes(add)) return before; // idempotent
    const date = new Date().toISOString().slice(0, 10);
    const heading = opts.heading ?? `Update ${date}`;
    const content = `${before.content}\n\n**${heading}** — ${add}`;
    if (content.length > LIMITS.content) throw new MothError("invalid_input", "memory would become too long; create a new related memory instead");
    // Appending is always allowed, even on user-locked memories: it never overwrites their words.
    return this.updateMemory(id, { content }, ctx, { changeType: "appended", recordEvent: opts.recordEvent, force: true });
  }

  setStatus(id: string, status: Memory["status"], ctx: ChangeContext, extra: { merged_into?: string; superseded_by?: string } = {}, recordEvent = true): Memory {
    const before = this.requireMemory(id);
    if (before.status === status && !extra.merged_into && !extra.superseded_by) return before;
    return this.db.tx(() => {
      const t = nowIso();
      this.db.run(
        `UPDATE memories SET status = ?, archived_at = ?, merged_into = COALESCE(?, CASE WHEN ? = 'active' THEN NULL ELSE merged_into END),
           superseded_by = COALESCE(?, CASE WHEN ? = 'active' THEN NULL ELSE superseded_by END), version = version + 1, updated_at = ? WHERE id = ?`,
        [status, status === "active" ? null : t, extra.merged_into ?? null, status, extra.superseded_by ?? null, status, t, id],
      );
      const after = this.requireMemory(id);
      this.snapshot(after, ctx.actor, status === "active" ? "restored" : status, ctx.reason);
      if (recordEvent) {
        const kind = status === "active" ? "restored" : status;
        this.recordEvent({
          kind, actor: ctx.actor, task_id: ctx.task_id, memory_id: id, project_id: after.project_id,
          description: status === "active" ? `Restored "${after.title}"` : `${cap(status)} "${after.title}"`,
          reason: ctx.reason, undo: { op: "set_status", memory_id: id, status: before.status },
        });
      }
      return after;
    });
  }

  archive(id: string, ctx: ChangeContext): Memory {
    return this.setStatus(id, "archived", ctx);
  }

  unarchive(id: string, ctx: ChangeContext): Memory {
    return this.setStatus(id, "active", ctx);
  }

  /** Permanently deletes a memory. Only ever called for explicit user requests or permitted policies. */
  deletePermanently(id: string, ctx: ChangeContext): { id: string; title: string } {
    const m = this.requireMemory(id);
    this.db.tx(() => {
      this.db.run("DELETE FROM memories WHERE id = ?", [id]);
      this.db.run("UPDATE projects SET hub_memory_id = NULL WHERE hub_memory_id = ?", [id]);
      this.recordEvent({
        kind: "removed", actor: ctx.actor, task_id: ctx.task_id, memory_id: null, project_id: m.project_id,
        description: `Permanently deleted "${m.title}"`, reason: ctx.reason, undo: null,
      });
    });
    return { id, title: m.title };
  }

  supersede(oldId: string, newId_: string, ctx: ChangeContext): void {
    const oldM = this.requireMemory(oldId);
    const newM = this.requireMemory(newId_);
    this.db.tx(() => {
      const rel = this.link(newM.id, oldM.id, "SUPERSEDES", ctx.reason || "Newer information replaces this memory", ctx, { recordEvent: false, strength: 0.9 });
      this.setStatus(oldId, "superseded", ctx, { superseded_by: newM.id }, false);
      this.recordEvent({
        kind: "superseded", actor: ctx.actor, task_id: ctx.task_id, memory_id: oldId, related_memory_id: newM.id, relationship_id: rel.id, project_id: oldM.project_id,
        description: `"${newM.title}" supersedes "${oldM.title}"`, reason: ctx.reason,
        undo: { op: "unsupersede", memory_id: oldId, relationship_id: rel.id },
      });
    });
  }

  merge(targetId: string, sourceIds: string[], ctx: ChangeContext, opts: { content?: string; title?: string } = {}): Memory {
    const target = this.requireMemory(targetId);
    const sources = uniq(sourceIds).filter((s) => s !== targetId).map((s) => this.requireMemory(s));
    if (!sources.length) throw new MothError("invalid_input", "merge needs at least one other memory");
    for (const s of sources) if (s.status === "merged") throw new MothError("invalid_input", `"${s.title}" was already merged`);
    return this.db.tx(() => {
      const beforeVersion = target.version;
      let content = opts.content;
      if (!content) {
        content = target.content;
        for (const s of sources) {
          const extra = s.content.split(/\n{2,}/).filter((para) => !content!.includes(para.trim())).join("\n\n");
          if (extra.trim()) content += `\n\n**Merged from "${s.title}"** — ${extra.trim()}`;
        }
      }
      const tags = uniq([...target.tags, ...sources.flatMap((s) => s.tags)]).slice(0, LIMITS.tags);
      const importance = Math.max(target.importance, ...sources.map((s) => s.importance));
      const confidence = Math.min(1, Math.max(target.confidence, ...sources.map((s) => s.confidence)) + 0.03);
      const merged = this.updateMemory(targetId, { content, title: opts.title ?? target.title, tags, importance, confidence }, ctx, { changeType: "merged", recordEvent: false, force: true });
      // Re-point every relationship of the merged memories to the target (copies; originals stay for history).
      const createdRels: string[] = [];
      for (const s of sources) {
        const rels = this.db.all<Row>("SELECT * FROM memory_relationships WHERE source_id = ? OR target_id = ?", [s.id, s.id]);
        for (const r of rels) {
          const src = r.source_id === s.id ? targetId : (r.source_id as string);
          const dst = r.target_id === s.id ? targetId : (r.target_id as string);
          if (src === dst || sources.some((x) => x.id === src || x.id === dst)) continue;
          const exists = this.db.value("SELECT 1 FROM memory_relationships WHERE source_id = ? AND target_id = ? AND type = ?", [src, dst, r.type]);
          if (exists) continue;
          const rel = this.link(src, dst, r.type as RelationType, `${r.reason} (carried over from merged memory "${s.title}")`, ctx, { recordEvent: false, strength: Number(r.strength) });
          createdRels.push(rel.id);
        }
        this.setStatus(s.id, "merged", ctx, { merged_into: targetId }, false);
        this.db.run("INSERT OR IGNORE INTO project_memories(project_id, memory_id, role, added_at) SELECT project_id, ?, 'member', ? FROM project_memories WHERE memory_id = ?", [targetId, nowIso(), s.id]);
      }
      this.recordEvent({
        kind: "merged", actor: ctx.actor, task_id: ctx.task_id, memory_id: targetId, project_id: merged.project_id,
        description: `Merged ${sources.map((s) => `"${s.title}"`).join(", ")} into "${merged.title}"`, reason: ctx.reason,
        undo: { op: "unmerge", target_id: targetId, version: beforeVersion, source_ids: sources.map((s) => s.id), relationship_ids: createdRels },
      });
      return this.requireMemory(targetId);
    });
  }

  // ---------------------------------------------------------------- versions
  versions(id: string): Row[] {
    this.requireMemory(id);
    return this.db.all("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC", [id]).map((r) => ({ ...r, tags: safeJson(r.tags as string, []) }));
  }

  restoreVersion(id: string, version: number, ctx: ChangeContext, recordEvent = true): Memory {
    const v = this.db.get<Row>("SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?", [id, version]);
    if (!v) throw new MothError("not_found", `Memory ${id} has no version ${version}`);
    const restored = this.updateMemory(
      id,
      {
        title: v.title as string, content: v.content as string, summary: v.summary as string, category: v.category as Category,
        tags: safeJson(v.tags as string, []), importance: Number(v.importance), confidence: Number(v.confidence),
        project_id: (v.project_id as string) ?? null, status: v.status as Memory["status"],
      },
      ctx,
      { changeType: "restored_version", recordEvent, force: true },
    );
    return restored;
  }

  // ---------------------------------------------------------------- relationships
  link(sourceId: string, targetId: string, type: RelationType, reason: string, ctx: ChangeContext, opts: { strength?: number; recordEvent?: boolean } = {}): Relationship {
    if (!RELATION_TYPES.includes(type)) throw new MothError("invalid_input", `type must be one of ${RELATION_TYPES.join(", ")}`);
    if (sourceId === targetId) throw new MothError("invalid_input", "a memory cannot be linked to itself");
    const why = (reason ?? "").trim();
    if (why.length < 3) throw new MothError("invalid_input", "every relationship needs a reason explaining why the memories are connected");
    const a = this.requireMemory(sourceId);
    const b = this.requireMemory(targetId);
    const existing = this.db.get<Row>("SELECT * FROM memory_relationships WHERE source_id = ? AND target_id = ? AND type = ?", [sourceId, targetId, type]);
    if (existing) return existing as unknown as Relationship;
    const id = newId("rel");
    this.db.run(
      "INSERT INTO memory_relationships(id, user_id, source_id, target_id, type, reason, strength, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, this.userId, sourceId, targetId, type, why.slice(0, 500), clampNum(opts.strength, 0.5), ctx.actor, nowIso()],
    );
    if (opts.recordEvent !== false) {
      this.recordEvent({
        kind: "linked", actor: ctx.actor, task_id: ctx.task_id, memory_id: sourceId, related_memory_id: targetId, relationship_id: id, project_id: a.project_id ?? b.project_id,
        description: `Connected "${a.title}" ${type.replace("_", " ").toLowerCase()} "${b.title}"`, reason: why, undo: { op: "unlink", relationship_id: id },
      });
    }
    return this.db.get<Relationship>("SELECT * FROM memory_relationships WHERE id = ?", [id]) as Relationship;
  }

  unlink(relId: string, ctx: ChangeContext, recordEvent = true): void {
    const r = this.db.get<Row>("SELECT * FROM memory_relationships WHERE id = ? AND user_id = ?", [relId, this.userId]);
    if (!r) throw new MothError("not_found", `No relationship ${relId}`);
    this.db.tx(() => {
      this.db.run("DELETE FROM memory_relationships WHERE id = ?", [relId]);
      if (recordEvent)
        this.recordEvent({
          kind: "unlinked", actor: ctx.actor, task_id: ctx.task_id, memory_id: r.source_id as string, related_memory_id: r.target_id as string,
          description: `Removed ${r.type} connection`, reason: ctx.reason, undo: { op: "relink", rel: r },
        });
    });
  }

  relationshipsOf(id: string): (Relationship & { other_id: string; direction: "out" | "in" })[] {
    return this.db
      .all<Row>("SELECT * FROM memory_relationships WHERE source_id = ? OR target_id = ? ORDER BY strength DESC", [id, id])
      .map((r) => ({ ...(r as unknown as Relationship), other_id: (r.source_id === id ? r.target_id : r.source_id) as string, direction: r.source_id === id ? "out" : "in" }));
  }

  /** Breadth-first neighbourhood up to `depth` hops (active memories only unless includeInactive). */
  neighbourhood(id: string, depth = 1, includeInactive = false): { ids: string[]; edges: Relationship[]; hops: Map<string, number> } {
    const hops = new Map<string, number>([[id, 0]]);
    const edges = new Map<string, Relationship>();
    let frontier = [id];
    for (let d = 1; d <= Math.min(depth, 4); d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const r of this.db.all<Row>(
          `SELECT r.* FROM memory_relationships r JOIN memories ms ON ms.id = r.source_id JOIN memories mt ON mt.id = r.target_id
           WHERE (r.source_id = ? OR r.target_id = ?) ${includeInactive ? "" : "AND ms.status = 'active' AND mt.status = 'active'"}`,
          [cur, cur],
        )) {
          edges.set(r.id as string, r as unknown as Relationship);
          const other = (r.source_id === cur ? r.target_id : r.source_id) as string;
          if (!hops.has(other)) {
            hops.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { ids: [...hops.keys()], edges: [...edges.values()], hops };
  }

  // ---------------------------------------------------------------- projects
  listProjects(includeArchived = false): Project[] {
    return this.db
      .all(`SELECT * FROM projects WHERE user_id = ? ${includeArchived ? "" : "AND archived = 0"} ORDER BY COALESCE(last_activity_at, updated_at) DESC`, [this.userId])
      .map((r) => this.toProject(r));
  }

  getProject(idOrName: string): Project | null {
    if (!idOrName) return null;
    const uid = this.userId;
    const r =
      this.db.get("SELECT * FROM projects WHERE user_id = ? AND id = ?", [uid, idOrName]) ??
      this.db.get("SELECT * FROM projects WHERE user_id = ? AND slug = ?", [uid, slugify(idOrName)]) ??
      this.db.get("SELECT * FROM projects WHERE user_id = ? AND name = ? COLLATE NOCASE", [uid, idOrName]) ??
      this.db.get("SELECT p.* FROM projects p, json_each(p.aliases) a WHERE p.user_id = ? AND lower(a.value) = lower(?)", [uid, idOrName]);
    return r ? this.toProject(r) : null;
  }

  requireProject(idOrName: string): Project {
    const p = this.getProject(idOrName);
    if (!p) throw new MothError("not_found", `No project named or with id "${idOrName}"`);
    return p;
  }

  createProject(input: { name: string; description?: string; goals?: string; status?: string; aliases?: string[]; is_demo?: boolean }, ctx: ChangeContext): Project {
    const name = sanitizeText(input.name, "project name", 120, { redact: false, flagInjection: false }).text.replace(/\n/g, " ");
    if (!name) throw new MothError("invalid_input", "project name is required");
    const existing = this.getProject(name);
    if (existing) return existing;
    let slug = slugify(name);
    if (this.db.value("SELECT 1 FROM projects WHERE user_id = ? AND slug = ?", [this.userId, slug])) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
    const id = newId("prj");
    const t = nowIso();
    return this.db.tx(() => {
      this.db.run(
        `INSERT INTO projects(id, user_id, name, slug, aliases, description, goals, status, created_at, updated_at, last_activity_at, is_demo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, this.userId, name, slug, JSON.stringify(sanitizeTags(input.aliases ?? []).map((a) => a.replace(/-/g, " "))), input.description ?? "", input.goals ?? "", input.status ?? "", t, t, t, input.is_demo ? 1 : 0],
      );
      const hubContent = [input.description || `Project "${name}".`, input.goals ? `Goals: ${input.goals}` : "", input.status ? `Current state: ${input.status}` : ""]
        .filter(Boolean)
        .join("\n\n");
      const hub = this.createMemory(
        { title: name, content: hubContent, category: "project", project_id: id, importance: 0.9, tags: ["project"], is_demo: input.is_demo },
        ctx,
        { recordEvent: false },
      );
      this.db.run("UPDATE projects SET hub_memory_id = ? WHERE id = ?", [hub.id, id]);
      this.recordEvent({ kind: "project_created", actor: ctx.actor, task_id: ctx.task_id, memory_id: hub.id, project_id: id, description: `Started tracking project "${name}"`, reason: ctx.reason, undo: { op: "archive", memory_id: hub.id } });
      return this.requireProject(id);
    });
  }

  updateProject(id: string, patch: Partial<Pick<Project, "name" | "description" | "goals" | "status" | "aliases" | "files" | "archived">>, ctx: ChangeContext): Project {
    const p = this.requireProject(id);
    const next = { ...p, ...patch };
    const t = nowIso();
    this.db.tx(() => {
      this.db.run(
        "UPDATE projects SET name=?, description=?, goals=?, status=?, aliases=?, files=?, archived=?, updated_at=?, last_activity_at=? WHERE id=?",
        [next.name, next.description, next.goals, next.status, JSON.stringify(next.aliases), JSON.stringify(uniq(next.files).slice(-200)), next.archived ? 1 : 0, t, t, p.id],
      );
      if (p.hub_memory_id && (patch.description !== undefined || patch.goals !== undefined || patch.status !== undefined || patch.name !== undefined)) {
        const content = [next.description || `Project "${next.name}".`, next.goals ? `Goals: ${next.goals}` : "", next.status ? `Current state: ${next.status}` : ""].filter(Boolean).join("\n\n");
        const hub = this.getMemory(p.hub_memory_id);
        // Keep the progress log (and anything appended) below the regenerated header.
        const cut = hub ? hub.content.search(/\n\n\*\*(Progress|Update|Merged from) /) : -1;
        const full = hub && cut >= 0 ? content + hub.content.slice(cut) : content;
        if (hub && hub.content !== full) this.updateMemory(p.hub_memory_id, { title: next.name, content: full }, ctx, { changeType: "project_updated", recordEvent: false, force: true });
      }
      this.recordEvent({ kind: "project_updated", actor: ctx.actor, task_id: ctx.task_id, memory_id: p.hub_memory_id, project_id: p.id, description: `Updated project "${next.name}"`, reason: ctx.reason, undo: null });
    });
    return this.requireProject(p.id);
  }

  // ---------------------------------------------------------------- events & activity
  recordEvent(e: RecordEventInput): number {
    const r = this.db.run(
      `INSERT INTO learning_events(user_id, task_id, kind, memory_id, related_memory_id, relationship_id, project_id, description, reason, actor, undo, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [this.userId, e.task_id ?? null, e.kind, e.memory_id ?? null, e.related_memory_id ?? null, e.relationship_id ?? null, e.project_id ?? null, e.description.slice(0, 500), (e.reason || "—").slice(0, 1000), e.actor, e.undo ? JSON.stringify(e.undo) : null, nowIso()],
    );
    return r.lastInsertRowid;
  }

  listEvents(f: { limit?: number; since?: string; until?: string; memory_id?: string; project_id?: string; kinds?: string[]; before_id?: number } = {}): Row[] {
    const where = ["user_id = :uid"];
    const p: Record<string, unknown> = { uid: this.userId };
    if (f.since) { where.push("created_at >= :since"); p.since = f.since; }
    if (f.until) { where.push("created_at <= :until"); p.until = f.until; }
    if (f.memory_id) { where.push("(memory_id = :mid OR related_memory_id = :mid)"); p.mid = f.memory_id; }
    if (f.project_id) { where.push("project_id = :pid"); p.pid = f.project_id; }
    if (f.before_id) { where.push("id < :bid"); p.bid = f.before_id; }
    if (f.kinds?.length) where.push(`kind IN (${f.kinds.map((k) => `'${k.replace(/[^a-z_]/g, "")}'`).join(",")})`);
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    return this.db.all(`SELECT * FROM learning_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`, p).map((r) => ({ ...r, undo: safeJson(r.undo as string, null), reverted: !!r.reverted }));
  }

  /** Reverses an automatic or manual change using the undo recipe stored with its event. */
  revertEvent(eventId: number, ctx: ChangeContext): { reverted: number; description: string } {
    const e = this.db.get<Row>("SELECT * FROM learning_events WHERE id = ? AND user_id = ?", [eventId, this.userId]);
    if (!e) throw new MothError("not_found", `No learning event ${eventId}`);
    if (e.reverted) throw new MothError("invalid_input", "This change was already reverted");
    const undo = safeJson<Record<string, any> | null>(e.undo as string, null);
    if (!undo) throw new MothError("invalid_input", "This change cannot be reverted automatically");
    const c: ChangeContext = { ...ctx, reason: `Reverted: ${e.description}` };
    this.db.tx(() => {
      switch (undo.op) {
        case "archive":
          if (this.getMemory(undo.memory_id)) this.setStatus(undo.memory_id, "archived", c, {}, false);
          break;
        case "restore_version":
          this.restoreVersion(undo.memory_id, undo.version, c, false);
          break;
        case "set_status":
          this.setStatus(undo.memory_id, undo.status, c, {}, false);
          break;
        case "unlink":
          if (this.db.value("SELECT 1 FROM memory_relationships WHERE id = ?", [undo.relationship_id])) this.unlink(undo.relationship_id, c, false);
          break;
        case "relink": {
          const r = undo.rel;
          if (this.getMemory(r.source_id) && this.getMemory(r.target_id)) this.link(r.source_id, r.target_id, r.type, r.reason, c, { strength: r.strength, recordEvent: false });
          break;
        }
        case "unsupersede":
          if (this.db.value("SELECT 1 FROM memory_relationships WHERE id = ?", [undo.relationship_id])) this.unlink(undo.relationship_id, c, false);
          this.setStatus(undo.memory_id, "active", c, {}, false);
          break;
        case "unmerge":
          for (const rid of undo.relationship_ids ?? []) if (this.db.value("SELECT 1 FROM memory_relationships WHERE id = ?", [rid])) this.unlink(rid, c, false);
          for (const sid of undo.source_ids ?? []) if (this.getMemory(sid)) this.setStatus(sid, "active", c, {}, false);
          this.restoreVersion(undo.target_id, undo.version, c, false);
          break;
        case "task_state":
          this.updateMemory(undo.memory_id, { task_state: undo.state }, c, { changeType: "task_reopened", recordEvent: false, force: true });
          break;
        case "unflag":
          this.db.run("UPDATE memories SET flags = (SELECT json_group_array(value) FROM json_each(memories.flags) WHERE value <> ?), verification = COALESCE(?, verification) WHERE id = ?", [undo.flag, undo.verification ?? null, undo.memory_id]);
          if (undo.memory_id_2) this.db.run("UPDATE memories SET flags = (SELECT json_group_array(value) FROM json_each(memories.flags) WHERE value <> ?), verification = COALESCE(?, verification) WHERE id = ?", [undo.flag, undo.verification_2 ?? null, undo.memory_id_2]);
          break;
        default:
          throw new MothError("invalid_input", `Unknown undo operation ${undo.op}`);
      }
      this.db.run("UPDATE learning_events SET reverted = 1 WHERE id = ?", [eventId]);
      this.recordEvent({ kind: "reverted", actor: ctx.actor, memory_id: e.memory_id as string, related_memory_id: e.related_memory_id as string, project_id: e.project_id as string, description: `Reverted: ${e.description}`, reason: ctx.reason || "User reversed an earlier change", undo: null });
    });
    return { reverted: eventId, description: e.description as string };
  }

  logActivity(a: { kind: string; source: string; action: string; detail?: unknown; status?: "ok" | "error"; duration_ms?: number }): void {
    try {
      this.db.run("INSERT INTO activity_logs(user_id, kind, source, action, detail, status, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)", [
        this.userId, a.kind, a.source.slice(0, 120), a.action.slice(0, 120), JSON.stringify(a.detail ?? {}).slice(0, 8000), a.status ?? "ok", a.duration_ms ?? null, nowIso(),
      ]);
    } catch {
      /* activity logging must never break the operation it describes */
    }
  }

  listActivity(f: { limit?: number; kind?: string; before_id?: number } = {}): Row[] {
    const where = ["(user_id = ? OR user_id IS NULL)"];
    const p: unknown[] = [this.userId];
    if (f.kind) { where.push("kind = ?"); p.push(f.kind); }
    if (f.before_id) { where.push("id < ?"); p.push(f.before_id); }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    return this.db.all(`SELECT * FROM activity_logs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`, p).map((r) => ({ ...r, detail: safeJson(r.detail as string, {}) }));
  }

  // ---------------------------------------------------------------- tasks (Claude work sessions)
  beginTask(description: string, projectId: string | null, client: string | null, contextIds: string[]): string {
    const id = newId("tsk");
    this.db.run("INSERT INTO tasks(id, user_id, description, project_id, status, client, context_memory_ids, started_at) VALUES (?,?,?,?,?,?,?,?)", [
      id, this.userId, description.slice(0, 2000), projectId, "active", client, JSON.stringify(contextIds), nowIso(),
    ]);
    return id;
  }

  getTask(id: string): Row | undefined {
    return this.db.get("SELECT * FROM tasks WHERE id = ? AND user_id = ?", [id, this.userId]);
  }

  endTask(id: string, status: "completed" | "abandoned", outcome: string | null): Row {
    const t = this.getTask(id);
    if (!t) throw new MothError("not_found", `No task ${id}`);
    this.db.run("UPDATE tasks SET status = ?, outcome = ?, ended_at = ? WHERE id = ?", [status, outcome, nowIso(), id]);
    return this.getTask(id) as Row;
  }

  keywordsFor(m: Pick<Memory, "title" | "content">): string[] {
    return keywords(`${m.title} ${m.title} ${m.content}`, 6);
  }
}

export function embeddingText(m: { title: string; content: string; summary?: string; tags?: string[] }): string {
  return `${m.title}\n${m.title}\n${(m.tags ?? []).join(" ")}\n${m.content}`.slice(0, 8000);
}

function describeChange(type: string, m: Memory): string {
  switch (type) {
    case "appended": return `Added new information to "${m.title}"`;
    case "merged": return `Merged knowledge into "${m.title}"`;
    case "restored_version": return `Restored an earlier version of "${m.title}"`;
    case "summary_improved": return `Improved the summary of "${m.title}"`;
    case "task_completed": return `Marked task "${m.title}" as done`;
    case "reinforced": return `Confirmed "${m.title}" again`;
    default: return `Updated "${m.title}"`;
  }
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function clampNum(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
