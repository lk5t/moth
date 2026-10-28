// Discovery Engine (quiet mode): finds useful, evidence-backed connections between things MOTH already knows.
//
// Kinds of discovery:
//  - cross_project        reusable knowledge (lesson, solution, research, concept, how-to) from one project that matches
//                         something in another project (e.g. an onboarding lesson that fits a different app)
//  - answers_question     stored research or a lesson that matches an open unresolved decision or blocker
//  - supporting_evidence  two independent memories (different projects or sources) that both support the same decision
//
// Validation before anything is surfaced: every memory exists and is active; they aren't already connected; project
// boundaries hold (knowledge transfer allowed both ways, no private project or private memory); neither side is
// flagged as conflicting or superseded; not previously dismissed with the same evidence; enough evidence (similarity
// above the threshold AND at least two shared meaningful words, which are shown).
//
// Quiet mode: only findings with confidence ≥ the threshold are stored; no notifications or pop-ups. User feedback
// tunes later scans (stored rules, not model training): a category that keeps getting dismissed needs higher
// confidence, and a memory involved in repeated dismissals is left out of suggestions.
//
// Nothing is linked until the user confirms. Confirming creates a real relationship whose reason records the
// discovery; until then, suggestions are only findings (shown as dashed edges in The Mind).
import type { Row } from "../db/database.ts";
import { documentFrequency } from "../engine/search.ts";
import type { Brain } from "../engine/brain.ts";
import { cosine } from "../engine/embeddings.ts";
import { keywords, stem, truncate } from "../engine/text.ts";
import { MothError, type Memory, type Project, type RelationType } from "../engine/types.ts";
import type { FindingInput } from "./findings.ts";
import type { Subject } from "./permissions.ts";

export const DISCOVERY_KINDS = {
  cross_project: "Knowledge that fits another project",
  answers_question: "Stored knowledge that may answer an open question",
  supporting_evidence: "Independent memories supporting the same decision",
} as const;
export type DiscoveryKind = keyof typeof DISCOVERY_KINDS;

const REUSABLE_TYPES = new Set(["lesson", "research", "procedural"]);
const REUSABLE_CATS = new Set(["solution", "research", "concept"]);
const isReusable = (m: Memory) => REUSABLE_TYPES.has(m.memory_type) || REUSABLE_CATS.has(m.category);

export function sharedWords(x: string, y: string): string[] {
  const sx = new Set(keywords(x, 40).map((w) => stem(w.toLowerCase())));
  return [...new Set(keywords(y, 40))].filter((w) => w.length > 3 && sx.has(stem(w.toLowerCase()))).slice(0, 8);
}

export const DISCOVERY_ALGORITHM = "discovery-v1 (word-based similarity + shared keywords + graph and scope checks)";

/** Confidence from the measured evidence (documented): similarity carries most weight, shared words add some. */
export function discoveryConfidence(similarity: number, sharedWords: number): number {
  const sim = Math.max(0, Math.min(1, (similarity - 0.2) / 0.5)); // 0.2 → 0, 0.7+ → 1
  return Math.round(Math.min(0.95, 0.25 + 0.55 * sim + 0.05 * Math.min(4, sharedWords)) * 100) / 100;
}

export class Discovery {
  constructor(private brain: Brain) {}

  /** The confidence a suggestion needs (raised for categories the user keeps dismissing). */
  threshold(kind: DiscoveryKind): number {
    const base = Number(this.brain.settings.get("discovery.minConfidence") ?? 0.6);
    const fb = this.brain.findings.feedbackFor("discovery", kind);
    const extra = fb.dismissed >= 3 && fb.dismissed > 2 * fb.confirmed ? 0.08 : 0;
    return Math.min(0.92, base + extra);
  }

  /** Memories the user dismissed suggestions about 3+ times are left out (stored rule from feedback). */
  private quieted(): Set<string> {
    const rows = this.brain.db.all<Row>("SELECT memory_ids FROM findings WHERE user_id = ? AND kind = 'discovery' AND status = 'dismissed'", [this.brain.store.userId]);
    const n = new Map<string, number>();
    for (const r of rows) for (const id of JSON.parse(String(r.memory_ids || "[]")) as string[]) n.set(id, (n.get(id) ?? 0) + 1);
    return new Set([...n].filter(([, c]) => c >= 3).map(([id]) => id));
  }

  private linked(a: string, b: string): boolean {
    return !!this.brain.db.value("SELECT 1 FROM memory_relationships WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)", [a, b, b, a]);
  }

  /** Meaningful words both texts use (compared by word stem, so "fixed" and "fixes" match). */
  private shared(a: Memory, b: Memory): string[] {
    return sharedWords(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
  }

  private transferOk(a: Memory, b: Memory, projects: Map<string, Project>): boolean {
    if (a.scope === "private" || b.scope === "private") return false;
    for (const m of [a, b]) {
      if (!m.project_id) continue;
      const p = projects.get(m.project_id);
      if (!p || p.private || !p.transfer_enabled) return false;
    }
    return true;
  }

  private problematic(m: Memory): boolean {
    return m.status !== "active" || m.flags.includes("possible_conflict") || m.verification === "disputed";
  }

  async scan(opts: { as?: Subject | string; signal?: AbortSignal; jobId?: number | null; limit?: number } = {}): Promise<Row> {
    const t0 = Date.now();
    const b = this.brain;
    const as = opts.as ?? "background";
    b.permissions.assert(as, "read_memories", null, "look for connections");
    b.permissions.assert(as, "create_analysis", null, "save discoveries");
    const stop = () => {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Cancelled");
    };
    const projects = new Map(b.store.listProjects(true).map((p) => [p.id, p]));
    const readable = (m: Memory) => !m.project_id || b.permissions.allowed(as, "read_memories", m.project_id);
    const quiet = this.quieted();
    const mems = b.db
      .all<Row>("SELECT * FROM memories WHERE user_id = ? AND status = 'active' AND is_demo = 0 ORDER BY importance DESC, updated_at DESC LIMIT ?", [b.store.userId, Math.min(20000, opts.limit ?? 5000)])
      .map((r) => b.store.toMemory(r))
      .filter((m) => readable(m) && !quiet.has(m.id));
    const byId = new Map(mems.map((m) => [m.id, m]));
    const vecs = b.search.vectors();
    const df = documentFrequency(mems.map((m) => `${m.title} ${m.content}`));
    const out = new Map<DiscoveryKind, Omit<FindingInput, "kind" | "category" | "algorithm">[]>();
    const push = (k: DiscoveryKind, i: Omit<FindingInput, "kind" | "category" | "algorithm">) => (out.get(k) ?? out.set(k, []).get(k)!).push(i);
    const stats = { candidates: 0, rejected: { linked: 0, scope: 0, conflict: 0, evidence: 0, threshold: 0 } };
    const rej = stats.rejected as Record<string, number>;
    const th = { cross_project: this.threshold("cross_project"), answers_question: this.threshold("answers_question"), supporting_evidence: this.threshold("supporting_evidence") };

    // Keep the app responsive: hand control back at least every ~30 ms.
    let lastYield = Date.now();
    const breathe = async () => {
      stop();
      if (Date.now() - lastYield > 30) {
        await new Promise((r) => setImmediate(r));
        lastYield = Date.now();
      }
    };

    // 1) cross_project: reusable memory ↔ memory in another project
    const seen = new Set<string>();
    for (const a of mems) {
      if (!isReusable(a) || this.problematic(a)) continue;
      await breathe();
      const va = vecs.get(a.id);
      if (!va) continue;
      const cands = b.search.candidates(`${a.title} ${truncate(a.content, 300)}`, 20, df);
      for (const [cid] of cands) {
        const o = byId.get(cid);
        if (!o || o.id === a.id || this.problematic(o)) continue;
        if (!a.project_id && !o.project_id) continue;
        if (a.project_id === o.project_id) continue; // same project: nothing to discover across projects
        const pair = [a.id, o.id].sort().join("|");
        if (seen.has(pair)) continue;
        seen.add(pair);
        stats.candidates++;
        if (this.linked(a.id, o.id)) (rej.linked++, void 0);
        else if (!this.transferOk(a, o, projects)) rej.scope++;
        else if (o.category === "preference" || (o.category === "decision" && isReusable(a) === false)) rej.scope++;
        else {
          const vo = vecs.get(o.id);
          if (!vo) continue;
          const sim = cosine(va, vo);
          const words = this.shared(a, o);
          if (words.length < 2 || sim < 0.3) {
            rej.evidence++;
            continue;
          }
          const conf = discoveryConfidence(sim, words.length);
          if (conf < th.cross_project) {
            rej.threshold++;
            continue;
          }
          const pa = a.project_id ? projects.get(a.project_id)?.name : "general knowledge";
          const po = o.project_id ? projects.get(o.project_id)?.name : "general knowledge";
          push("cross_project", {
            key: [a.id, o.id],
            title: `${a.memory_type === "lesson" ? "A lesson" : a.memory_type === "research" || a.category === "research" ? "Research" : "Knowledge"} from ${pa} may apply to ${po}`,
            description: `"${truncate(a.title, 80)}" and "${truncate(o.title, 80)}" share ${words.slice(0, 5).map((w) => `“${w}”`).join(", ")} (word similarity ${sim.toFixed(2)}). If it applies, connecting them makes it show up when you work on ${po}.`,
            memory_ids: [a.id, o.id],
            project_ids: [a.project_id, o.project_id].filter(Boolean) as string[],
            evidence: [
              { memory_id: a.id, quote: truncate(a.content, 220), note: `${pa}: ${a.title}` },
              { memory_id: o.id, quote: truncate(o.content, 220), note: `${po}: ${o.title}` },
            ],
            evidence_status: "possible",
            severity: "info",
            confidence: conf,
            suggested_action: `Connect them if "${truncate(a.title, 50)}" applies to ${po}`,
            action: { type: "link", source_id: a.id, target_id: o.id, relation: "RELATED_TO", shared: words, similarity: Math.round(sim * 100) / 100 },
          });
        }
      }
    }

    // 2) answers_question: stored reusable knowledge ↔ open unresolved decision / blocker
    const items = b.db.all<Row>("SELECT * FROM project_items WHERE user_id = ? AND status = 'open' AND kind IN ('unresolved_decision','blocker')", [b.store.userId]);
    for (const it of items) {
      await breathe();
      const p = projects.get(it.project_id as string);
      if (!p || !b.permissions.allowed(as, "read_projects", p.id)) continue;
      const text = `${it.title} ${it.detail ?? ""}`;
      for (const h of b.search.similarToText(text, 25)) {
        const m = byId.get(h.id);
        if (!m || !isReusable(m) || this.problematic(m)) continue;
        if (m.id === it.memory_id) continue;
        stats.candidates++;
        if (m.project_id && m.project_id !== p.id && !this.transferOk(m, { ...m, project_id: p.id, scope: "global" } as Memory, projects)) {
          rej.scope++;
          continue;
        }
        const words = sharedWords(text, `${m.title} ${m.content}`);
        if (words.length < 2 || h.score < 0.3) {
          rej.evidence++;
          continue;
        }
        const conf = discoveryConfidence(h.score, words.length);
        if (conf < th.answers_question) {
          rej.threshold++;
          continue;
        }
        const hub = p.hub_memory_id && byId.has(p.hub_memory_id) ? p.hub_memory_id : null;
        const from = m.project_id && m.project_id !== p.id ? projects.get(m.project_id)?.name : null;
        push("answers_question", {
          key: [String(it.id), m.id],
          evidenceKey: [String(it.title), String(it.detail ?? "")],
          title: `May help with "${truncate(String(it.title), 70)}"`,
          description: `${m.memory_type === "research" || m.category === "research" ? "Research" : "A lesson"} you saved${from ? ` in ${from}` : ""}, "${truncate(m.title, 80)}", shares ${words.slice(0, 5).map((w) => `“${w}”`).join(", ")} with this open ${it.kind === "blocker" ? "blocker" : "decision"} in ${p.name} (similarity ${h.score.toFixed(2)}).`,
          memory_ids: [m.id, ...(hub ? [hub] : [])],
          project_id: p.id,
          project_ids: [...new Set([p.id, m.project_id].filter(Boolean) as string[])],
          evidence: [
            { project_id: p.id, source_ref: `project_item:${it.id}`, note: `Open ${it.kind === "blocker" ? "blocker" : "decision"}: ${it.title}` },
            { memory_id: m.id, quote: truncate(m.content, 220), note: m.title },
          ],
          source_refs: [`project_item:${it.id}`],
          evidence_status: "possible",
          severity: "low",
          confidence: conf,
          suggested_action: hub ? `Connect it to ${p.name} so it's in that project's context` : "Read it before deciding",
          action: hub ? { type: "link", source_id: m.id, target_id: hub, relation: "REFERENCES", item_id: it.id, shared: words, similarity: Math.round(h.score * 100) / 100 } : { type: "open_memory", memory_id: m.id },
        });
      }
    }

    // 3) supporting_evidence: two independent reusable memories both close to the same decision
    for (const d of mems.filter((m) => m.category === "decision" && !this.problematic(m))) {
      await breathe();
      const vd = vecs.get(d.id);
      if (!vd) continue;
      const near: { m: Memory; sim: number; words: string[] }[] = [];
      for (const [cid] of b.search.candidates(`${d.title} ${truncate(d.content, 300)}`, 20, df)) {
        const m = byId.get(cid);
        if (!m || m.id === d.id || !isReusable(m) || this.problematic(m)) continue;
        if (m.project_id !== d.project_id && !this.transferOk(m, d, projects)) continue;
        const v = vecs.get(m.id);
        if (!v) continue;
        const sim = cosine(vd, v);
        const words = this.shared(d, m);
        if (sim >= 0.3 && words.length >= 2) near.push({ m, sim, words });
      }
      // Independent = from different projects or different sources, and not already connected to each other.
      for (let i = 0; i < near.length; i++)
        for (let j = i + 1; j < near.length; j++) {
          const x = near[i], y = near[j];
          const independent = x.m.project_id !== y.m.project_id || (x.m.source_ref ?? x.m.source) !== (y.m.source_ref ?? y.m.source);
          if (!independent || this.linked(x.m.id, y.m.id)) continue;
          if (this.linked(d.id, x.m.id) && this.linked(d.id, y.m.id)) continue;
          stats.candidates++;
          const conf = Math.min(discoveryConfidence(x.sim, x.words.length), discoveryConfidence(y.sim, y.words.length));
          if (conf < th.supporting_evidence) {
            rej.threshold++;
            continue;
          }
          push("supporting_evidence", {
            key: [d.id, x.m.id, y.m.id],
            title: `Two independent notes support "${truncate(d.title, 70)}"`,
            description: `"${truncate(x.m.title, 60)}" and "${truncate(y.m.title, 60)}" were saved separately${x.m.project_id !== y.m.project_id ? " in different projects" : " from different sources"} and both match this decision (similarity ${x.sim.toFixed(2)} and ${y.sim.toFixed(2)}).`,
            memory_ids: [d.id, x.m.id, y.m.id],
            project_ids: [...new Set([d.project_id, x.m.project_id, y.m.project_id].filter(Boolean) as string[])],
            evidence: [d, x.m, y.m].map((m) => ({ memory_id: m.id, quote: truncate(m.content, 180), note: m.title })),
            evidence_status: "possible",
            severity: "info",
            confidence: conf,
            suggested_action: "Connect both to the decision as supporting references",
            action: { type: "link_many", links: [x.m.id, y.m.id].filter((id) => !this.linked(d.id, id)).map((id) => ({ source_id: id, target_id: d.id, relation: "REFERENCES" })) },
          });
        }
    }

    // Store (quiet: no notifications), and close discoveries that no longer hold (e.g. now connected, or a side
    // was archived) — resolved, not deleted.
    // Quiet mode also means few: per kind only the most confident discoveries are kept (and at most a few per memory),
    // so a large collection can't flood the list. Ones already shown stay until they no longer hold.
    const result: Row = {};
    const maxPerKind = Math.max(1, Number(b.settings.get("discovery.maxPerKind") ?? 30));
    for (const k of Object.keys(DISCOVERY_KINDS) as DiscoveryKind[]) {
      const present = new Set<number>();
      let created = 0, suppressed = 0, held_back = 0;
      const all = [...(out.get(k) ?? [])].sort((x, y) => Number(y.confidence ?? 0) - Number(x.confidence ?? 0));
      const perMemory = new Map<string, number>();
      b.db.tx(() => {
        for (const i of all) {
          const busy = i.memory_ids.some((id) => (perMemory.get(id) ?? 0) >= 3);
          if (present.size >= maxPerKind || busy) {
            const fp = b.findings.fingerprint("discovery", k, i.key);
            const active = b.db.value<number>("SELECT id FROM findings WHERE user_id = ? AND kind = 'discovery' AND fingerprint = ? AND status IN ('new','viewed')", [b.store.userId, fp]);
            if (active) present.add(Number(active));
            else held_back++;
            continue;
          }
          const r = b.findings.upsert({ ...i, kind: "discovery", category: k, algorithm: DISCOVERY_ALGORITHM, job_id: opts.jobId ?? null, agent: as.startsWith("agent:") ? as : null });
          if (r.id !== null && (r.outcome === "created" || r.outcome === "updated" || r.outcome === "unchanged")) {
            present.add(r.id);
            for (const id of i.memory_ids) perMemory.set(id, (perMemory.get(id) ?? 0) + 1);
          }
          if (r.outcome === "created") created++;
          if (r.outcome === "suppressed") suppressed++;
        }
      });
      const resolved = b.findings.reconcile("discovery", [k], present, "No longer applies (connected, changed or archived)");
      result[k] = { found: all.length, created, suppressed, held_back, resolved };
    }
    const summary = { memories: mems.length, quieted_memories: quiet.size, thresholds: th, ...stats, kinds: result, ms: Date.now() - t0 };
    b.store.logActivity({ kind: "discovery", source: as, action: "scan", duration_ms: summary.ms, detail: summary });
    return summary;
  }

  /** The user confirms a discovery: the suggested connection(s) become real relationships (with provenance). */
  confirm(findingId: number, note?: string): Row {
    const f = this.brain.findings.get(findingId);
    if (f.kind !== "discovery") throw new MothError("invalid_input", "Not a discovery");
    if (!["new", "viewed"].includes(String(f.status))) throw new MothError("invalid_input", `This discovery is already ${f.status}`);
    const a = (f.action ?? {}) as Row;
    const links: { source_id: string; target_id: string; relation: string }[] =
      a.type === "link" ? [{ source_id: String(a.source_id), target_id: String(a.target_id), relation: String(a.relation ?? "RELATED_TO") }] : a.type === "link_many" ? (a.links as any[]) : [];
    const created: string[] = [];
    this.brain.db.tx(() => {
      for (const l of links) {
        if (this.linked(l.source_id, l.target_id)) continue;
        const r = this.brain.store.link(l.source_id, l.target_id, l.relation as RelationType, truncate(`Confirmed discovery: ${f.title}. ${f.description}`, 900), { actor: "user", reason: `Discovery #${findingId} confirmed` });
        created.push(r.id);
      }
      this.brain.findings.confirm(findingId, note ?? (created.length ? `Connected (${created.length} link${created.length === 1 ? "" : "s"})` : "Confirmed"));
    });
    this.brain.store.logActivity({ kind: "discovery", source: "user", action: "confirmed", detail: { id: findingId, links: created } });
    return { finding: this.brain.findings.get(findingId), links: created };
  }

  /** Suggested (not confirmed) connections for The Mind: drawn dashed, never stored as relationships. */
  suggestedEdges(): Row[] {
    return this.brain.findings
      .list({ kind: "discovery", status: "active", limit: 300 })
      .flatMap((f) => {
        const a = (f.action ?? {}) as Row;
        const pairs = a.type === "link" ? [{ source_id: a.source_id, target_id: a.target_id }] : a.type === "link_many" ? (a.links as Row[]) : [];
        return pairs.map((p, i) => ({ id: `disc_${f.id}_${i}`, finding_id: f.id, source_id: p.source_id, target_id: p.target_id, confidence: f.confidence, title: f.title, category: f.category }));
      });
  }
}
