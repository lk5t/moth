// Builds compact, ranked context packages for Claude at the start of a task.
import type { Row } from "../db/database.ts";
import { UNTRUSTED_NOTICE } from "./security.ts";
import type { SearchEngine, ScoredMemory } from "./search.ts";
import type { MemoryStore } from "./store.ts";
import { estimateTokens, jaccard, tokenize, truncate } from "./text.ts";
import type { Memory, Project } from "./types.ts";

export interface ContextItem {
  id: string;
  title: string;
  category: string;
  summary: string;
  excerpt: string;
  project: string | null;
  updated_at: string;
  score: number;
  why: string[];
  flags: string[];
  task_state?: string | null;
  memory_type: string;
  source: string;
  confidence: number;
  pinned: boolean;
}

export interface ContextPackage {
  notice: string;
  query: string;
  project: null | { id: string; name: string; description: string; goals: string; status: string; files: string[]; last_activity_at: string | null };
  project_candidates: { id: string; name: string; score: number; why: string }[];
  sections: {
    decisions: ContextItem[];
    open_tasks: ContextItem[];
    errors_and_solutions: ContextItem[];
    relevant: ContextItem[];
  };
  stats: { items: number; approx_tokens: number; token_budget: number; searched_memories: number; empty: boolean };
}

function toItem(store: MemoryStore, s: { memory: Memory; score: number; why: string[] }, projectNames: Map<string, string>, excerptLen: number): ContextItem {
  const m = s.memory;
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    summary: m.summary,
    excerpt: truncate(m.content, excerptLen),
    project: m.project_id ? projectNames.get(m.project_id) ?? null : null,
    updated_at: m.updated_at,
    score: s.score,
    why: s.why,
    flags: m.flags,
    task_state: m.task_state,
    memory_type: m.memory_type,
    source: m.source,
    confidence: m.confidence,
    pinned: m.pinned,
  };
}

export function detectProjects(store: MemoryStore, search: SearchEngine, text: string): { project: Project; score: number; why: string }[] {
  const projects = store.listProjects();
  if (!projects.length) return [];
  const qTokens = tokenize(text);
  const lower = text.toLowerCase();
  const out: { project: Project; score: number; why: string }[] = [];
  for (const p of projects) {
    let score = 0;
    let why = "";
    const names = [p.name, ...p.aliases];
    for (const n of names) {
      if (n && lower.includes(n.toLowerCase())) {
        score = Math.max(score, 1);
        why = `task mentions "${n}"`;
      }
    }
    if (score < 1) {
      const nameTok = tokenize(names.join(" "));
      const j = jaccard(qTokens, nameTok);
      const overlap = nameTok.filter((t) => qTokens.includes(t)).length / Math.max(1, nameTok.length);
      if (overlap > 0) {
        score = Math.max(score, 0.45 + 0.5 * overlap + j * 0.2);
        why = "task shares words with the project name";
      }
      const descTok = tokenize(`${p.description} ${p.goals}`);
      const dOverlap = qTokens.filter((t) => descTok.includes(t)).length;
      if (dOverlap > 0) {
        const s = Math.min(0.75, 0.3 + 0.15 * dOverlap);
        if (s > score) {
          score = s;
          why = `task matches the project description (${qTokens.filter((t) => descTok.includes(t)).slice(0, 3).join(", ")})`;
        }
      }
    }
    if (p.hub_memory_id) {
      const sim = search.similarToText(text, 40).find((x) => x.id === p.hub_memory_id)?.score ?? 0;
      if (sim * 0.9 > score) {
        score = sim * 0.9;
        why = "task is similar to the project summary";
      }
    }
    if (score > 0.25) out.push({ project: p, score: Math.round(score * 100) / 100, why });
  }
  // Ties are broken by recent activity: "my Roblox game" most likely means the one worked on last.
  return out.sort((a, b) => b.score - a.score || String(b.project.last_activity_at).localeCompare(String(a.project.last_activity_at)));
}

export async function buildContext(
  store: MemoryStore,
  search: SearchEngine,
  query: string,
  opts: { project?: string | null; tokenBudget?: number; minScore?: number; maxItems?: number } = {},
): Promise<ContextPackage> {
  const budget = Math.max(300, Math.min(opts.tokenBudget ?? store.settings.get("retrieval.tokenBudget"), 12000));
  const minScore = opts.minScore ?? store.settings.get("retrieval.minScore");
  const maxItems = Math.max(1, Math.min(opts.maxItems ?? store.settings.get("retrieval.maxItems"), 40));

  let project: Project | null = null;
  let candidates: { project: Project; score: number; why: string }[] = [];
  if (opts.project) project = store.getProject(opts.project);
  if (!project) {
    candidates = detectProjects(store, search, query);
    const top = candidates[0];
    const second = candidates[1];
    if (top && top.score >= 0.55 && (!second || top.score - second.score >= 0.1 || top.score >= 1)) project = top.project;
    else if (top && top.score >= 0.55 && second && Math.abs(top.score - second.score) < 0.1) project = top.project; // ambiguous: most recent wins, candidates returned
  }

  const projectNames = new Map(store.listProjects(true).map((p) => [p.id, p.name]));
  // Private projects never leak into other contexts; preferences arrive through their own section.
  const scored = await search.hybrid(query, { hide_private_except: project?.id ?? null }, { limit: 60, minScore, boostProjectId: project?.id ?? null, seedIds: project?.hub_memory_id ? [project.hub_memory_id] : [] });

  // Within a project, pull its key structured knowledge even if wording differs from the query.
  const extra: ScoredMemory[] = [];
  if (project) {
    const pid = project.id;
    const pick = (sql: string, why: string, base: number) => {
      for (const r of store.db.all<Row>(sql, [pid, pid])) {
        const m = store.toMemory(r);
        if (scored.some((s) => s.memory.id === m.id) || extra.some((s) => s.memory.id === m.id)) continue;
        extra.push({ memory: m, score: base, signals: { keyword: 0, semantic: 0, project: 1, graph: 0, importance: m.importance, recency: 0, confidence: m.confidence }, why: [why] });
      }
    };
    const inProject = "(project_id = ? OR id IN (SELECT memory_id FROM project_memories WHERE project_id = ?)) AND status = 'active'";
    pick(`SELECT * FROM memories WHERE ${inProject} AND category = 'decision' ORDER BY importance DESC, updated_at DESC LIMIT 5`, "key project decision", 0.42);
    pick(`SELECT * FROM memories WHERE ${inProject} AND category = 'task' AND task_state = 'open' ORDER BY importance DESC, updated_at DESC LIMIT 6`, "unfinished project task", 0.4);
    pick(`SELECT * FROM memories WHERE ${inProject} AND category IN ('error','solution') ORDER BY updated_at DESC LIMIT 4`, "recent project problem/fix", 0.36);
  }

  // Keep other projects' memories out unless they are very strong matches (prevents mixing projects).
  const all = [...scored, ...extra]
    .filter((s) => !project || !s.memory.project_id || s.memory.project_id === project.id || s.score >= 0.6)
    .filter((s) => s.memory.category !== "project" || s.memory.id !== project?.hub_memory_id)
    .filter((s) => s.memory.memory_type !== "preference")
    .sort((a, b) => b.score - a.score);

  const sections: ContextPackage["sections"] = { decisions: [], open_tasks: [], errors_and_solutions: [], relevant: [] };
  let used = estimateTokens(UNTRUSTED_NOTICE) + (project ? estimateTokens(`${project.description} ${project.goals} ${project.status}`) + 40 : 0);
  let count = 0;
  for (const s of all) {
    if (count >= maxItems) break;
    const excerptLen = count < 4 ? 900 : 360;
    const item = toItem(store, s, projectNames, excerptLen);
    const cost = estimateTokens(`${item.title} ${item.summary} ${item.excerpt}`) + 25;
    if (used + cost > budget) {
      const short = { ...item, excerpt: "" };
      const shortCost = estimateTokens(`${item.title} ${item.summary}`) + 20;
      if (used + shortCost > budget) continue;
      used += shortCost;
      pushItem(sections, short);
    } else {
      used += cost;
      pushItem(sections, item);
    }
    count++;
  }
  const ids = [...sections.decisions, ...sections.open_tasks, ...sections.errors_and_solutions, ...sections.relevant].map((i) => i.id);
  if (ids.length) store.touch(ids);

  return {
    notice: UNTRUSTED_NOTICE,
    query,
    project: project
      ? { id: project.id, name: project.name, description: project.description, goals: project.goals, status: project.status, files: project.files.slice(-25), last_activity_at: project.last_activity_at }
      : null,
    project_candidates: candidates.slice(0, 4).map((c) => ({ id: c.project.id, name: c.project.name, score: c.score, why: c.why })),
    sections,
    stats: {
      items: ids.length,
      approx_tokens: used,
      token_budget: budget,
      searched_memories: Number(store.db.value("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active'", [store.userId]) ?? 0),
      empty: ids.length === 0,
    },
  };
}

function pushItem(sections: ContextPackage["sections"], item: ContextItem) {
  if (item.category === "decision") sections.decisions.push(item);
  else if (item.category === "task" && item.task_state === "open") sections.open_tasks.push(item);
  else if (item.category === "error" || item.category === "solution") sections.errors_and_solutions.push(item);
  else sections.relevant.push(item);
}

export function contextIds(pkg: ContextPackage): string[] {
  return [...pkg.sections.decisions, ...pkg.sections.open_tasks, ...pkg.sections.errors_and_solutions, ...pkg.sections.relevant].map((i) => i.id);
}
