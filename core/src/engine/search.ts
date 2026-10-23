// Hybrid retrieval: FTS5 keywords + vector similarity + project association + graph proximity
// + importance + recency + confidence. Every result carries the reasons it was ranked.
import type { Database, Row } from "../db/database.ts";
import { blobToVec, cosine, LOCAL_MODEL, localEmbed, type EmbeddingProvider } from "./embeddings.ts";
import type { MemoryStore } from "./store.ts";
import { tokenize, uniq } from "./text.ts";
import type { Memory } from "./types.ts";

export interface SearchFilters {
  project_id?: string | null;
  category?: string | null;
  categories?: string[];
  tags?: string[];
  since?: string | null;
  until?: string | null;
  status?: "active" | "all" | "archived";
  related_to?: string | null; // only memories within 2 hops of this memory
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  signals: { keyword: number; semantic: number; project: number; graph: number; importance: number; recency: number; confidence: number };
  why: string[];
}

export const WEIGHTS = { semantic: 0.36, keyword: 0.27, project: 0.1, graph: 0.09, importance: 0.08, recency: 0.06, confidence: 0.04 };

class VectorCache {
  private vecs = new Map<string, Map<string, Float32Array>>(); // model -> id -> vec
  private stamp = new Map<string, string>();

  load(db: Database, model: string, userId: string): Map<string, Float32Array> {
    let m = this.vecs.get(model);
    const since = this.stamp.get(model);
    if (!m) {
      m = new Map();
      this.vecs.set(model, m);
    }
    const rows = db.all<Row>(
      `SELECT e.memory_id, e.vector, e.created_at FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
       WHERE e.model = ? AND m.user_id = ? ${since ? "AND e.created_at >= ?" : ""}`,
      since ? [model, userId, since] : [model, userId],
    );
    let latest = since ?? "";
    for (const r of rows) {
      m.set(r.memory_id as string, blobToVec(r.vector as Uint8Array));
      if ((r.created_at as string) > latest) latest = r.created_at as string;
    }
    if (latest) this.stamp.set(model, latest);
    return m;
  }

  clear(): void {
    this.vecs.clear();
    this.stamp.clear();
  }
}

export class SearchEngine {
  private cache = new VectorCache();
  remote: EmbeddingProvider | null = null;

  constructor(private store: MemoryStore) {}

  get db(): Database {
    return this.store.db;
  }

  resetCache(): void {
    this.cache.clear();
  }

  /** FTS5 query built from the user's words: each term as a prefix, OR-ed together. */
  private ftsQuery(q: string): string | null {
    const terms = uniq(
      q
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    ).filter((t) => tokenize(t).length > 0);
    if (!terms.length) return null;
    return terms.slice(0, 24).map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
  }

  keyword(q: string, limit = 60): Map<string, number> {
    const fq = this.ftsQuery(q);
    const out = new Map<string, number>();
    if (!fq) return out;
    let rows: Row[] = [];
    try {
      rows = this.db.all<Row>(
        `SELECT m.id, bm25(memories_fts, 6.0, 1.0, 2.0, 3.0) AS rank FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? AND m.user_id = ? ORDER BY rank LIMIT ?`,
        [fq, this.store.userId, limit],
      );
    } catch {
      return out;
    }
    if (!rows.length) return out;
    // bm25 is negative (lower = better). Normalise to 0..1 relative to the best hit, with a floor.
    const best = Math.min(...rows.map((r) => Number(r.rank)));
    for (const r of rows) {
      const rel = best === 0 ? 1 : Number(r.rank) / best;
      out.set(r.id as string, Math.max(0.05, Math.min(1, rel)));
    }
    return out;
  }

  async semantic(q: string, limit = 60): Promise<{ scores: Map<string, number>; model: string }> {
    const uid = this.store.userId;
    let model = LOCAL_MODEL;
    let qv: Float32Array | null = null;
    if (this.remote) {
      try {
        const coverage = Number(this.db.value("SELECT COUNT(*) FROM memory_embeddings WHERE model = ?", [this.remote.id]) ?? 0);
        const total = Number(this.db.value("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active'", [uid]) ?? 0);
        if (total > 0 && coverage / total > 0.8) {
          [qv] = await this.remote.embed([q], "query");
          model = this.remote.id;
        }
      } catch {
        qv = null;
        model = LOCAL_MODEL;
      }
    }
    if (!qv) qv = localEmbed(q);
    const vecs = this.cache.load(this.db, model, uid);
    const scored: [string, number][] = [];
    for (const [id, v] of vecs) {
      const s = cosine(qv, v);
      if (s > 0.05) scored.push([id, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    // Local lexical vectors have a compressed range; stretch so 0.55+ means "very similar".
    const scale = model === LOCAL_MODEL ? 1.6 : 1.15;
    return { scores: new Map(scored.slice(0, limit).map(([id, s]) => [id, Math.min(1, s * scale)])), model };
  }

  similarTo(memoryId: string, limit = 10, model = LOCAL_MODEL): { id: string; score: number }[] {
    const vecs = this.cache.load(this.db, model, this.store.userId);
    const v = vecs.get(memoryId);
    if (!v) return [];
    const out: { id: string; score: number }[] = [];
    for (const [id, w] of vecs) if (id !== memoryId) out.push({ id, score: cosine(v, w) });
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  similarToText(text: string, limit = 10): { id: string; score: number }[] {
    const v = localEmbed(text);
    const vecs = this.cache.load(this.db, LOCAL_MODEL, this.store.userId);
    const out: { id: string; score: number }[] = [];
    for (const [id, w] of vecs) out.push({ id, score: cosine(v, w) });
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async hybrid(query: string, filters: SearchFilters = {}, opts: { limit?: number; minScore?: number; boostProjectId?: string | null; seedIds?: string[] } = {}): Promise<ScoredMemory[]> {
    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? 0.15;
    const kw = this.keyword(query);
    const { scores: sem } = await this.semantic(query);
    const candidates = new Set<string>([...kw.keys(), ...sem.keys()]);

    // Graph proximity: neighbours of the strongest textual hits (and explicit seeds) get a boost.
    const prelim = [...candidates].map((id) => ({ id, s: 0.55 * (sem.get(id) ?? 0) + 0.45 * (kw.get(id) ?? 0) })).sort((a, b) => b.s - a.s);
    const seeds = uniq([...(opts.seedIds ?? []), ...prelim.slice(0, 5).filter((p) => p.s > 0.3).map((p) => p.id)]);
    const graph = new Map<string, number>();
    for (const seed of seeds) {
      const rels = this.db.all<Row>("SELECT source_id, target_id, strength FROM memory_relationships WHERE source_id = ? OR target_id = ?", [seed, seed]);
      for (const r of rels) {
        const other = (r.source_id === seed ? r.target_id : r.source_id) as string;
        graph.set(other, Math.max(graph.get(other) ?? 0, Number(r.strength)));
        candidates.add(other);
      }
      graph.set(seed, Math.max(graph.get(seed) ?? 0, 0.5));
    }

    let relatedSet: Set<string> | null = null;
    if (filters.related_to) relatedSet = new Set(this.store.neighbourhood(filters.related_to, 2).ids);

    const mems = this.store.getMany([...candidates]);
    const now = Date.now();
    const boostProject = opts.boostProjectId ?? filters.project_id ?? null;
    const projectMembers = boostProject
      ? new Set(this.db.all<Row>("SELECT memory_id FROM project_memories WHERE project_id = ?", [boostProject]).map((r) => r.memory_id as string))
      : null;

    // Retrieval learning: explicit "useful / not useful" feedback nudges ranking (bounded, ±0.04).
    const fb = new Map<string, number>();
    if (mems.length) {
      try {
        for (const r of this.db.all<Row>(`SELECT memory_id, SUM(CASE WHEN useful = 1 THEN 1 ELSE -1 END) AS net, COUNT(*) AS n FROM retrieval_feedback WHERE memory_id IN (${mems.map(() => "?").join(",")}) GROUP BY memory_id`, mems.map((m) => m.id)))
          fb.set(r.memory_id as string, Math.max(-1, Math.min(1, Number(r.net) / Math.max(3, Number(r.n)))));
      } catch {
        /* table missing on very old databases */
      }
    }
    const out: ScoredMemory[] = [];
    for (const m of mems) {
      const status = filters.status ?? "active";
      if (status === "active" && m.status !== "active") continue;
      if (status === "archived" && m.status === "active") continue;
      if (filters.project_id && m.project_id !== filters.project_id && !projectMembers?.has(m.id)) continue;
      if (filters.category && m.category !== filters.category) continue;
      if (filters.categories?.length && !filters.categories.includes(m.category)) continue;
      if (filters.tags?.length && !filters.tags.every((t) => m.tags.includes(t))) continue;
      if (filters.since && m.updated_at < filters.since) continue;
      if (filters.until && m.updated_at > filters.until) continue;
      if (relatedSet && !relatedSet.has(m.id)) continue;

      const ageDays = (now - Date.parse(m.updated_at)) / 86_400_000;
      const signals = {
        keyword: kw.get(m.id) ?? 0,
        semantic: sem.get(m.id) ?? 0,
        project: boostProject && (m.project_id === boostProject || projectMembers?.has(m.id)) ? 1 : 0,
        graph: graph.get(m.id) ?? 0,
        importance: m.importance,
        recency: Math.pow(0.5, ageDays / 30),
        confidence: m.confidence,
      };
      // Textual relevance is required: metadata alone must never pull in unrelated memories.
      const textual = Math.max(signals.keyword, signals.semantic, signals.graph * 0.8);
      if (textual < 0.08) continue;
      let score =
        WEIGHTS.semantic * signals.semantic + WEIGHTS.keyword * signals.keyword + WEIGHTS.project * signals.project + WEIGHTS.graph * signals.graph +
        WEIGHTS.importance * signals.importance + WEIGHTS.recency * signals.recency + WEIGHTS.confidence * signals.confidence;
      score += 0.04 * (fb.get(m.id) ?? 0);
      if (m.flags.includes("possible_prompt_injection")) score *= 0.7;
      if (m.verification === "disputed") score *= 0.8;
      score = Math.min(1, score);
      if (score < minScore) continue;
      const why: string[] = [];
      if (signals.keyword > 0.3) why.push("matches your words");
      if (signals.semantic > 0.4) why.push("similar meaning");
      if (signals.project) why.push("same project");
      if (signals.graph > 0) why.push("connected to a strong match");
      if (signals.recency > 0.8) why.push("recent");
      if (m.importance >= 0.75) why.push("important");
      if ((fb.get(m.id) ?? 0) > 0) why.push("marked useful before");
      out.push({ memory: m, score: Math.round(score * 1000) / 1000, signals, why });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}
