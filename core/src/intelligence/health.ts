// Knowledge Health: checks the quality of what MOTH knows and keeps an auditable record of problems.
//
// Every check is deterministic (plain code, no AI) and produces findings (kind "health") with the affected memories,
// an explanation, the evidence, severity, confidence and a recommended action. Confirmed problems (exact duplicates,
// broken links, a damaged search index) are told apart from possible ones (similar wording, possible conflicts,
// possibly outdated research).
//
// Repairs:
//  - Automatic only for derived data that can always be rebuilt from the memories themselves: the full-text search
//    index and the local similarity vectors. Each repair is logged (activity kind "health_repair").
//  - Everything else is a proposal in the review queue (merging duplicates, repointing links, replacing conflicting
//    information, …). Rejecting a proposal changes nothing and dismisses the finding.
//
// No single "health score": the dashboard shows counts per check with how each check works and its limits.
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { cosine } from "../engine/embeddings.ts";
import { embeddingText } from "../engine/store.ts";
import { hashText, truncate } from "../engine/text.ts";
import { MothError, type Memory } from "../engine/types.ts";
import type { FindingInput } from "./findings.ts";
import type { Subject } from "./permissions.ts";

export const HEALTH_CHECKS = {
  exact_duplicate: { label: "Exact duplicates", how: "Same title and text after ignoring case, spacing and punctuation.", certainty: "confirmed" },
  similar_duplicate: { label: "Possible duplicates", how: "Memories whose wording is very similar (word-based similarity ≥ 0.86 and shared keywords). Similar wording can still mean different things, so these are only suggestions.", certainty: "possible" },
  conflict: { label: "Possible conflicts", how: "Memories MOTH flagged as possibly contradicting another, and conflicts waiting in the review queue.", certainty: "possible" },
  missing_source: { label: "Research without sources", how: "Research memories with no source attached.", certainty: "confirmed" },
  unsupported_claim: { label: "Weakly supported claims", how: "Important facts or research marked speculative or with low confidence, and no source.", certainty: "possible" },
  broken_relationship: { label: "Broken connections", how: "Connections from a memory to itself, or to a memory that was merged into another or superseded.", certainty: "confirmed" },
  outdated_research: { label: "Possibly outdated research", how: "Research not updated for over a year, or whose sources were published more than two years ago. Age alone doesn't make it wrong.", certainty: "possible" },
  stale_project: { label: "Stale project context", how: "Projects with open blockers, decisions or tasks but no activity for 60 days.", certainty: "possible" },
  inconsistent_preference: { label: "Inconsistent preferences", how: "Active preferences in the same area with similar wording where one says the opposite (never/don't/avoid vs. always/do).", certainty: "possible" },
  search_index: { label: "Search index", how: "Checks the full-text search index against the memories. Repaired automatically (it's rebuilt from the memories).", certainty: "confirmed" },
  similarity_vectors: { label: "Similarity vectors", how: "Every memory needs an up-to-date local similarity vector for search and suggestions. Missing or outdated ones are recomputed automatically.", certainty: "confirmed" },
} as const;
export type HealthCheck = keyof typeof HEALTH_CHECKS;

const DAY = 86_400_000;
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const NEG = /\b(never|don['’]?t|do not|avoid|no|not|stop|without|dislike|hate)\b/i;
const POS = /\b(always|prefer|use|do|like|love|want)\b/i;

export interface HealthScanResult {
  checks: Record<string, { found: number; created: number; suppressed: number; resolved: number }>;
  repairs: Row[];
  skipped_projects: number;
  ms: number;
  complete: boolean;
}

export class KnowledgeHealth {
  constructor(private brain: Brain) {}

  private get db() {
    return this.brain.db;
  }
  private get uid() {
    return this.brain.store.userId;
  }

  registerHandlers(): void {
    // Approving a merge proposal from Knowledge Health merges for real; rejecting changes nothing.
    this.brain.inbox.register("health_merge", {
      approve: (item, edits) => {
        const p = item.proposal as Row;
        const target = String(p.target_id);
        const sources = (p.source_ids as string[]).filter((x) => x !== target);
        const live = this.brain.store.getMany([target, ...sources]).filter((m) => m.status === "active");
        if (live.length < 2) throw new MothError("invalid_input", "These memories changed since the proposal (one is no longer active). Run the health check again.");
        const merged = this.brain.store.merge(target, sources, { actor: "user", reason: "Duplicate merged after review (Knowledge Health)" }, { title: edits.title, content: edits.content });
        if (p.finding_id) this.safeStatus(Number(p.finding_id), "resolve", "Merged after your review");
        return { memory_id: merged.id, note: `Merged ${sources.length + 1} memories` };
      },
      reject: (item, note) => {
        const p = item.proposal as Row;
        if (p.finding_id) this.safeStatus(Number(p.finding_id), "dismiss", note ? `Merge rejected: ${note}` : "Merge rejected: keep them separate");
      },
    });
    this.brain.inbox.register("health_relink", {
      approve: (item) => {
        const p = item.proposal as Row;
        const rel = this.db.get<Row>("SELECT * FROM memory_relationships WHERE id = ? AND user_id = ?", [p.relationship_id, this.uid]);
        if (!rel) throw new MothError("invalid_input", "That connection no longer exists.");
        const ctx = { actor: "user" as const, reason: "Broken connection repaired after review (Knowledge Health)" };
        this.brain.store.unlink(rel.id as string, ctx);
        let newId: string | null = null;
        if (p.new_target && p.new_source && p.new_target !== p.new_source) newId = this.brain.store.link(String(p.new_source), String(p.new_target), rel.type as any, String(rel.reason || "Repointed after merge"), ctx).id;
        if (p.finding_id) this.safeStatus(Number(p.finding_id), "resolve", newId ? "Connection repointed" : "Connection removed");
        return { memory_id: null, note: newId ? "Connection repointed to the surviving memory" : "Connection removed" };
      },
      reject: (item, note) => {
        const p = item.proposal as Row;
        if (p.finding_id) this.safeStatus(Number(p.finding_id), "dismiss", note ?? "Kept as is");
      },
    });
  }

  private safeStatus(id: number, op: "resolve" | "dismiss", note: string) {
    try {
      if (op === "resolve") this.brain.findings.resolve(id, note);
      else this.brain.findings.dismiss(id, note);
    } catch {
      /* finding already closed */
    }
  }

  private active(): Memory[] {
    return this.db.all<Row>("SELECT * FROM memories WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC", [this.uid]).map((r) => this.brain.store.toMemory(r));
  }

  /**
   * Runs every check (or the given ones). `as` is who runs it (permission-checked); private projects are skipped for
   * automated subjects unless explicitly allowed. Cancellable through `signal`.
   */
  async scan(opts: { as?: Subject | string; checks?: HealthCheck[]; signal?: AbortSignal; jobId?: number | null; timeBudgetMs?: number } = {}): Promise<HealthScanResult> {
    const t0 = Date.now();
    const as = opts.as ?? "background";
    const perms = this.brain.permissions;
    perms.assert(as, "read_memories", null, "check knowledge health");
    perms.assert(as, "create_analysis", null, "save health findings");
    const want = new Set<HealthCheck>(opts.checks ?? (Object.keys(HEALTH_CHECKS) as HealthCheck[]));
    const budget = opts.timeBudgetMs ?? 60_000;
    const res: HealthScanResult = { checks: {}, repairs: [], skipped_projects: 0, ms: 0, complete: true };
    const stop = () => {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Cancelled");
    };
    // Which memories may this subject look at? (private projects stay out for automated work)
    const projects = this.brain.store.listProjects(true);
    const readable = new Set<string>();
    for (const p of projects) {
      if (perms.allowed(as, "read_memories", p.id)) readable.add(p.id);
      else res.skipped_projects++;
    }
    const mems = this.active().filter((m) => !m.project_id || readable.has(m.project_id));
    const byId = new Map(mems.map((m) => [m.id, m]));
    const common = { kind: "health" as const, job_id: opts.jobId ?? null, agent: as.startsWith("agent:") ? as : null };

    const run = (check: HealthCheck, inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[], fully = true) => {
      const stat = { found: inputs.length, created: 0, suppressed: 0, resolved: 0 };
      const present = new Set<number>();
      for (const i of inputs) {
        const r = this.brain.findings.upsert({ ...common, ...i, category: check, algorithm: `health/${check}-v1` });
        if (r.id !== null && (r.outcome === "created" || r.outcome === "updated" || r.outcome === "unchanged")) present.add(r.id);
        if (r.outcome === "created") stat.created++;
        if (r.outcome === "suppressed") stat.suppressed++;
      }
      if (fully) stat.resolved = this.brain.findings.reconcile("health", [check], present, "No longer detected by the health check");
      res.checks[check] = stat;
    };

    // --- derived data first (safe, automatic repairs)
    if (want.has("search_index")) {
      stop();
      const nMem = Number(this.db.value("SELECT COUNT(*) FROM memories") ?? 0);
      let ok = true;
      let detail = "";
      try {
        this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')");
      } catch (e) {
        ok = false;
        detail = (e as Error).message;
      }
      const probe = mems.find((m) => m.title.length > 3);
      if (ok && probe && nMem > 0) {
        // A memory must be findable by its own title.
        const hits = this.brain.search.keyword(probe.title, 200);
        if (!hits.has(probe.id)) (ok = false), (detail = `"${truncate(probe.title, 60)}" is not found by its own title`);
      }
      const inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[] = [];
      if (!ok) {
        if (perms.allowed(as, "apply_safe_changes")) {
          const t = Date.now();
          this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
          const repair = { check: "search_index", action: "Rebuilt the full-text search index from the memories", problem: detail, ms: Date.now() - t, at: nowIso(), by: as };
          res.repairs.push(repair);
          this.brain.store.logActivity({ kind: "health_repair", source: as, action: "search_index_rebuilt", detail: repair });
        } else {
          inputs.push({ key: ["fts"], evidenceKey: [detail], title: "The search index needs rebuilding", description: `The full-text search index doesn't match the memories (${detail}). Rebuilding it is safe: it's recreated from the memories.`, memory_ids: [], project_ids: [], evidence: [{ note: detail }], evidence_status: "confirmed", severity: "medium", confidence: 1, suggested_action: "Rebuild the search index", action: { type: "repair", check: "search_index" } as Row, project_id: null, system: true });
        }
      }
      run("search_index", inputs);
    }

    if (want.has("similarity_vectors")) {
      stop();
      const rows = this.db.all<Row>(
        `SELECT m.id, m.title, m.content, m.summary, m.tags, e.content_hash FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = 'local-hash-v1-384' WHERE m.user_id = ? AND m.status = 'active'`,
        [this.uid],
      );
      const stale = rows.filter((r) => {
        const tags = (() => {
          try {
            return JSON.parse(String(r.tags || "[]"));
          } catch {
            return [];
          }
        })();
        return !r.content_hash || r.content_hash !== hashText(embeddingText({ title: String(r.title), content: String(r.content), summary: String(r.summary ?? ""), tags }));
      });
      if (stale.length && perms.allowed(as, "apply_safe_changes")) {
        const t = Date.now();
        this.db.tx(() => {
          for (const r of stale) {
            const m = this.brain.store.getMemory(r.id as string);
            if (m) this.brain.store.embedLocal(m.id, m);
          }
        });
        const repair = { check: "similarity_vectors", action: `Recomputed ${stale.length} similarity vector${stale.length === 1 ? "" : "s"}`, ms: Date.now() - t, at: nowIso(), by: as };
        res.repairs.push(repair);
        this.brain.store.logActivity({ kind: "health_repair", source: as, action: "vectors_recomputed", detail: repair });
      }
      res.checks.similarity_vectors = { found: stale.length, created: 0, suppressed: 0, resolved: 0 };
    }

    // --- exact duplicates (confirmed)
    if (want.has("exact_duplicate")) {
      stop();
      const groups = new Map<string, Memory[]>();
      for (const m of mems) {
        const k = hashText(`${norm(m.title)}|${norm(m.content)}`);
        if (!norm(m.content)) continue;
        const g = groups.get(k);
        if (g) g.push(m);
        else groups.set(k, [m]);
      }
      const inputs = [...groups.values()]
        .filter((g) => g.length > 1)
        .map((g) => {
          const ids = g.map((m) => m.id);
          const keep = [...g].sort((a, b) => b.importance - a.importance || b.access_count - a.access_count || a.created_at.localeCompare(b.created_at))[0];
          return {
            key: ids,
            title: `${g.length} identical memories: "${truncate(g[0].title, 70)}"`,
            description: `These memories have the same title and text. Keeping one is usually right; nothing is changed until you approve a merge.`,
            memory_ids: ids,
            project_ids: [...new Set(g.map((m) => m.project_id).filter(Boolean) as string[])],
            evidence: g.map((m) => ({ memory_id: m.id, quote: truncate(m.content, 160), note: `Saved ${m.created_at.slice(0, 10)} by ${m.source}` })),
            evidence_status: "confirmed" as const,
            severity: "medium" as const,
            confidence: 1,
            suggested_action: `Merge into "${truncate(keep.title, 60)}"`,
            action: { type: "merge", target_id: keep.id, source_ids: ids.filter((x) => x !== keep.id) },
          };
        });
      run("exact_duplicate", inputs);
    }

    // --- similar duplicates (possible). Bounded: candidates come from the full-text index, not all pairs.
    if (want.has("similar_duplicate")) {
      const vecs = this.brain.search.vectors();
      const seen = new Set<string>();
      const inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[] = [];
      let n = 0;
      for (const m of mems) {
        if (++n % 200 === 0) {
          stop();
          await new Promise((r) => setImmediate(r));
          if (Date.now() - t0 > budget) {
            res.complete = false;
            break;
          }
        }
        const v = vecs.get(m.id);
        if (!v) continue;
        const cands = this.brain.search.keyword(`${m.title} ${truncate(m.content, 200)}`, 12);
        for (const [cid] of cands) {
          if (cid === m.id) continue;
          const pair = [m.id, cid].sort().join("|");
          if (seen.has(pair)) continue;
          seen.add(pair);
          const o = byId.get(cid);
          const w = vecs.get(cid);
          if (!o || !w) continue;
          if (norm(o.title) === norm(m.title) && norm(o.content) === norm(m.content)) continue; // exact: reported above
          if (o.category !== m.category && !(o.category === "fact" || m.category === "fact")) continue;
          if (m.memory_type === "preference" || o.memory_type === "preference") continue; // handled by the preference check
          const s = cosine(v, w);
          if (s < 0.86) continue;
          const [a, b] = [m, o].sort((x, y) => x.id.localeCompare(y.id));
          const keep = [a, b].sort((x, y) => y.importance - x.importance || y.content.length - x.content.length)[0];
          inputs.push({
            key: [a.id, b.id],
            title: `Possibly the same thing: "${truncate(a.title, 50)}" and "${truncate(b.title, 50)}"`,
            description: `Their wording is very similar (similarity ${s.toFixed(2)}). They may describe the same thing, or differ in an important detail: compare before merging.`,
            memory_ids: [a.id, b.id],
            project_ids: [...new Set([a.project_id, b.project_id].filter(Boolean) as string[])],
            evidence: [a, b].map((x) => ({ memory_id: x.id, quote: truncate(x.content, 200), note: x.title })),
            evidence_status: "possible",
            severity: "low",
            confidence: Math.round(s * 100) / 100,
            suggested_action: "Compare them; merge if they say the same thing",
            action: { type: "merge", target_id: keep.id, source_ids: [a.id, b.id].filter((x) => x !== keep.id) },
          });
        }
      }
      run("similar_duplicate", inputs, res.complete);
    }

    // --- possible conflicts (flags + pending conflict reviews)
    if (want.has("conflict")) {
      stop();
      const flagged = mems.filter((m) => m.flags.includes("possible_conflict"));
      const inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[] = flagged.map((m) => {
        const partners = this.db
          .all<Row>("SELECT affected_ids FROM review_queue WHERE user_id = ? AND status = 'pending' AND kind IN ('conflict','cortex') AND (target_memory_id = ? OR affected_ids LIKE ?)", [this.uid, m.id, `%"${m.id}"%`])
          .flatMap((r) => JSON.parse(String(r.affected_ids || "[]")) as string[])
          .filter((x) => x !== m.id && byId.has(x));
        const ids = [m.id, ...new Set(partners)].slice(0, 6);
        return {
          key: [m.id],
          evidenceKey: ids,
          title: `Possible conflict: "${truncate(m.title, 70)}"`,
          description: `MOTH flagged this memory as possibly contradicting ${partners.length ? "another memory" : "something it learned later"}. Both versions are kept until you decide which is right.`,
          memory_ids: ids,
          project_ids: [...new Set(ids.map((x) => byId.get(x)?.project_id).filter(Boolean) as string[])],
          evidence: ids.map((x) => ({ memory_id: x, quote: truncate(byId.get(x)?.content ?? "", 200), note: byId.get(x)?.title ?? "" })),
          evidence_status: "possible" as const,
          severity: "medium" as const,
          confidence: null,
          suggested_action: "Open the review queue or edit the memory that's wrong",
          action: { type: "open_reviews" },
        };
      });
      run("conflict", inputs);
    }

    // --- research without sources / weakly supported claims
    if (want.has("missing_source") || want.has("unsupported_claim")) {
      stop();
      const withSources = new Set(this.db.all<Row>("SELECT DISTINCT memory_id FROM memory_sources").map((r) => r.memory_id as string));
      if (want.has("missing_source")) {
        const research = mems.filter((m) => (m.memory_type === "research" || m.category === "research") && !withSources.has(m.id) && m.source_ref == null);
        run(
          "missing_source",
          research.map((m) => ({
            key: [m.id],
            title: `Research without a source: "${truncate(m.title, 70)}"`,
            description: "This research has no source attached, so it can't be checked later. Add the source, or mark it as your own interpretation.",
            memory_ids: [m.id],
            project_ids: m.project_id ? [m.project_id] : [],
            evidence: [{ memory_id: m.id, note: `evidence: ${m.evidence ?? "not set"}; sources attached: 0` }],
            evidence_status: "confirmed" as const,
            severity: m.importance >= 0.7 ? ("medium" as const) : ("low" as const),
            confidence: 1,
            suggested_action: "Add the source (URL or document) or mark it as speculation",
            action: { type: "open_memory", memory_id: m.id },
          })),
        );
      }
      if (want.has("unsupported_claim")) {
        const weak = mems.filter((m) => (m.category === "fact" || m.category === "research" || m.memory_type === "research") && m.importance >= 0.6 && !withSources.has(m.id) && (m.evidence === "speculative" || m.confidence < 0.45 || m.verification === "disputed"));
        run(
          "unsupported_claim",
          weak.map((m) => ({
            key: [m.id],
            evidenceKey: [String(m.confidence), String(m.evidence), m.verification],
            title: `Weakly supported: "${truncate(m.title, 70)}"`,
            description: `It's marked important but ${m.evidence === "speculative" ? "it's marked as speculation" : m.verification === "disputed" ? "it's disputed" : `its confidence is only ${Math.round(m.confidence * 100)}%`} and it has no source.`,
            memory_ids: [m.id],
            project_ids: m.project_id ? [m.project_id] : [],
            evidence: [{ memory_id: m.id, note: `importance ${m.importance}, confidence ${m.confidence}, evidence ${m.evidence ?? "not set"}, verification ${m.verification}` }],
            evidence_status: "possible" as const,
            severity: "low" as const,
            confidence: null,
            suggested_action: "Verify it, add a source, or lower its importance",
            action: { type: "open_memory", memory_id: m.id },
          })),
        );
      }
    }

    // --- broken connections (confirmed)
    if (want.has("broken_relationship")) {
      stop();
      const rels = this.db.all<Row>(
        `SELECT r.*, s.status AS s_status, t.status AS t_status, s.merged_into AS s_merged, t.merged_into AS t_merged, s.superseded_by AS s_sup, t.superseded_by AS t_sup, s.project_id AS s_proj, t.project_id AS t_proj
         FROM memory_relationships r JOIN memories s ON s.id = r.source_id JOIN memories t ON t.id = r.target_id
         WHERE r.user_id = ? AND r.type <> 'SUPERSEDES' AND (r.source_id = r.target_id OR s.status IN ('merged','superseded') OR t.status IN ('merged','superseded'))`,
        [this.uid],
      );
      const inputs = rels
        .filter((r) => (!r.s_proj || readable.has(r.s_proj as string)) && (!r.t_proj || readable.has(r.t_proj as string)))
        .map((r) => {
          const self = r.source_id === r.target_id;
          const newSource = (r.s_merged ?? r.s_sup ?? r.source_id) as string;
          const newTarget = (r.t_merged ?? r.t_sup ?? r.target_id) as string;
          return {
            key: [r.id as string],
            title: self ? "A memory is connected to itself" : "A connection points to a memory that was merged or replaced",
            description: self ? "This connection goes from a memory to the same memory and carries no information." : `One end of this “${String(r.type).toLowerCase().replace(/_/g, " ")}” connection was ${r.s_status !== "active" ? r.s_status : r.t_status} into another memory. The connection can be moved to the memory that replaced it.`,
            memory_ids: [r.source_id as string, r.target_id as string],
            project_ids: [...new Set([r.s_proj, r.t_proj].filter(Boolean) as string[])],
            evidence: [{ memory_id: r.source_id as string, note: `connection ${r.id}: ${r.type}; from (${r.s_status}) to (${r.t_status})` }],
            evidence_status: "confirmed" as const,
            severity: "low" as const,
            confidence: 1,
            suggested_action: self || newSource === newTarget ? "Remove the connection" : "Move the connection to the surviving memory",
            action: { type: "relink", relationship_id: r.id, new_source: self ? null : newSource, new_target: self ? null : newTarget },
          };
        });
      run("broken_relationship", inputs);
    }

    // --- possibly outdated research
    if (want.has("outdated_research")) {
      stop();
      const old = Date.now() - 365 * DAY;
      const oldPub = Date.now() - 730 * DAY;
      const research = mems.filter((m) => m.memory_type === "research" || m.category === "research");
      const inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[] = [];
      for (const m of research) {
        const pubs = this.db.all<Row>("SELECT published_at, title FROM memory_sources WHERE memory_id = ? AND published_at IS NOT NULL", [m.id]);
        const oldSources = pubs.filter((p) => Date.parse(String(p.published_at)) < oldPub);
        const notUpdated = Date.parse(m.updated_at) < old;
        if (!notUpdated && !(pubs.length && oldSources.length === pubs.length)) continue;
        inputs.push({
          key: [m.id],
          title: `Possibly outdated: "${truncate(m.title, 70)}"`,
          description: notUpdated ? `Not updated since ${m.updated_at.slice(0, 10)}.` : `All its sources were published more than two years ago (${oldSources.map((p) => String(p.published_at).slice(0, 10)).join(", ")}).`,
          memory_ids: [m.id],
          project_ids: m.project_id ? [m.project_id] : [],
          evidence: [{ memory_id: m.id, note: notUpdated ? `last updated ${m.updated_at}` : `sources: ${oldSources.map((p) => `${p.title} (${String(p.published_at).slice(0, 10)})`).join("; ")}` }],
          evidence_status: "possible",
          severity: "info",
          confidence: null,
          suggested_action: "Check whether it's still true; update or mark it as historical",
          action: { type: "open_memory", memory_id: m.id },
        });
      }
      run("outdated_research", inputs);
    }

    // --- stale project context
    if (want.has("stale_project")) {
      stop();
      const cutoff = new Date(Date.now() - 60 * DAY).toISOString();
      const inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[] = [];
      for (const p of projects) {
        if (p.archived || !readable.has(p.id) || p.is_demo) continue;
        const last = String(p.last_activity_at ?? p.updated_at);
        if (last >= cutoff) continue;
        const open = this.db.all<Row>("SELECT id, title, kind FROM project_items WHERE project_id = ? AND status = 'open' AND kind IN ('blocker','unresolved_decision')", [p.id]);
        const tasks = mems.filter((m) => m.project_id === p.id && m.task_state === "open");
        if (!open.length && !tasks.length) continue;
        inputs.push({
          key: [p.id],
          evidenceKey: [...open.map((o) => o.id as string), ...tasks.map((t) => t.id)],
          title: `${p.name} has open work but no activity since ${last.slice(0, 10)}`,
          description: `${open.length ? `${open.length} open blocker/decision${open.length === 1 ? "" : "s"}` : ""}${open.length && tasks.length ? " and " : ""}${tasks.length ? `${tasks.length} open task${tasks.length === 1 ? "" : "s"}` : ""} may no longer reflect reality. Update them, or archive the project if it's finished or paused.`,
          memory_ids: tasks.slice(0, 10).map((t) => t.id),
          project_id: p.id,
          project_ids: [p.id],
          evidence: [...open.map((o) => ({ project_id: p.id, note: `${o.kind}: ${o.title}` })), ...tasks.slice(0, 5).map((t) => ({ memory_id: t.id, note: `open task: ${t.title}` }))],
          evidence_status: "possible",
          severity: "info",
          confidence: null,
          suggested_action: "Review the project's open items, or archive it",
          action: { type: "open_project", project_id: p.id },
        });
      }
      run("stale_project", inputs);
    }

    // --- inconsistent preferences
    if (want.has("inconsistent_preference")) {
      stop();
      const prefs = this.db
        .all<Row>("SELECT m.id, pm.area, pm.status FROM memories m JOIN preference_meta pm ON pm.memory_id = m.id WHERE m.user_id = ? AND m.status = 'active' AND pm.status IN ('confirmed','tentative')", [this.uid])
        .map((r) => ({ m: byId.get(r.id as string), area: r.area as string }))
        .filter((x) => !!x.m) as { m: Memory; area: string }[];
      const vecs = this.brain.search.vectors();
      const inputs: Omit<FindingInput, "kind" | "category" | "algorithm">[] = [];
      for (let i = 0; i < prefs.length; i++)
        for (let j = i + 1; j < prefs.length; j++) {
          const a = prefs[i], b = prefs[j];
          if (a.area !== b.area) continue;
          if (a.m.project_id && b.m.project_id && a.m.project_id !== b.m.project_id) continue; // different projects may differ on purpose
          const va = vecs.get(a.m.id), vb = vecs.get(b.m.id);
          if (!va || !vb) continue;
          const s = cosine(va, vb);
          const negA = NEG.test(a.m.content), negB = NEG.test(b.m.content);
          if (s < 0.45 || negA === negB || !(POS.test(a.m.content) || POS.test(b.m.content))) continue;
          inputs.push({
            key: [a.m.id, b.m.id],
            title: `Preferences that may disagree (${a.area})`,
            description: `"${truncate(a.m.content, 100)}" and "${truncate(b.m.content, 100)}" are about the same thing, but one of them is negative. Maybe one replaced the other.`,
            memory_ids: [a.m.id, b.m.id],
            project_ids: [...new Set([a.m.project_id, b.m.project_id].filter(Boolean) as string[])],
            evidence: [a, b].map((x) => ({ memory_id: x.m.id, quote: truncate(x.m.content, 200), note: `${x.area} preference` })),
            evidence_status: "possible",
            severity: "low",
            confidence: Math.round(s * 100) / 100,
            suggested_action: "Keep the one that's right and mark the other outdated",
            action: { type: "open_memory", memory_id: a.m.id },
          });
        }
      run("inconsistent_preference", inputs);
    }

    res.ms = Date.now() - t0;
    this.brain.store.logActivity({ kind: "health", source: as, action: "scan", duration_ms: res.ms, detail: { checks: Object.fromEntries(Object.entries(res.checks).map(([k, v]) => [k, v.found])), repairs: res.repairs.length, complete: res.complete } });
    return res;
  }

  /**
   * Turns a finding's recommended change into a review item (nothing is changed yet). The user approves or rejects it
   * in the review queue (or from the Knowledge Health page).
   */
  propose(findingId: number, by: Subject | string = "user", jobId: number | null = null): Row {
    const f = this.brain.findings.get(findingId);
    if (f.kind !== "health") throw new MothError("invalid_input", "Not a knowledge health finding");
    if (!["new", "viewed"].includes(String(f.status))) throw new MothError("invalid_input", `This finding is already ${f.status}`);
    if (by !== "user") this.brain.permissions.assert(by, "propose_changes", (f.project_id as string) ?? null, "propose a change");
    const a = (f.action ?? {}) as Row;
    let id: number;
    if (a.type === "merge") {
      const ids = [String(a.target_id), ...((a.source_ids as string[]) ?? [])];
      const ms = this.brain.store.getMany(ids);
      id = this.brain.inbox.add({
        kind: "merge",
        operation: "merge",
        statement: `Merge ${ms.length} memories into "${truncate(ms.find((m) => m.id === a.target_id)?.title ?? "", 80)}"`,
        reason: `${f.title}. ${f.description}`,
        risk: f.evidence_status === "confirmed" ? "low" : "medium",
        confidence: (f.confidence as number) ?? null,
        target_memory_id: String(a.target_id),
        affected_ids: ids,
        proposal: { handler: "health_merge", target_id: a.target_id, source_ids: a.source_ids, finding_id: findingId },
        source: by,
      });
    } else if (a.type === "relink") {
      id = this.brain.inbox.add({
        kind: "other",
        operation: "relink",
        statement: a.new_target ? "Move a connection to the memory that replaced its old end" : "Remove a connection from a memory to itself",
        reason: `${f.title}. ${f.description}`,
        risk: "low",
        confidence: 1,
        affected_ids: f.memory_ids as string[],
        proposal: { handler: "health_relink", relationship_id: a.relationship_id, new_source: a.new_source, new_target: a.new_target, finding_id: findingId },
        source: by,
      });
    } else throw new MothError("invalid_input", "This finding has no automatic change to propose. Open the memory and fix it by hand.");
    if (jobId) this.db.run("UPDATE review_queue SET job_id = ? WHERE id = ?", [jobId, id]);
    this.brain.findings.markViewed(findingId);
    return { review_id: id, finding_id: findingId };
  }

  /** Repair history (auditable): every automatic repair MOTH made. */
  repairs(limit = 50): Row[] {
    return this.db
      .all<Row>("SELECT id, source, action, detail, created_at FROM activity_logs WHERE kind = 'health_repair' ORDER BY id DESC LIMIT ?", [Math.min(500, limit)])
      .map((r) => ({ ...r, detail: (() => { try { return JSON.parse(String(r.detail)); } catch { return null; } })() }));
  }

  /** Counts for the dashboard: per check, active findings split into confirmed and possible. No overall score. */
  summary(): Row {
    const rows = this.db.all<Row>("SELECT category, evidence_status, COUNT(*) AS n FROM findings WHERE user_id = ? AND kind = 'health' AND status IN ('new','viewed') GROUP BY category, evidence_status", [this.uid]);
    const checks = Object.entries(HEALTH_CHECKS).map(([k, v]) => ({
      check: k,
      ...v,
      confirmed: Number(rows.find((r) => r.category === k && r.evidence_status === "confirmed")?.n ?? 0),
      possible: Number(rows.find((r) => r.category === k && r.evidence_status === "possible")?.n ?? 0),
    }));
    const last = this.db.get<Row>("SELECT created_at, detail FROM activity_logs WHERE kind = 'health' AND action = 'scan' ORDER BY id DESC LIMIT 1");
    return { checks, last_scan: last ? { at: last.created_at, detail: (() => { try { return JSON.parse(String(last.detail)); } catch { return null; } })() } : null };
  }
}
