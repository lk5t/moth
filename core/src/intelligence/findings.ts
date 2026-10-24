// Findings: the single store for everything MOTH's intelligence produces (awareness, knowledge health,
// discoveries, agent recommendations). Every finding carries its provenance: supporting memory ids (validated to
// exist), projects, source references, the algorithm or model that produced it, when, how strong the evidence is,
// and its review status.
//
// Identity and suppression:
//  - fingerprint = what the finding is about (kind + category + stable parts, e.g. the memory ids involved).
//  - evidence_hash = the exact state of the evidence (memory ids @ version + key facts).
//  - Only one active (new/viewed) finding per fingerprint. A dismissed or resolved finding is not raised again
//    unless its evidence changed materially (different evidence_hash). Confirmed findings are never re-raised.
import crypto from "node:crypto";
import type { Database, Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import { safeJson, type MemoryStore } from "../engine/store.ts";
import { MothError } from "../engine/types.ts";

export type FindingKind = "awareness" | "health" | "discovery" | "agent";
export type FindingStatus = "new" | "viewed" | "dismissed" | "resolved" | "superseded" | "confirmed";

export interface Evidence {
  memory_id?: string;
  project_id?: string;
  source_ref?: string;
  quote?: string;
  note: string;
}

export interface FindingInput {
  kind: FindingKind;
  category: string;
  /** Stable parts that identify what this finding is about (order doesn't matter). */
  key: string[];
  /** Extra facts that, when they change, make a dismissed finding worth showing again. */
  evidenceKey?: string[];
  title: string;
  description: string;
  project_id?: string | null;
  project_ids?: string[];
  memory_ids: string[];
  evidence: Evidence[];
  source_refs?: string[];
  algorithm: string;
  model?: string | null;
  confidence?: number | null;
  evidence_status: "confirmed" | "possible";
  severity?: "info" | "low" | "medium" | "high";
  suggested_action?: string;
  action?: Record<string, unknown> | null;
  job_id?: number | null;
  agent?: string | null;
}

export interface UpsertResult {
  id: number | null;
  outcome: "created" | "updated" | "unchanged" | "suppressed" | "rejected";
  reason?: string;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);

export class Findings {
  constructor(
    private db: Database,
    private store: MemoryStore,
  ) {}

  fingerprint(kind: string, category: string, key: string[]): string {
    return sha(`${kind}|${category}|${[...key].sort().join("|")}`);
  }

  /** Evidence state: each memory's id@version (so edits count as a material change) + extra facts. */
  evidenceHash(memoryIds: string[], extra: string[] = []): string {
    const parts = [...new Set(memoryIds)].sort().map((id) => {
      const v = this.db.value<number>("SELECT version FROM memories WHERE id = ?", [id]);
      return `${id}@${v ?? "gone"}`;
    });
    return sha([...parts, "|", ...extra.map(String).sort()].join(","));
  }

  /**
   * Validates and stores a finding. Rejects findings whose evidence doesn't exist (no invented support).
   * Never creates a duplicate active finding; respects earlier dismissals unless the evidence changed.
   */
  upsert(input: FindingInput): UpsertResult {
    const uid = this.store.userId;
    // Provenance check: every referenced memory must exist and belong to this user.
    const ids = [...new Set(input.memory_ids.filter((x) => typeof x === "string" && x.length > 2))];
    const existing = ids.length ? this.db.all<Row>(`SELECT id, project_id FROM memories WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, [uid, ...ids]) : [];
    const known = new Set(existing.map((r) => r.id as string));
    const missing = ids.filter((x) => !known.has(x));
    if (missing.length) return { id: null, outcome: "rejected", reason: `Evidence refers to memories that don't exist: ${missing.slice(0, 3).join(", ")}` };
    if (!ids.length && !(input.project_id || input.project_ids?.length)) return { id: null, outcome: "rejected", reason: "A finding needs supporting memories or a project" };
    const projIds = [...new Set([...(input.project_ids ?? []), ...(input.project_id ? [input.project_id] : [])])];
    for (const p of projIds) if (!this.db.value("SELECT 1 FROM projects WHERE id = ? AND user_id = ?", [p, uid])) return { id: null, outcome: "rejected", reason: `Unknown project ${p}` };
    const evidence = input.evidence.filter((e) => !e.memory_id || known.has(e.memory_id)).slice(0, 20).map((e) => ({ ...e, quote: e.quote?.slice(0, 400), note: String(e.note ?? "").slice(0, 400) }));

    const fp = this.fingerprint(input.kind, input.category, input.key);
    const eh = this.evidenceHash(ids, input.evidenceKey ?? []);
    const t = nowIso();
    const active = this.db.get<Row>("SELECT * FROM findings WHERE user_id = ? AND kind = ? AND fingerprint = ? AND status IN ('new','viewed')", [uid, input.kind, fp]);
    if (active) {
      if (active.evidence_hash === eh) {
        this.db.run("UPDATE findings SET analyzed_at = ? WHERE id = ?", [t, active.id]);
        return { id: Number(active.id), outcome: "unchanged" };
      }
      this.db.run(
        `UPDATE findings SET evidence_hash = ?, title = ?, description = ?, memory_ids = ?, evidence = ?, source_refs = ?, confidence = ?, evidence_status = ?, severity = ?,
           suggested_action = ?, action = ?, algorithm = ?, model = ?, analyzed_at = ?, updated_at = ?, job_id = COALESCE(?, job_id) WHERE id = ?`,
        [eh, input.title.slice(0, 200), input.description.slice(0, 2000), JSON.stringify(ids), JSON.stringify(evidence), JSON.stringify(input.source_refs ?? []), input.confidence ?? null, input.evidence_status, input.severity ?? "info", (input.suggested_action ?? "").slice(0, 400), input.action ? JSON.stringify(input.action) : null, input.algorithm, input.model ?? null, t, t, input.job_id ?? null, active.id],
      );
      return { id: Number(active.id), outcome: "updated" };
    }
    const last = this.db.get<Row>("SELECT * FROM findings WHERE user_id = ? AND kind = ? AND fingerprint = ? ORDER BY id DESC LIMIT 1", [uid, input.kind, fp]);
    if (last) {
      if (last.status === "confirmed") return { id: Number(last.id), outcome: "suppressed", reason: "Already confirmed" };
      if ((last.status === "dismissed" || last.status === "resolved") && last.evidence_hash === eh) return { id: Number(last.id), outcome: "suppressed", reason: `Previously ${last.status} and nothing changed since` };
    }
    const r = this.db.run(
      `INSERT INTO findings(user_id, kind, category, fingerprint, evidence_hash, title, description, project_id, project_ids, memory_ids, evidence, source_refs, algorithm, model,
         confidence, evidence_status, severity, suggested_action, action, status, job_id, agent, created_at, updated_at, analyzed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?,?,?)`,
      [uid, input.kind, input.category, fp, eh, input.title.slice(0, 200), input.description.slice(0, 2000), input.project_id ?? projIds[0] ?? null, JSON.stringify(projIds), JSON.stringify(ids), JSON.stringify(evidence), JSON.stringify(input.source_refs ?? []), input.algorithm, input.model ?? null, input.confidence ?? null, input.evidence_status, input.severity ?? "info", (input.suggested_action ?? "").slice(0, 400), input.action ? JSON.stringify(input.action) : null, input.job_id ?? null, input.agent ?? null, t, t, t],
    );
    return { id: r.lastInsertRowid, outcome: "created" };
  }

  /**
   * After a complete scan of (kind, categories): active findings that were not detected again are resolved,
   * with the reason recorded. Only call this for categories the scan fully evaluated.
   */
  reconcile(kind: FindingKind, categories: string[], stillPresent: Set<number>, why = "No longer detected"): number {
    if (!categories.length) return 0;
    const rows = this.db.all<Row>(
      `SELECT id FROM findings WHERE user_id = ? AND kind = ? AND status IN ('new','viewed') AND category IN (${categories.map(() => "?").join(",")})`,
      [this.store.userId, kind, ...categories],
    );
    let n = 0;
    const t = nowIso();
    for (const r of rows) {
      if (stillPresent.has(Number(r.id))) continue;
      this.db.run("UPDATE findings SET status = 'resolved', resolution = ?, decided_at = ?, updated_at = ? WHERE id = ?", [why, t, t, r.id]);
      n++;
    }
    return n;
  }

  get(id: number): Row {
    const r = this.db.get<Row>("SELECT * FROM findings WHERE id = ? AND user_id = ?", [id, this.store.userId]);
    if (!r) throw new MothError("not_found", `No finding ${id}`);
    return this.expand(r);
  }

  private expand(r: Row): Row {
    const memory_ids = safeJson<string[]>(r.memory_ids as string, []);
    const project_ids = safeJson<string[]>(r.project_ids as string, []);
    const memories = memory_ids.length
      ? this.db.all<Row>(`SELECT id, title, category, project_id, status, version, updated_at FROM memories WHERE id IN (${memory_ids.map(() => "?").join(",")})`, memory_ids)
      : [];
    const projects = project_ids.length ? this.db.all<Row>(`SELECT id, name FROM projects WHERE id IN (${project_ids.map(() => "?").join(",")})`, project_ids) : [];
    return {
      ...r,
      memory_ids,
      project_ids,
      evidence: safeJson(r.evidence as string, []),
      source_refs: safeJson(r.source_refs as string, []),
      action: safeJson(r.action as string, null),
      memories,
      projects,
    };
  }

  list(f: { kind?: FindingKind; status?: FindingStatus | "active" | "all"; project_id?: string; category?: string; limit?: number } = {}): Row[] {
    const where = ["user_id = ?"];
    const p: unknown[] = [this.store.userId];
    if (f.kind) (where.push("kind = ?"), p.push(f.kind));
    const st = f.status ?? "active";
    if (st === "active") where.push("status IN ('new','viewed')");
    else if (st !== "all") (where.push("status = ?"), p.push(st));
    if (f.project_id) (where.push("(project_id = ? OR project_ids LIKE ?)"), p.push(f.project_id, `%"${f.project_id}"%`));
    if (f.category) (where.push("category = ?"), p.push(f.category));
    const order = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, COALESCE(confidence, 0) DESC, id DESC";
    return this.db.all<Row>(`SELECT * FROM findings WHERE ${where.join(" AND ")} ORDER BY ${st === "active" ? order : "id DESC"} LIMIT ?`, [...p, Math.min(500, f.limit ?? 100)]).map((r) => this.expand(r));
  }

  counts(): Row {
    const rows = this.db.all<Row>("SELECT kind, status, COUNT(*) AS n FROM findings WHERE user_id = ? GROUP BY kind, status", [this.store.userId]);
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) ((out[r.kind as string] ??= {})[r.status as string] = Number(r.n));
    return out;
  }

  private setStatus(id: number, status: FindingStatus, from: FindingStatus[], resolution?: string | null): Row {
    const f = this.get(id);
    if (!from.includes(f.status as FindingStatus)) throw new MothError("invalid_input", `This finding is already ${f.status}`);
    const t = nowIso();
    this.db.run("UPDATE findings SET status = ?, resolution = COALESCE(?, resolution), decided_at = ?, updated_at = ? WHERE id = ?", [status, resolution ?? null, t, t, id]);
    this.store.logActivity({ kind: "finding", source: "user", action: status, detail: { id, kind: f.kind, category: f.category, note: resolution ?? null } });
    return this.get(id);
  }

  markViewed(id: number): Row {
    const f = this.get(id);
    if (f.status === "new") this.db.run("UPDATE findings SET status = 'viewed', updated_at = ? WHERE id = ?", [nowIso(), id]);
    return this.get(id);
  }

  dismiss(id: number, note?: string): Row {
    return this.setStatus(id, "dismissed", ["new", "viewed"], note ? `Dismissed: ${note}` : "Dismissed by you");
  }

  resolve(id: number, note?: string): Row {
    return this.setStatus(id, "resolved", ["new", "viewed"], note ?? "Resolved by you");
  }

  confirm(id: number, note?: string): Row {
    return this.setStatus(id, "confirmed", ["new", "viewed"], note ?? "Confirmed by you");
  }

  supersede(id: number, by: number): Row {
    return this.setStatus(id, "superseded", ["new", "viewed"], `Replaced by finding ${by}`);
  }

  /** How the user has treated a category before (used to rank and quiet future suggestions). */
  feedbackFor(kind: FindingKind, category: string): { confirmed: number; dismissed: number } {
    const r = this.db.get<Row>(
      "SELECT SUM(status = 'confirmed') AS c, SUM(status = 'dismissed') AS d FROM findings WHERE user_id = ? AND kind = ? AND category = ?",
      [this.store.userId, kind, category],
    );
    return { confirmed: Number(r?.c ?? 0), dismissed: Number(r?.d ?? 0) };
  }
}
