// Awareness Engine: finds things worth the user's attention, from explicit records only.
//
// Categories (each finding names its evidence):
//  - unresolved_decision  an open "unresolved decision" project item
//  - blocker              an open blocker
//  - incomplete_work      tasks recorded as open, and next steps / open issues from the latest session handoff
//  - knowledge_gap        an open decision or blocker about which MOTH has nothing stored (search found nothing related)
//  - research_review      research related to an open item that has no source or is marked speculative / disputed
//  - relevant_lesson      a lesson or solution (same project, or another project that allows knowledge transfer)
//                         that matches an open blocker or decision
//  - conflicting_requirements  decisions or requirements in a project flagged as possibly contradicting each other
//
// Never inferred from silence: a topic not mentioned recently is not "unfinished". Dismissed findings stay dismissed
// unless their evidence changes; findings whose cause disappeared (decision taken, blocker cleared, task done) are
// resolved automatically after the next scan, and stay in history.
import type { Row } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { truncate } from "../engine/text.ts";
import type { Memory, Project } from "../engine/types.ts";
import type { FindingInput } from "./findings.ts";
import type { Subject } from "./permissions.ts";

export const AWARENESS_CATEGORIES = {
  unresolved_decision: "Unresolved decisions",
  blocker: "Blockers",
  incomplete_work: "Incomplete work",
  knowledge_gap: "Knowledge gaps",
  research_review: "Research to review",
  relevant_lesson: "Relevant earlier lessons",
  conflicting_requirements: "Possibly conflicting requirements",
} as const;
export type AwarenessCategory = keyof typeof AWARENESS_CATEGORIES;

const DAY = 86_400_000;
const age = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
};

/** Change-feed position of the last knowledge change (memories, projects, items, handoffs): new work exists when it moves. */
export function knowledgeChangeMark(brain: Brain): number {
  return Number(brain.db.value("SELECT MAX(id) FROM db_changes WHERE entity IN ('memory','relationship','project','project_item','handoff')") ?? 0);
}

export class Awareness {
  constructor(private brain: Brain) {}

  /** Scans every project the subject may read. Cancellable; idempotent (findings are deduplicated). */
  async scan(opts: { as?: Subject | string; project?: string | null; signal?: AbortSignal; jobId?: number | null } = {}): Promise<Row> {
    const t0 = Date.now();
    const b = this.brain;
    const as = opts.as ?? "background";
    b.permissions.assert(as, "create_analysis", null, "save awareness findings");
    const stop = () => {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Cancelled");
    };
    const all = b.store.listProjects(false).filter((p) => !p.is_demo);
    const scope = opts.project ? all.filter((p) => p.id === b.store.requireProject(opts.project!).id) : all;
    const projects: Project[] = [];
    let skipped = 0;
    for (const p of scope) {
      if (b.permissions.allowed(as, "read_projects", p.id) && b.permissions.allowed(as, "read_memories", p.id)) projects.push(p);
      else skipped++;
    }
    const inputs = new Map<AwarenessCategory, Omit<FindingInput, "kind" | "category" | "algorithm">[]>();
    const push = (c: AwarenessCategory, i: Omit<FindingInput, "kind" | "category" | "algorithm">) => {
      const list = inputs.get(c) ?? [];
      list.push(i);
      inputs.set(c, list);
    };

    for (const p of projects) {
      stop();
      await new Promise((r) => setImmediate(r));
      const items = b.db.all<Row>("SELECT * FROM project_items WHERE project_id = ? AND status = 'open' ORDER BY created_at", [p.id]);
      const mems = b.db.all<Row>("SELECT * FROM memories WHERE user_id = ? AND project_id = ? AND status = 'active'", [b.store.userId, p.id]).map((r) => b.store.toMemory(r));
      const memIds = new Set(mems.map((m) => m.id));

      for (const it of items) {
        if (it.kind !== "unresolved_decision" && it.kind !== "blocker") continue;
        const isBlocker = it.kind === "blocker";
        const linked = it.memory_id && memIds.has(it.memory_id as string) ? [it.memory_id as string] : [];
        push(isBlocker ? "blocker" : "unresolved_decision", {
          key: [it.id as string],
          evidenceKey: [String(it.title), String(it.detail ?? "")],
          title: isBlocker ? `Blocker in ${p.name}: ${truncate(String(it.title), 90)}` : `Undecided in ${p.name}: ${truncate(String(it.title), 90)}`,
          description: `${isBlocker ? "Recorded as blocking progress" : "Recorded as not decided yet"} ${age(String(it.created_at))}${it.detail ? `: ${truncate(String(it.detail), 200)}` : "."}`,
          project_id: p.id,
          project_ids: [p.id],
          memory_ids: linked,
          evidence: [{ project_id: p.id, source_ref: `project_item:${it.id}`, note: `${isBlocker ? "Blocker" : "Unresolved decision"} "${it.title}", added ${String(it.created_at).slice(0, 10)} by ${it.created_by}` }],
          source_refs: [`project_item:${it.id}`],
          evidence_status: "confirmed",
          severity: isBlocker ? "high" : "medium",
          confidence: 1,
          suggested_action: isBlocker ? "Clear the blocker, or record what's needed to clear it" : "Decide it, then record the decision in the project",
          action: { type: "open_item", project_id: p.id, item_id: it.id },
        });

        // Knowledge gap / relevant lessons / research to review for this item.
        const text = `${it.title} ${it.detail ?? ""}`;
        const sims = b.search.similarToText(text, 40).filter((h) => h.id !== it.memory_id);
        const related: { m: Memory; score: number }[] = [];
        for (const h of sims) {
          if (h.score < 0.22) break;
          const m = b.store.getMemory(h.id);
          if (!m || m.status !== "active") continue;
          related.push({ m, score: h.score });
        }
        const usable = related.filter((r) => r.m.project_id === p.id || this.transferOk(p, r.m));
        if (!usable.length) {
          push("knowledge_gap", {
            key: [it.id as string],
            evidenceKey: [String(it.title)],
            title: `Nothing stored about: ${truncate(String(it.title), 90)}`,
            description: `MOTH searched your memories for anything related to this open ${isBlocker ? "blocker" : "decision"} in ${p.name} and found nothing. Research or notes about it would help.`,
            project_id: p.id,
            project_ids: [p.id],
            memory_ids: [],
            evidence: [{ project_id: p.id, source_ref: `project_item:${it.id}`, note: "Search returned no related memory (word-based similarity below 0.22)" }],
            source_refs: [`project_item:${it.id}`],
            evidence_status: "possible",
            severity: "info",
            confidence: null,
            suggested_action: "Research it, or save what you already know about it",
            action: { type: "open_item", project_id: p.id, item_id: it.id },
          });
        }
        for (const r of usable) {
          const m = r.m;
          const isLesson = m.memory_type === "lesson" || m.category === "solution" || m.memory_type === "procedural";
          const isResearch = m.memory_type === "research" || m.category === "research";
          if (isLesson && r.score >= 0.3) {
            const from = m.project_id && m.project_id !== p.id ? b.store.getProject(m.project_id)?.name ?? null : null;
            push("relevant_lesson", {
              key: [it.id as string, m.id],
              title: `An earlier ${m.memory_type === "lesson" ? "lesson" : "solution"} may help: ${truncate(m.title, 80)}`,
              description: `It matches the open ${isBlocker ? "blocker" : "decision"} "${truncate(String(it.title), 80)}" in ${p.name} (similarity ${r.score.toFixed(2)})${from ? `. It comes from ${from}: check it applies here` : ""}.`,
              project_id: p.id,
              project_ids: [...new Set([p.id, m.project_id].filter(Boolean) as string[])],
              memory_ids: [m.id],
              evidence: [
                { project_id: p.id, source_ref: `project_item:${it.id}`, note: `Open ${isBlocker ? "blocker" : "decision"}: ${it.title}` },
                { memory_id: m.id, quote: truncate(m.content, 200), note: m.title },
              ],
              source_refs: [`project_item:${it.id}`],
              evidence_status: "possible",
              severity: "low",
              confidence: Math.round(r.score * 100) / 100,
              suggested_action: "Read the lesson before working on this",
              action: { type: "open_memory", memory_id: m.id },
            });
          }
          if (isResearch && r.score >= 0.3) {
            const sources = Number(b.db.value("SELECT COUNT(*) FROM memory_sources WHERE memory_id = ?", [m.id]) ?? 0);
            if (sources > 0 && m.evidence !== "speculative" && m.verification !== "disputed") continue;
            push("research_review", {
              key: [it.id as string, m.id],
              evidenceKey: [String(sources), String(m.evidence), m.verification],
              title: `Check this research before relying on it: ${truncate(m.title, 80)}`,
              description: `It's related to "${truncate(String(it.title), 80)}" in ${p.name}, but ${sources === 0 ? "it has no source" : m.evidence === "speculative" ? "it's marked as speculation" : "it's disputed"}.`,
              project_id: p.id,
              project_ids: [...new Set([p.id, m.project_id].filter(Boolean) as string[])],
              memory_ids: [m.id],
              evidence: [{ memory_id: m.id, note: `sources: ${sources}, evidence: ${m.evidence ?? "not set"}, verification: ${m.verification}` }],
              source_refs: [`project_item:${it.id}`],
              evidence_status: "confirmed",
              severity: "low",
              confidence: Math.round(r.score * 100) / 100,
              suggested_action: "Verify it or add its source",
              action: { type: "open_memory", memory_id: m.id },
            });
          }
        }
      }

      // Incomplete documented work: open tasks (grouped per project) + the latest handoff's open ends.
      const open = mems.filter((m) => m.task_state === "open");
      if (open.length) {
        push("incomplete_work", {
          key: [p.id, "tasks"],
          evidenceKey: open.map((m) => m.id),
          title: `${open.length} open task${open.length === 1 ? "" : "s"} in ${p.name}`,
          description: `Recorded as not done: ${open.slice(0, 4).map((m) => `"${truncate(m.title, 50)}"`).join(", ")}${open.length > 4 ? ` and ${open.length - 4} more` : ""}.`,
          project_id: p.id,
          project_ids: [p.id],
          memory_ids: open.slice(0, 20).map((m) => m.id),
          evidence: open.slice(0, 8).map((m) => ({ memory_id: m.id, note: `task "${m.title}" recorded as open ${age(m.updated_at)}` })),
          evidence_status: "confirmed",
          severity: "info",
          confidence: 1,
          suggested_action: "Mark finished tasks as done, or continue the next one",
          action: { type: "open_project", project_id: p.id },
        });
      }
      const h = b.handoffs.latest(p.id);
      if (h && ((h.next_steps as string[]).length || (h.unresolved as string[]).length)) {
        push("incomplete_work", {
          key: [p.id, "handoff"],
          evidenceKey: [String(h.id), String(h.version)],
          title: `Picking up ${p.name}: ${(h.next_steps as string[]).length ? truncate((h.next_steps as string[])[0], 80) : truncate((h.unresolved as string[])[0], 80)}`,
          description: `The last session handoff (${age(String(h.updated_at))}) left ${(h.next_steps as string[]).length} next step${(h.next_steps as string[]).length === 1 ? "" : "s"} and ${(h.unresolved as string[]).length} open issue${(h.unresolved as string[]).length === 1 ? "" : "s"}.`,
          project_id: p.id,
          project_ids: [p.id],
          memory_ids: (h.memory_ids as string[]).filter((x) => memIds.has(x)),
          evidence: [{ project_id: p.id, source_ref: `handoff:${h.id}`, note: [...(h.next_steps as string[]).map((x) => `next: ${x}`), ...(h.unresolved as string[]).map((x) => `open: ${x}`)].slice(0, 6).join("; ") }],
          source_refs: [`handoff:${h.id}`],
          evidence_status: "confirmed",
          severity: "low",
          confidence: 1,
          suggested_action: "Resume the project",
          action: { type: "resume_project", project_id: p.id },
        });
      }

      // Possibly conflicting requirements: decisions/requirements flagged as possibly contradicting.
      const flagged = mems.filter((m) => (m.category === "decision" || m.memory_type === "preference") && m.flags.includes("possible_conflict"));
      for (const m of flagged) {
        push("conflicting_requirements", {
          key: [m.id],
          title: `Requirement may conflict in ${p.name}: ${truncate(m.title, 80)}`,
          description: "MOTH flagged this decision as possibly contradicting another one. Working from the wrong one could waste effort.",
          project_id: p.id,
          project_ids: [p.id],
          memory_ids: [m.id],
          evidence: [{ memory_id: m.id, quote: truncate(m.content, 200), note: "flag: possible_conflict" }],
          evidence_status: "possible",
          severity: "medium",
          confidence: null,
          suggested_action: "Decide which one is right (review queue or edit the memory)",
          action: { type: "open_memory", memory_id: m.id },
        });
      }
    }

    // Store, and resolve findings whose cause disappeared. A scan of one project only reconciles that project.
    const stats: Row = {};
    for (const c of Object.keys(AWARENESS_CATEGORIES) as AwarenessCategory[]) {
      const list = inputs.get(c) ?? [];
      const present = new Set<number>();
      let created = 0;
      for (const i of list) {
        const r = b.findings.upsert({ ...i, kind: "awareness", category: c, algorithm: `awareness/${c}-v1`, job_id: opts.jobId ?? null, agent: as.startsWith("agent:") ? as : null });
        if (r.id !== null && r.outcome !== "rejected" && r.outcome !== "suppressed") present.add(r.id);
        if (r.outcome === "created") created++;
      }
      let resolved = 0;
      if (opts.project) {
        const pid = scope[0]?.id;
        const rows = b.db.all<Row>("SELECT id FROM findings WHERE user_id = ? AND kind = 'awareness' AND category = ? AND status IN ('new','viewed') AND project_id = ?", [b.store.userId, c, pid]);
        for (const r of rows) if (!present.has(Number(r.id))) (b.findings.resolve(Number(r.id), "No longer present (the cause was resolved)"), resolved++);
      } else {
        // Projects this subject may not read are left untouched.
        const readable = new Set(projects.map((p) => p.id));
        const rows = b.db.all<Row>("SELECT id, project_id FROM findings WHERE user_id = ? AND kind = 'awareness' AND category = ? AND status IN ('new','viewed')", [b.store.userId, c]);
        for (const r of rows) if (!present.has(Number(r.id)) && (!r.project_id || readable.has(r.project_id as string) || !all.some((p) => p.id === r.project_id))) (b.findings.resolve(Number(r.id), "No longer present (the cause was resolved)"), resolved++);
      }
      stats[c] = { found: list.length, created, resolved };
    }
    const out = { projects: projects.length, skipped_projects: skipped, categories: stats, ms: Date.now() - t0 };
    b.store.logActivity({ kind: "awareness", source: as, action: "scan", duration_ms: out.ms, detail: out });
    return out;
  }

  private transferOk(p: Project, m: Memory): boolean {
    if (!m.project_id) return m.scope !== "private";
    if (m.scope === "private" || m.category === "decision" || m.category === "preference") return false;
    const other = this.brain.store.getProject(m.project_id);
    return !!other && !other.private && other.transfer_enabled && p.transfer_enabled;
  }
}
