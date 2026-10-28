// Project Intelligence 2.0: a project as a structured workspace.
//
// What a project knows comes from two places:
//  - memories that belong to it (decisions, tasks with their open/done state, research, lessons, everything else);
//  - project items (this module): objectives, unresolved decisions, blockers and milestones — things a memory
//    didn't capture well because they have a lifecycle (open → resolved / done / dropped).
//
// Rules this module keeps:
//  - Progress is only shown when real records back it (milestones or tasks with a done/open state). Otherwise the
//    progress is "unknown"; MOTH never estimates a percentage.
//  - Every line of a summary or resume briefing points to the record it came from (memory, item or handoff).
//  - Project boundaries: a briefing only uses another project's knowledge when both projects allow knowledge
//    transfer, the other project isn't private, the memory isn't private, and it's reusable knowledge (research,
//    lesson, solution) — never another project's requirements, decisions or preferences. Each such item says why.
import type { Database, Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { SearchEngine } from "../engine/search.ts";
import { newId, type MemoryStore } from "../engine/store.ts";
import { truncate } from "../engine/text.ts";
import { MothError, type Memory, type Project } from "../engine/types.ts";
import type { Handoffs } from "./handoffs.ts";
import type { Permissions, Subject } from "./permissions.ts";

export const ITEM_KINDS = ["objective", "unresolved_decision", "blocker", "milestone"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_STATUSES = ["open", "resolved", "done", "dropped"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_LABEL: Record<ItemKind, string> = {
  objective: "Objective",
  unresolved_decision: "Unresolved decision",
  blocker: "Blocker",
  milestone: "Milestone",
};

export interface ItemInput {
  kind: ItemKind;
  title: string;
  detail?: string;
  memory_id?: string | null;
  source?: string;
  source_ref?: string | null;
}

/** Reference to the record a statement came from. */
export interface Ref {
  type: "memory" | "item" | "handoff" | "project";
  id: string;
  at?: string | null;
  title?: string;
}

const REUSABLE = new Set(["research", "lesson", "procedural"]);

export class ProjectIntel {
  constructor(
    private db: Database,
    private store: MemoryStore,
    private search: SearchEngine,
    private handoffs: Handoffs,
    private permissions: Permissions,
  ) {}

  private project(idOrName: string, as?: Subject | string): Project {
    const p = this.store.requireProject(idOrName);
    if (as) this.permissions.assert(as, "read_projects", p.id, `project ${p.name}`);
    return p;
  }

  // ------------------------------------------------------------------ items
  addItem(project: string, input: ItemInput, by = "user"): Row {
    const p = this.project(project);
    if (!(ITEM_KINDS as readonly string[]).includes(input.kind)) throw new MothError("invalid_input", `Unknown item kind "${input.kind}"`);
    const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (title.length < 2) throw new MothError("invalid_input", "Give it a short title");
    if (input.memory_id && !this.store.getMemory(input.memory_id)) throw new MothError("not_found", `No memory ${input.memory_id}`);
    const dup = this.db.get<Row>("SELECT id FROM project_items WHERE project_id = ? AND kind = ? AND status = 'open' AND lower(title) = lower(?)", [p.id, input.kind, title]);
    if (dup) return this.getItem(dup.id as string);
    const id = newId("pit");
    const t = nowIso();
    this.db.run(
      `INSERT INTO project_items(id, user_id, project_id, kind, title, detail, status, memory_id, source, source_ref, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?)`,
      [id, this.store.userId, p.id, input.kind, title, String(input.detail ?? "").slice(0, 4000), input.memory_id ?? null, (input.source ?? "user").slice(0, 60), input.source_ref ?? null, by.slice(0, 60), t, t],
    );
    this.store.logActivity({ kind: "project", source: by, action: "item_added", detail: { project: p.name, kind: input.kind, title } });
    return this.getItem(id);
  }

  getItem(id: string): Row {
    const r = this.db.get<Row>("SELECT * FROM project_items WHERE id = ? AND user_id = ?", [id, this.store.userId]);
    if (!r) throw new MothError("not_found", `No project item ${id}`);
    return r;
  }

  updateItem(id: string, patch: { title?: string; detail?: string }, by = "user"): Row {
    const it = this.getItem(id);
    const title = patch.title !== undefined ? String(patch.title).replace(/\s+/g, " ").trim().slice(0, 300) : (it.title as string);
    if (title.length < 2) throw new MothError("invalid_input", "Give it a short title");
    this.db.run("UPDATE project_items SET title = ?, detail = ?, updated_at = ? WHERE id = ?", [title, patch.detail !== undefined ? String(patch.detail).slice(0, 4000) : it.detail, nowIso(), id]);
    this.store.logActivity({ kind: "project", source: by, action: "item_edited", detail: { id } });
    return this.getItem(id);
  }

  /**
   * Closes an item. Resolving an unresolved decision with a written resolution also records that decision as a
   * memory in the project (so it shows up wherever decisions do), linked from the item.
   */
  resolveItem(id: string, opts: { status?: Exclude<ItemStatus, "open">; resolution?: string; record_decision?: boolean } = {}, by = "user"): Row {
    const it = this.getItem(id);
    if (it.status !== "open") throw new MothError("invalid_input", `This item is already ${it.status}`);
    const status = opts.status ?? (it.kind === "milestone" || it.kind === "objective" ? "done" : "resolved");
    if (!(ITEM_STATUSES as readonly string[]).includes(status) || (status as string) === "open") throw new MothError("invalid_input", `Unknown status "${status}"`);
    const resolution = String(opts.resolution ?? "").trim().slice(0, 4000);
    const t = nowIso();
    return this.db.tx(() => {
      let memId: string | null = null;
      if (it.kind === "unresolved_decision" && resolution && opts.record_decision !== false && status === "resolved") {
        const m = this.store.createMemory(
          { title: `Decision: ${truncate(it.title as string, 120)}`, content: `${it.title}\n\nDecided: ${resolution}`, category: "decision", project_id: it.project_id as string, source: by === "user" ? "user" : by, importance: 0.7 },
          { actor: by === "user" ? "user" : "moth", reason: "Unresolved decision resolved" },
        );
        memId = m.id;
      }
      this.db.run("UPDATE project_items SET status = ?, resolution = ?, resolution_memory_id = ?, resolved_at = ?, updated_at = ? WHERE id = ?", [status, resolution || null, memId, t, t, id]);
      this.store.logActivity({ kind: "project", source: by, action: `item_${status}`, detail: { id, title: it.title, memory_id: memId } });
      return this.getItem(id);
    });
  }

  reopenItem(id: string, by = "user"): Row {
    const it = this.getItem(id);
    if (it.status === "open") return it;
    this.db.run("UPDATE project_items SET status = 'open', resolved_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
    this.store.logActivity({ kind: "project", source: by, action: "item_reopened", detail: { id } });
    return this.getItem(id);
  }

  listItems(project: string, f: { kind?: ItemKind; status?: ItemStatus | "all" } = {}, as?: Subject | string): Row[] {
    const p = this.project(project, as);
    const where = ["project_id = ?"];
    const params: unknown[] = [p.id];
    if (f.kind) (where.push("kind = ?"), params.push(f.kind));
    if (f.status && f.status !== "all") (where.push("status = ?"), params.push(f.status));
    return this.db.all<Row>(`SELECT * FROM project_items WHERE ${where.join(" AND ")} ORDER BY status = 'open' DESC, created_at ASC`, params);
  }

  // ------------------------------------------------------------------ state
  private memoriesOf(p: Project): Memory[] {
    return this.db
      .all<Row>("SELECT * FROM memories WHERE user_id = ? AND project_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 2000", [this.store.userId, p.id])
      .map((r) => this.store.toMemory(r));
  }

  /** Evidence-based progress: confirmed from milestones (preferred) or tasks; otherwise unknown. */
  progress(items: Row[], mems: Memory[]): Row {
    const ms = items.filter((i) => i.kind === "milestone" && i.status !== "dropped");
    if (ms.length) {
      const done = ms.filter((i) => i.status === "done").length;
      return { status: "confirmed", basis: "milestones", done, total: ms.length, percent: Math.round((done / ms.length) * 100), note: `${done} of ${ms.length} saved milestones are marked done.` };
    }
    const tasks = mems.filter((m) => m.task_state === "open" || m.task_state === "done");
    if (tasks.length) {
      const done = tasks.filter((m) => m.task_state === "done").length;
      return { status: "confirmed", basis: "tasks", done, total: tasks.length, percent: Math.round((done / tasks.length) * 100), note: `${done} of ${tasks.length} recorded tasks are done. Work that was never recorded as a task isn't counted.` };
    }
    return { status: "unknown", basis: null, done: null, total: null, percent: null, note: "No milestones or tasks are recorded, so MOTH can't tell how far along this is." };
  }

  /** The full structured state of a project. `as` = who is asking (permission-checked unless it's the user). */
  state(project: string, as?: Subject | string): Row {
    const p = this.project(project, as);
    const mems = this.memoriesOf(p);
    const items = this.listItems(p.id);
    const ref = (m: Memory): Row => ({ id: m.id, title: m.title, summary: truncate(m.summary || m.content, 240), updated_at: m.updated_at, category: m.category, memory_type: m.memory_type });
    const latest = this.handoffs.latest(p.id);
    const lastMem = mems[0];
    const lastItem = this.db.get<Row>("SELECT title, kind, updated_at FROM project_items WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1", [p.id]);
    const candidates: { at: string; what: string; ref: Ref }[] = [];
    if (lastMem) candidates.push({ at: lastMem.updated_at, what: `Memory "${lastMem.title}" ${lastMem.created_at === lastMem.updated_at ? "added" : "updated"}`, ref: { type: "memory", id: lastMem.id } });
    if (lastItem) candidates.push({ at: lastItem.updated_at as string, what: `${ITEM_LABEL[lastItem.kind as ItemKind]} "${lastItem.title}" changed`, ref: { type: "project", id: p.id } });
    if (latest) candidates.push({ at: latest.updated_at as string, what: `Session handoff saved (${latest.client})`, ref: { type: "handoff", id: latest.id as string } });
    candidates.sort((a, b) => b.at.localeCompare(a.at));
    return {
      project: { id: p.id, name: p.name, description: p.description, goals: p.goals, status: p.status, private: p.private, transfer_enabled: p.transfer_enabled, created_at: p.created_at },
      objectives: items.filter((i) => i.kind === "objective"),
      decisions: mems.filter((m) => m.category === "decision").slice(0, 25).map(ref),
      completed_work: [
        ...items.filter((i) => i.kind === "milestone" && i.status === "done").map((i) => ({ id: i.id, title: i.title, at: i.resolved_at, ref: { type: "item", id: i.id } })),
        ...mems.filter((m) => m.task_state === "done").slice(0, 25).map((m) => ({ id: m.id, title: m.title, at: m.updated_at, ref: { type: "memory", id: m.id } })),
      ],
      open_tasks: mems.filter((m) => m.task_state === "open").slice(0, 25).map(ref),
      unresolved_decisions: items.filter((i) => i.kind === "unresolved_decision" && i.status === "open"),
      blockers: items.filter((i) => i.kind === "blocker" && i.status === "open"),
      milestones: items.filter((i) => i.kind === "milestone"),
      resolved_items: items.filter((i) => i.status !== "open" && i.kind !== "milestone" && i.kind !== "objective").slice(0, 20),
      research: mems.filter((m) => m.memory_type === "research" || m.category === "research").slice(0, 20).map(ref),
      lessons: mems.filter((m) => m.memory_type === "lesson").slice(0, 20).map(ref),
      related_memories: { count: mems.length, recent: mems.slice(0, 8).map(ref) },
      last_meaningful_activity: candidates[0] ?? null,
      latest_handoff: latest,
      progress: this.progress(items, mems),
    };
  }

  // ------------------------------------------------------------------ resume
  /** May memories of `other` be suggested inside `p`? (project boundaries) */
  private transferAllowed(p: Project, otherId: string | null): { ok: boolean; other?: Project } {
    if (!otherId || otherId === p.id) return { ok: true };
    const other = this.store.getProject(otherId);
    if (!other) return { ok: false };
    if (!p.transfer_enabled || !other.transfer_enabled || other.private) return { ok: false };
    return { ok: true, other };
  }

  /**
   * Resume Project: what was last completed, what was decided, what's unresolved, which stored research may help,
   * and a next step — each with the record it comes from. Deterministic (no AI), so it's always available and
   * never invents anything; the Project Analyst agent can add a written briefing on top.
   */
  resume(project: string, opts: { as?: Subject | string; crossProject?: boolean } = {}): Row {
    const s = this.state(project, opts.as);
    const p = this.store.requireProject(project);
    const h = s.latest_handoff as Row | null;
    const lastCompleted: Row[] = [];
    if (h) for (const c of (h.completed as string[]).slice(0, 5)) lastCompleted.push({ text: c, ref: { type: "handoff", id: h.id, at: h.updated_at } });
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const seen = new Set(lastCompleted.map((x) => norm(String(x.text))));
    for (const c of (s.completed_work as Row[]).sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? ""))).slice(0, 8)) {
      if (seen.has(norm(String(c.title)))) continue; // same work already listed from the handoff
      seen.add(norm(String(c.title)));
      lastCompleted.push({ text: c.title, ref: { ...(c.ref as Row), at: c.at } });
    }
    const decisions: Row[] = (s.decisions as Row[]).slice(0, 6).map((d) => ({ text: d.title, detail: d.summary, ref: { type: "memory", id: d.id, at: d.updated_at } }));
    if (h) for (const d of (h.decisions as string[]).slice(0, 4)) decisions.push({ text: d, ref: { type: "handoff", id: h.id, at: h.updated_at } });
    const unresolved: Row[] = [
      ...(s.blockers as Row[]).map((i) => ({ kind: "blocker", text: i.title, detail: i.detail, ref: { type: "item", id: i.id, at: i.created_at } })),
      ...(s.unresolved_decisions as Row[]).map((i) => ({ kind: "unresolved_decision", text: i.title, detail: i.detail, ref: { type: "item", id: i.id, at: i.created_at } })),
      ...(s.open_tasks as Row[]).slice(0, 10).map((m) => ({ kind: "open_task", text: m.title, detail: m.summary, ref: { type: "memory", id: m.id, at: m.updated_at } })),
      ...(h ? (h.unresolved as string[]).map((u) => ({ kind: "handoff_unresolved", text: u, ref: { type: "handoff", id: h.id, at: h.updated_at } })) : []),
    ];

    // Stored research / lessons / solutions that match the open questions.
    const helpful = new Map<string, Row>();
    const questions = unresolved.filter((u) => u.kind !== "handoff_unresolved" || true).slice(0, 8);
    for (const q of questions) {
      const text = `${q.text} ${q.detail ?? ""}`;
      for (const hit of this.search.similarToText(text, 30)) {
        if (hit.score < 0.3 || helpful.has(hit.id)) continue;
        const m = this.store.getMemory(hit.id);
        if (!m || m.status !== "active") continue;
        const reusable = REUSABLE.has(m.memory_type) || m.category === "research" || m.category === "solution";
        if (!reusable) continue;
        if (q.ref && (q.ref as Ref).type === "memory" && (q.ref as Ref).id === m.id) continue;
        let fromProject: string | null = null;
        if (m.project_id !== p.id) {
          if (opts.crossProject === false || m.scope === "private") continue;
          if (m.category === "decision" || m.category === "preference") continue; // never another project's requirements
          const t = this.transferAllowed(p, m.project_id);
          if (!t.ok) continue;
          fromProject = t.other?.name ?? null;
        }
        helpful.set(m.id, {
          memory: { id: m.id, title: m.title, summary: truncate(m.summary || m.content, 220), memory_type: m.memory_type, project_id: m.project_id },
          score: Math.round(hit.score * 100) / 100,
          from_project: fromProject,
          why: `Shares key terms with the open ${String(q.kind).replace("_", " ")} "${truncate(String(q.text), 80)}" (similarity ${hit.score.toFixed(2)})${fromProject ? `. From your project ${fromProject}: check it applies here before reusing it` : ""}${m.scope === "project" && fromProject ? " (it was saved as project-specific there)" : ""}.`,
        });
        if (helpful.size >= 6) break;
      }
      if (helpful.size >= 6) break;
    }

    // Next step: from the most direct evidence available, in this order.
    let next: Row | null = null;
    if (h && (h.next_steps as string[]).length) next = { text: (h.next_steps as string[])[0], why: "The latest session handoff listed it as the next step.", ref: { type: "handoff", id: h.id, at: h.updated_at } };
    else if ((s.blockers as Row[]).length) {
      const b = (s.blockers as Row[])[0];
      next = { text: `Clear the blocker: ${b.title}`, why: "It's the oldest open blocker; other work may depend on it.", ref: { type: "item", id: b.id, at: b.created_at } };
    } else if ((s.unresolved_decisions as Row[]).length) {
      const d = (s.unresolved_decisions as Row[])[0];
      next = { text: `Decide: ${d.title}`, why: "It's the oldest unresolved decision in this project.", ref: { type: "item", id: d.id, at: d.created_at } };
    } else if ((s.open_tasks as Row[]).length) {
      const tsk = (s.open_tasks as Row[])[(s.open_tasks as Row[]).length - 1];
      next = { text: tsk.title, why: "It's the oldest open task recorded for this project.", ref: { type: "memory", id: tsk.id, at: tsk.updated_at } };
    }
    return {
      project: s.project,
      generated_at: nowIso(),
      algorithm: "project-resume-v1 (deterministic: saved records only)",
      last_completed: lastCompleted.slice(0, 6),
      decisions: decisions.slice(0, 8),
      unresolved,
      helpful_research: [...helpful.values()],
      next_step: next,
      next_step_note: next ? null : "Nothing recorded suggests a next step yet. Add a blocker, an unresolved decision or a task, or save a session handoff.",
      latest_handoff: h ? { id: h.id, summary: h.summary, client: h.client, updated_at: h.updated_at, version: h.version } : null,
      progress: s.progress,
      last_meaningful_activity: s.last_meaningful_activity,
    };
  }

  /** Compact text version of a resume briefing (for MCP clients). Every line names its source. */
  resumeText(r: Row): string {
    const lines: string[] = [`Project: ${(r.project as Row).name}`];
    const src = (x: Row) => `[${(x.ref as Ref).type} ${(x.ref as Ref).id}]`;
    if (r.latest_handoff) lines.push(`Latest handoff (${(r.latest_handoff as Row).client}, ${(r.latest_handoff as Row).updated_at}): ${(r.latest_handoff as Row).summary}`);
    if ((r.last_completed as Row[]).length) lines.push("Last completed:", ...(r.last_completed as Row[]).map((x) => `- ${x.text} ${src(x)}`));
    if ((r.decisions as Row[]).length) lines.push("Decisions:", ...(r.decisions as Row[]).map((x) => `- ${x.text} ${src(x)}`));
    if ((r.unresolved as Row[]).length) lines.push("Unresolved:", ...(r.unresolved as Row[]).map((x) => `- (${String(x.kind).replace(/_/g, " ")}) ${x.text} ${src(x)}`));
    if ((r.helpful_research as Row[]).length) lines.push("May help:", ...(r.helpful_research as Row[]).map((x) => `- ${(x.memory as Row).title} (${(x.memory as Row).id}): ${x.why}`));
    if (r.next_step) lines.push(`Suggested next step: ${(r.next_step as Row).text} (${(r.next_step as Row).why}) ${src(r.next_step as Row)}`);
    else lines.push(String(r.next_step_note));
    lines.push(`Progress: ${((r.progress as Row).note as string) ?? "unknown"}`);
    return lines.join("\n");
  }
}
