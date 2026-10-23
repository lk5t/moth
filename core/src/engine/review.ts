// Unified Memory Inbox: one review queue for every risky change, whoever proposed it
// (Cortex comparisons, inferred preferences, research without sources, unverified lessons, ...).
// Approve / Reject / Edit / Defer. Approved changes are applied in one transaction.
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "./brain.ts";
import { safeJson } from "./store.ts";
import { truncate } from "./text.ts";
import { MothError } from "./types.ts";

export const INBOX_KINDS = ["cortex", "conflict", "duplicate", "merge", "preference", "research", "lesson", "correction", "other"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxItemInput {
  kind: InboxKind;
  operation: string;
  statement: string;
  reason: string;
  risk?: "low" | "medium" | "high";
  confidence?: number | null;
  target_memory_id?: string | null;
  affected_ids?: string[];
  sources?: { url?: string | null; title?: string }[];
  proposal?: Record<string, unknown>;
  source?: string | null;
  source_ref?: string | null;
  task_id?: string | null;
}

export type InboxHandler = {
  approve: (item: Row, edits: Record<string, string>) => { memory_id: string | null; note?: string };
  reject?: (item: Row, note?: string) => void;
};

export class ReviewInbox {
  private handlers = new Map<string, InboxHandler>();
  constructor(private brain: Brain) {}

  /** Handlers are looked up by the item's proposal.handler first, then by its kind. */
  register(kind: InboxKind | string, h: InboxHandler): void {
    this.handlers.set(kind, h);
  }

  add(i: InboxItemInput): number {
    // Same pending proposal twice is pointless: return the existing item.
    const dup = this.brain.db.value<number>(
      "SELECT id FROM review_queue WHERE user_id = ? AND status = 'pending' AND kind = ? AND operation = ? AND statement = ? AND COALESCE(target_memory_id,'') = COALESCE(?, '')",
      [this.brain.store.userId, i.kind, i.operation, truncate(i.statement, 4000), i.target_memory_id ?? null],
    );
    if (dup) return Number(dup);
    const r = this.brain.db.run(
      `INSERT INTO review_queue(user_id, status, kind, operation, target_memory_id, proposal, statement, relation, reason, risk, confidence, provider, model, source, source_ref, task_id, affected_ids, sources, created_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        this.brain.store.userId, i.kind, i.operation, i.target_memory_id ?? null, JSON.stringify(i.proposal ?? {}), truncate(i.statement, 4000), truncate(i.reason, 1000),
        i.risk ?? "medium", i.confidence ?? null, i.source ?? null, i.source_ref ?? null, i.task_id ?? null,
        JSON.stringify(i.affected_ids ?? (i.target_memory_id ? [i.target_memory_id] : [])), JSON.stringify(i.sources ?? []), nowIso(),
      ],
    );
    return r.lastInsertRowid;
  }

  list(f: { status?: string; kind?: string; include_deferred?: boolean; limit?: number } = {}): Row[] {
    const where = ["user_id = ?"];
    const p: unknown[] = [this.brain.store.userId];
    const status = f.status ?? "pending";
    if (status !== "all") (where.push("status = ?"), p.push(status));
    if (f.kind) (where.push("kind = ?"), p.push(f.kind));
    if (status === "pending" && !f.include_deferred) (where.push("(deferred_until IS NULL OR deferred_until <= ?)"), p.push(nowIso()));
    p.push(Math.min(Math.max(f.limit ?? 100, 1), 500));
    return this.brain.db.all<Row>(`SELECT * FROM review_queue WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, p).map((r) => this.expand(r));
  }

  get(id: number): Row {
    const r = this.brain.db.get<Row>("SELECT * FROM review_queue WHERE id = ? AND user_id = ?", [id, this.brain.store.userId]);
    if (!r) throw new MothError("not_found", `No review item ${id}`);
    return this.expand(r);
  }

  private expand(r: Row): Row {
    const affected = safeJson<string[]>(r.affected_ids as string, []);
    return {
      ...r,
      proposal: safeJson(r.proposal as string, {}),
      result: safeJson(r.result as string, null),
      sources: safeJson(r.sources as string, []),
      affected_ids: affected,
      affected: this.brain.store.getMany(affected).map((m) => ({ id: m.id, title: m.title, content: m.content, version: m.version, status: m.status, memory_type: m.memory_type })),
      target: r.target_memory_id ? this.brain.store.getMemory(r.target_memory_id as string) : null,
      deferred: !!(r.deferred_until && String(r.deferred_until) > nowIso()),
    };
  }

  private handlerFor(r: Row): InboxHandler | undefined {
    const name = (r.proposal as Record<string, unknown> | undefined)?.handler;
    if (typeof name === "string" && this.handlers.has(name)) return this.handlers.get(name);
    const kind = String(r.kind || "cortex");
    return ["cortex", "conflict", "duplicate", "merge"].includes(kind) ? undefined : this.handlers.get(kind);
  }

  counts(): Row {
    const uid = this.brain.store.userId;
    const t = nowIso();
    return {
      pending: Number(this.brain.db.value("SELECT COUNT(*) FROM review_queue WHERE user_id = ? AND status = 'pending' AND (deferred_until IS NULL OR deferred_until <= ?)", [uid, t]) ?? 0),
      deferred: Number(this.brain.db.value("SELECT COUNT(*) FROM review_queue WHERE user_id = ? AND status = 'pending' AND deferred_until > ?", [uid, t]) ?? 0),
      by_kind: this.brain.db.all("SELECT kind, COUNT(*) AS n FROM review_queue WHERE user_id = ? AND status = 'pending' GROUP BY kind", [uid]),
    };
  }

  defer(id: number, hours = 24): Row {
    const r = this.get(id);
    if (r.status !== "pending") throw new MothError("invalid_input", `This item was already ${r.status}`);
    const until = new Date(Date.now() + Math.max(1, Math.min(hours, 24 * 30)) * 3_600_000).toISOString();
    this.brain.db.run("UPDATE review_queue SET deferred_until = ? WHERE id = ?", [until, id]);
    return { id, deferred_until: until };
  }

  approve(id: number, edits: Record<string, string> = {}): Row {
    const r = this.get(id);
    if (r.status !== "pending") throw new MothError("invalid_input", `This item was already ${r.status}`);
    const kind = String(r.kind || "cortex");
    const h = this.handlerFor(r);
    if (!h && ["cortex", "conflict", "duplicate", "merge"].includes(kind)) return this.brain.cortex.approve(id, edits);
    if (!h) throw new MothError("invalid_input", `MOTH does not know how to apply "${kind}" items`);
    const clean = Object.fromEntries(Object.entries(edits).filter(([, v]) => typeof v === "string" && v.trim()));
    const res = this.brain.db.tx(() => {
      const out = h.approve(r, clean);
      this.brain.db.run("UPDATE review_queue SET status = 'applied', decided_at = ?, decided_by = 'user', result = ? WHERE id = ?", [nowIso(), JSON.stringify(out), id]);
      this.brain.cortex.recordFeedback({ subject_type: "review", subject_id: String(id), verdict: "correct", operation: r.operation as string, statement: r.statement as string, note: Object.keys(clean).length ? "approved with edits" : null });
      return out;
    });
    this.brain.store.logActivity({ kind: "review", source: "user", action: "approved", detail: { id, kind, memory_id: res.memory_id } });
    return { id, status: "applied", ...res };
  }

  reject(id: number, note?: string, verdict: "incorrect" | "irrelevant" | "keep_separate" = "incorrect"): Row {
    const r = this.get(id);
    const kind = String(r.kind || "cortex");
    const h = this.handlerFor(r);
    if (!h) return this.brain.cortex.reject(id, note, verdict);
    if (r.status !== "pending") throw new MothError("invalid_input", `This item was already ${r.status}`);
    this.brain.db.tx(() => {
      this.brain.db.run("UPDATE review_queue SET status = 'rejected', decided_at = ?, decided_by = 'user', result = ? WHERE id = ?", [nowIso(), JSON.stringify({ note: note ?? null }), id]);
      h.reject?.(r, note);
      this.brain.cortex.recordFeedback({ subject_type: "review", subject_id: String(id), verdict, operation: r.operation as string, statement: r.statement as string, note: note ?? null });
    });
    this.brain.store.logActivity({ kind: "review", source: "user", action: "rejected", detail: { id, kind } });
    return { id, status: "rejected" };
  }
}
