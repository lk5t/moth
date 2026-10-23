// MOTH Adaptation: a transparent, structured personalization layer.
// Nothing here changes any model's weights. MOTH keeps an editable profile of preferences,
// sourced research insights, verified lessons and cross-project suggestions, and retrieves the
// relevant parts for each task.
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "./brain.ts";
import { cosine, localEmbed } from "./embeddings.ts";
import { sanitizeText } from "./security.ts";
import { safeJson } from "./store.ts";
import { deriveTitle, keywords, tokenize, truncate, uniq } from "./text.ts";
import { MothError, type ChangeContext, type Memory } from "./types.ts";

export const PREF_AREAS = ["coding", "tools", "ui", "workflow", "communication", "requirement", "instruction", "lesson", "other"] as const;
export type PrefArea = (typeof PREF_AREAS)[number];
export type PrefStatus = "confirmed" | "tentative" | "rejected" | "outdated";

export interface PreferenceInput {
  content: string;
  area?: PrefArea;
  /** Explicitly stated by the user ("I prefer…", "always…"), not inferred from behaviour. */
  explicit: boolean;
  project?: string | null;
  scope?: "global" | "project";
  source?: string;
  source_ref?: string | null;
  task_id?: string | null;
  observation?: string | null;
}

export interface ResearchSource {
  url?: string | null;
  title?: string;
  publisher?: string;
  published_at?: string | null;
  retrieved_at?: string | null;
  excerpt?: string;
}

export interface ResearchFinding {
  insight: string;
  title?: string;
  /** "evidence": backed by the cited sources. "speculation": an idea or interpretation not directly supported. */
  basis: "evidence" | "speculation";
  sources?: ResearchSource[];
  reusable?: boolean;
  confidence?: number;
}

export interface ResearchInput {
  topic: string;
  question?: string;
  domain?: string;
  project?: string | null;
  summary?: string;
  findings: ResearchFinding[];
  task_id?: string | null;
  source?: string;
}

export interface LessonInput {
  problem: string;
  correction: string;
  lesson: string;
  project?: string | null;
  evidence?: string;
  verified: boolean;
  /** "project" (default): applies to this project only. "global": the user/Claude judged it reusable. */
  scope?: "project" | "global";
  domain?: string;
  task_id?: string | null;
  source?: string;
}

const AREA_HINTS: [PrefArea, RegExp][] = [
  ["ui", /\b(ui|ux|design|dark|theme|colou?r|layout|font|animation|style of the interface|visual)\b/i],
  ["coding", /\b(code|script|modular|function|typescript|lua|luau|naming|comments?|refactor|clean code)\b/i],
  ["tools", /\b(use|uses|using)\s+(\w+)\b|\b(react|tailwind|rojo|vscode|git|python|node|tauri|obsidian)\b/i],
  ["workflow", /\b(step[- ]by[- ]step|test(ing)? after|incremental|phase|one feature at a time|commit|workflow)\b/i],
  ["communication", /\b(explain|simple words|plain english|short|concise|jargon|tone|bullet)\b/i],
  ["requirement", /\b(must|always|never|requirement|required)\b/i],
];

export function guessArea(text: string): PrefArea {
  for (const [a, re] of AREA_HINTS) if (re.test(text)) return a;
  return "other";
}

const URL_RE = /^https?:\/\/[^\s<>"']{3,2000}$/i;

export class Adaptation {
  constructor(private brain: Brain) {}

  private get db() {
    return this.brain.db;
  }
  private get store() {
    return this.brain.store;
  }

  registerInboxHandlers(): void {
    const inbox = this.brain.inbox;
    inbox.register("preference", {
      approve: (item, edits) => {
        const p = item.proposal as Record<string, any>;
        const id = String(item.target_memory_id ?? p.memory_id ?? "");
        if (!id || !this.store.getMemory(id)) throw new MothError("stale", "This preference no longer exists");
        if (edits.content) this.edit(id, { content: edits.content });
        this.confirm(id, "Confirmed in the Memory Inbox");
        return { memory_id: id };
      },
      reject: (item) => {
        const id = String(item.target_memory_id ?? "");
        if (id && this.store.getMemory(id)) this.reject(id, "Rejected in the Memory Inbox");
      },
    });
    inbox.register("research", {
      approve: (item, edits) => {
        const p = item.proposal as { input: ResearchInput; finding: ResearchFinding };
        const finding = { ...p.finding, insight: edits.content || p.finding.insight, basis: "speculation" as const };
        const id = this.storeFinding(p.input, finding, this.resolveProject(p.input.project), "Approved in the Memory Inbox (no supporting sources)");
        return { memory_id: id, note: "Stored as unsourced research (labelled speculative)" };
      },
    });
    inbox.register("lesson", {
      approve: (item, edits) => {
        const p = item.proposal as { input: LessonInput };
        const input = { ...p.input, lesson: edits.content || p.input.lesson, verified: true };
        return { memory_id: this.storeLesson(input, "Verified by you in the Memory Inbox").id };
      },
    });
  }

  private ctx(reason: string, actor: ChangeContext["actor"] = "moth", task_id?: string | null): ChangeContext {
    return { actor, reason, task_id: task_id ?? null };
  }

  private resolveProject(name?: string | null): { id: string; name: string } | null {
    if (!name) return null;
    const p = this.store.getProject(name) ?? this.store.createProject({ name }, this.ctx(`Project named in submitted information`, "claude"));
    return { id: p.id, name: p.name };
  }

  private clean(text: string, field: string, max = 4000): string {
    const t = sanitizeText(text, field, max, { redact: true, flagInjection: false }).text.trim();
    if (!t) throw new MothError("invalid_input", `${field} is required`);
    return t;
  }

  // ---------------------------------------------------------------- preferences
  private prefRow(m: Memory, meta: Row | undefined): Row {
    const project = m.project_id ? this.store.getProject(m.project_id) : null;
    return {
      id: m.id,
      content: m.content,
      title: m.title,
      area: meta?.area ?? "other",
      status: meta?.status ?? "tentative",
      explicit: !!meta?.explicit,
      evidence_count: Number(meta?.evidence_count ?? 1),
      scope: m.scope,
      project: project ? { id: project.id, name: project.name } : null,
      source: m.source,
      source_ref: m.source_ref,
      confidence: m.confidence,
      pinned: m.pinned,
      created_at: m.created_at,
      updated_at: m.updated_at,
      last_confirmed_at: meta?.last_confirmed_at ?? null,
      version: m.version,
      memory_status: m.status,
    };
  }

  getPreference(id: string): Row {
    const m = this.store.requireMemory(id);
    if (m.memory_type !== "preference") throw new MothError("invalid_input", "That memory is not a preference");
    const meta = this.db.get<Row>("SELECT * FROM preference_meta WHERE memory_id = ?", [id]);
    return {
      ...this.prefRow(m, meta),
      evidence: this.db.all("SELECT * FROM preference_evidence WHERE memory_id = ? ORDER BY id DESC LIMIT 50", [id]),
      versions: this.store.versions(id).slice(0, 20),
    };
  }

  listPreferences(f: { status?: string; area?: string; project_id?: string | null; include_archived?: boolean } = {}): Row[] {
    const where = ["m.user_id = ?", "m.memory_type = 'preference'"];
    const p: unknown[] = [this.store.userId];
    if (!f.include_archived) where.push("m.status = 'active'");
    if (f.status && f.status !== "all") (where.push("COALESCE(pm.status,'tentative') = ?"), p.push(f.status));
    if (f.area) (where.push("COALESCE(pm.area,'other') = ?"), p.push(f.area));
    if (f.project_id) (where.push("m.project_id = ?"), p.push(f.project_id));
    const rows = this.db.all<Row>(
      `SELECT m.*, pm.area AS pm_area, pm.status AS pm_status, pm.explicit AS pm_explicit, pm.evidence_count AS pm_evidence, pm.last_confirmed_at AS pm_confirmed
       FROM memories m LEFT JOIN preference_meta pm ON pm.memory_id = m.id WHERE ${where.join(" AND ")}
       ORDER BY m.pinned DESC, CASE COALESCE(pm.status,'tentative') WHEN 'confirmed' THEN 0 WHEN 'tentative' THEN 1 WHEN 'outdated' THEN 2 ELSE 3 END, m.updated_at DESC LIMIT 500`,
      p,
    );
    return rows.map((r) =>
      this.prefRow(this.store.toMemory(r), { area: r.pm_area, status: r.pm_status, explicit: r.pm_explicit, evidence_count: r.pm_evidence, last_confirmed_at: r.pm_confirmed } as Row),
    );
  }

  /**
   * Finds an existing preference that says the same thing in the same scope. Wording variations and added detail
   * count as the same preference; a substituted word ("dark UI" vs "light UI") never does.
   */
  private similarPreference(content: string, projectId: string | null): { id: string; score: number } | null {
    const norm = (t: string) => t.toLowerCase().replace(/[-_/]+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ");
    const v = localEmbed(norm(content));
    const mine = new Set(tokenize(norm(content)));
    const rows = this.db.all<Row>(
      `SELECT m.id, m.title, m.content FROM memories m JOIN preference_meta pm ON pm.memory_id = m.id
       WHERE m.user_id = ? AND m.memory_type = 'preference' AND m.status = 'active' AND pm.status <> 'rejected' AND COALESCE(m.project_id,'') = COALESCE(?, '')`,
      [this.store.userId, projectId],
    );
    let best: { id: string; score: number } | null = null;
    for (const r of rows) {
      const other = norm(String(r.content));
      const theirs = new Set(tokenize(other));
      const onlyMine = [...mine].filter((t) => !theirs.has(t));
      const onlyTheirs = [...theirs].filter((t) => !mine.has(t));
      if (onlyMine.length && onlyTheirs.length) continue; // a substitution means a different preference
      const s = cosine(v, localEmbed(other));
      if (!best || s > best.score) best = { id: r.id as string, score: s };
    }
    return best && best.score >= 0.6 ? best : null;
  }

  /**
   * Records a preference. Explicit statements are stored as confirmed. Inferred ones start tentative and
   * accumulate evidence; after `adaptation.inferAfter` independent observations MOTH asks the user to
   * confirm (it never promotes an inference to confirmed by itself).
   */
  recordPreference(input: PreferenceInput, actor: ChangeContext["actor"] = "claude"): Row {
    const content = this.clean(input.content, "content", 1200);
    const project = input.scope === "global" ? null : this.resolveProject(input.project);
    const projectId = project?.id ?? null;
    const area = input.area && PREF_AREAS.includes(input.area) ? input.area : guessArea(content);
    const explicit = !!input.explicit;
    const source = input.source ?? (actor === "user" ? "user" : actor === "claude" ? "claude" : "moth");
    const t = nowIso();
    const ctx = this.ctx(explicit ? "The user stated this preference" : "Observed in the user's requests (inferred, tentative)", actor, input.task_id);
    const existing = this.similarPreference(content, projectId);
    return this.db.tx(() => {
      if (existing) {
        const meta = this.db.get<Row>("SELECT * FROM preference_meta WHERE memory_id = ?", [existing.id]);
        this.db.run("INSERT INTO preference_evidence(memory_id, observation, source, task_id, project_id, created_at) VALUES (?,?,?,?,?,?)", [existing.id, truncate(input.observation || content, 1000), source, input.task_id ?? null, projectId, t]);
        const evidence = Number(meta?.evidence_count ?? 1) + 1;
        const wasStatus = (meta?.status as PrefStatus) ?? "tentative";
        const status: PrefStatus = explicit ? "confirmed" : wasStatus === "outdated" ? "tentative" : wasStatus;
        this.db.run("UPDATE preference_meta SET evidence_count = ?, status = ?, explicit = MAX(explicit, ?), last_confirmed_at = CASE WHEN ? = 1 THEN ? ELSE last_confirmed_at END, updated_at = ? WHERE memory_id = ?", [evidence, status, explicit ? 1 : 0, explicit ? 1 : 0, t, t, existing.id]);
        const m = this.store.requireMemory(existing.id);
        const conf = explicit ? Math.max(m.confidence, 0.95) : Math.min(0.85, m.confidence + 0.08);
        this.store.updateMemory(existing.id, { confidence: conf }, ctx, { changeType: "reinforced" });
        if (!explicit && status === "tentative" && evidence >= this.brain.settings.get("adaptation.inferAfter")) {
          this.brain.inbox.add({
            kind: "preference", operation: "confirm_preference", target_memory_id: existing.id, statement: m.content,
            reason: `MOTH noticed this ${evidence} times. Confirm it so Claude can rely on it, or reject it.`, risk: "low", confidence: conf, source, task_id: input.task_id,
            proposal: { memory_id: existing.id, evidence_count: evidence },
          });
        }
        return { ...this.getPreference(existing.id), action: "reinforced" };
      }
      const m = this.store.createMemory(
        {
          title: deriveTitle(content, 70), content, category: "preference", memory_type: "preference", project_id: projectId,
          scope: projectId ? "project" : "global", source, source_ref: input.source_ref ?? null, tags: ["preference", area],
          confidence: explicit ? 0.95 : 0.45, importance: explicit ? 0.7 : 0.45, verification: explicit ? "verified" : "unverified",
        },
        ctx,
      );
      this.db.run("INSERT INTO preference_meta(memory_id, area, status, explicit, evidence_count, last_confirmed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [m.id, area, explicit ? "confirmed" : "tentative", explicit ? 1 : 0, 1, explicit ? t : null, t, t]);
      this.db.run("INSERT INTO preference_evidence(memory_id, observation, source, task_id, project_id, created_at) VALUES (?,?,?,?,?,?)", [m.id, truncate(input.observation || content, 1000), source, input.task_id ?? null, projectId, t]);
      return { ...this.getPreference(m.id), action: "created" };
    });
  }

  private setPrefStatus(id: string, status: PrefStatus, reason: string, actor: ChangeContext["actor"] = "user"): Row {
    const m = this.store.requireMemory(id);
    if (m.memory_type !== "preference") throw new MothError("invalid_input", "That memory is not a preference");
    const t = nowIso();
    this.db.tx(() => {
      if (!this.db.value("SELECT 1 FROM preference_meta WHERE memory_id = ?", [id]))
        this.db.run("INSERT INTO preference_meta(memory_id, area, status, explicit, evidence_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [id, guessArea(m.content), "tentative", 0, 1, t, t]);
      this.db.run("UPDATE preference_meta SET status = ?, last_confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE last_confirmed_at END, updated_at = ? WHERE memory_id = ?", [status, status, t, t, id]);
      const ctx = this.ctx(reason, actor);
      if (status === "confirmed") this.store.updateMemory(id, { confidence: Math.max(m.confidence, 0.95), verification: "user_confirmed" }, ctx, { changeType: "preference_confirmed", force: true });
      // Rejected preferences leave the profile but stay recoverable (archived, never deleted).
      if (status === "rejected" && m.status === "active") this.store.setStatus(id, "archived", ctx, {}, false);
      if (status !== "rejected" && m.status === "archived") this.store.setStatus(id, "active", ctx, {}, false);
      this.store.recordEvent({ kind: `preference_${status}`, actor, memory_id: id, project_id: m.project_id, description: `Preference ${status}: "${truncate(m.content, 80)}"`, reason, undo: null });
    });
    return this.getPreference(id);
  }

  confirm(id: string, reason = "Confirmed by you"): Row {
    return this.setPrefStatus(id, "confirmed", reason);
  }
  reject(id: string, reason = "Rejected by you"): Row {
    const r = this.setPrefStatus(id, "rejected", reason);
    this.brain.cortex.recordFeedback({ subject_type: "memory", subject_id: id, verdict: "incorrect", operation: "infer_preference", statement: String(r.content) });
    return r;
  }
  markOutdated(id: string): Row {
    return this.setPrefStatus(id, "outdated", "Marked outdated by you");
  }

  edit(id: string, patch: { content?: string; area?: PrefArea; scope?: "global" | "project"; project?: string | null; pinned?: boolean }): Row {
    const m = this.store.requireMemory(id);
    if (m.memory_type !== "preference") throw new MothError("invalid_input", "That memory is not a preference");
    const ctx = this.ctx("Edited in What MOTH Knows About Me", "user");
    this.db.tx(() => {
      let project_id = m.project_id;
      if (patch.scope === "global") project_id = null;
      if (patch.scope === "project" || patch.project) {
        const p = patch.project ? this.store.getProject(patch.project) : m.project_id ? this.store.getProject(m.project_id) : null;
        if (!p) throw new MothError("invalid_input", "Choose a project for a project-scoped preference");
        project_id = p.id;
      }
      this.store.updateMemory(
        id,
        {
          ...(patch.content ? { content: this.clean(patch.content, "content", 1200), title: deriveTitle(patch.content, 70) } : {}),
          ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
          project_id, scope: project_id ? "project" : "global",
        },
        ctx,
        { changeType: patch.content ? "preference_edited" : "update" },
      );
      if (patch.area && PREF_AREAS.includes(patch.area)) this.db.run("UPDATE preference_meta SET area = ?, updated_at = ? WHERE memory_id = ?", [patch.area, nowIso(), id]);
      // Editing your own preference is an explicit statement.
      if (patch.content) this.db.run("UPDATE preference_meta SET explicit = 1, status = 'confirmed', last_confirmed_at = ?, updated_at = ? WHERE memory_id = ?", [nowIso(), nowIso(), id]);
    });
    return this.getPreference(id);
  }

  deletePreference(id: string, confirm: boolean): Row {
    if (!confirm) throw new MothError("confirmation_required", "Deleting a preference is permanent. Pass confirm: true to delete it.");
    const m = this.store.requireMemory(id);
    if (m.memory_type !== "preference") throw new MothError("invalid_input", "That memory is not a preference");
    return this.store.deletePermanently(id, this.ctx("Deleted by you in What MOTH Knows About Me", "user"));
  }

  /** The few preferences that matter for this task. Never other projects' preferences; never rejected/outdated. */
  relevantPreferences(task: string, projectId: string | null, max = this.brain.settings.get("adaptation.maxInContext")): Row[] {
    if (!this.brain.settings.get("adaptation.enabled")) return [];
    const rows = this.listPreferences({}).filter((p) => (p.status === "confirmed" || (p.status === "tentative" && Number(p.evidence_count) >= this.brain.settings.get("adaptation.inferAfter"))) && (!p.project || (p.project as Row).id === projectId));
    if (!rows.length) return [];
    const qv = localEmbed(task);
    const qTok = new Set(tokenize(task));
    const buildingTask = /\b(add|build|implement|fix|create|make|script|code|refactor|design|ui|feature|system)\b/i.test(task);
    const scored = rows.map((p) => {
      const sim = cosine(qv, localEmbed(String(p.content)));
      const overlap = tokenize(String(p.content)).filter((t) => qTok.has(t)).length;
      // General working-style preferences (workflow/communication) apply to most tasks.
      const general = p.area === "workflow" || p.area === "communication" ? 0.18 : buildingTask && ["coding", "tools", "ui"].includes(String(p.area)) ? 0.12 : 0;
      const projectBoost = p.project ? 0.15 : 0;
      const score = sim * 0.6 + Math.min(0.3, overlap * 0.1) + general + projectBoost + (p.pinned ? 0.12 : 0) + (p.status === "confirmed" ? 0.05 : 0);
      return { p, score };
    });
    return scored
      .filter((x) => x.score >= 0.2 || x.p.pinned)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map(({ p, score }) => ({
        id: p.id, preference: p.content, area: p.area, status: p.status, scope: p.project ? `project: ${(p.project as Row).name}` : "global",
        source: p.explicit ? "stated by the user" : `inferred from ${p.evidence_count} observations`, confidence: p.confidence, relevance: Math.round(score * 100) / 100,
      }));
  }

  /** A one-paragraph summary Claude can read (built from stored preferences, not generated). */
  preferenceBrief(prefs: Row[]): string {
    if (!prefs.length) return "";
    return prefs.map((p) => `- ${p.preference}${p.status === "tentative" ? " (tentative)" : ""}`).join("\n");
  }

  /** Light-weight inference from Claude Code prompts: only clear "I prefer / always / never" phrasing. */
  inferFromPrompt(prompt: string, projectId: string | null, taskId: string | null): Row[] {
    if (!this.brain.settings.get("adaptation.enabled") || this.brain.privacyMode()) return [];
    const out: Row[] = [];
    const sentences = prompt.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter((s) => s.length > 12 && s.length < 300);
    for (const s of sentences.slice(0, 40)) {
      const explicit = /^(i (really )?(prefer|like|want|always want|never want)|please always|always\b|never\b|from now on|i'd rather|my preference)/i.test(s);
      if (!explicit) continue;
      if (/\?$/.test(s)) continue;
      const scopedToProject = /\b(this|the) (game|project|app|repo)\b/i.test(s);
      out.push(this.recordPreference({ content: s, explicit: true, project: scopedToProject && projectId ? projectId : null, scope: scopedToProject && projectId ? "project" : "global", source: "claude-code-prompt", task_id: taskId, observation: s }, "claude"));
    }
    return out;
  }

  // ---------------------------------------------------------------- research memory
  private cleanSources(sources: ResearchSource[] | undefined): ResearchSource[] {
    const out: ResearchSource[] = [];
    for (const s of (sources ?? []).slice(0, 12)) {
      const url = typeof s?.url === "string" ? s.url.trim() : "";
      if (url && !URL_RE.test(url)) continue; // malformed links are dropped, never "fixed" or guessed
      const title = typeof s?.title === "string" ? truncate(s.title.trim(), 300) : "";
      if (!url && !title) continue;
      out.push({
        url: url || null, title, publisher: typeof s.publisher === "string" ? truncate(s.publisher, 200) : "",
        published_at: typeof s.published_at === "string" ? s.published_at.slice(0, 40) : null,
        retrieved_at: typeof s.retrieved_at === "string" ? s.retrieved_at.slice(0, 40) : null,
        excerpt: typeof s.excerpt === "string" ? truncate(s.excerpt, 800) : "",
      });
    }
    return out;
  }

  private addSources(memoryId: string, sources: ResearchSource[]): number {
    let n = 0;
    for (const s of sources) {
      if (this.db.value("SELECT 1 FROM memory_sources WHERE memory_id = ? AND COALESCE(url,'') = COALESCE(?, '') AND title = ?", [memoryId, s.url ?? null, s.title ?? ""])) continue;
      this.db.run("INSERT INTO memory_sources(memory_id, url, title, publisher, published_at, retrieved_at, excerpt, kind, created_at) VALUES (?,?,?,?,?,?,?,'citation',?)", [memoryId, s.url ?? null, s.title ?? "", s.publisher ?? "", s.published_at ?? null, s.retrieved_at ?? null, s.excerpt ?? "", nowIso()]);
      n++;
    }
    return n;
  }

  sourcesOf(memoryId: string): Row[] {
    return this.db.all("SELECT * FROM memory_sources WHERE memory_id = ? ORDER BY id", [memoryId]);
  }

  private topicHub(input: ResearchInput, project: { id: string } | null): Memory {
    const title = `Research: ${truncate(this.clean(input.topic, "topic", 200), 90)}`;
    const existing = this.db.get<Row>("SELECT * FROM memories WHERE user_id = ? AND memory_type = 'research' AND title = ? COLLATE NOCASE AND status = 'active'", [this.store.userId, title]);
    if (existing) {
      const m = this.store.toMemory(existing);
      if (input.summary && !m.content.includes(input.summary.slice(0, 120))) this.store.appendMemory(m.id, this.clean(input.summary, "summary"), this.ctx("New research summary on this topic", "claude", input.task_id), { heading: `Research ${nowIso().slice(0, 10)}` });
      return this.store.requireMemory(m.id);
    }
    return this.store.createMemory(
      {
        title, content: [input.question ? `Question: ${input.question}` : "", input.summary ? this.clean(input.summary, "summary") : `Research on ${input.topic}.`].filter(Boolean).join("\n\n"),
        category: "research", memory_type: "research", domain: input.domain ?? "", project_id: project?.id ?? null, scope: project ? "project" : "global",
        tags: uniq(["research", ...keywords(input.topic, 3)]), source: input.source ?? "claude-research", confidence: 0.7,
      },
      this.ctx("Research topic submitted by Claude", "claude", input.task_id),
    );
  }

  private storeFinding(input: ResearchInput, f: ResearchFinding, project: { id: string } | null, reason: string, hubId?: string): string {
    const sources = this.cleanSources(f.sources);
    const insight = this.clean(f.insight, "insight", 3000);
    const overclaim = /\bguarantee[sd]?\b|\bwill definitely\b|\balways works\b/i.test(insight);
    const evidence = f.basis === "evidence" && sources.length ? "sourced" : f.basis === "speculation" ? "speculative" : "unsourced";
    const reusable = f.reusable !== false;
    const baseConf = evidence === "sourced" ? 0.7 : evidence === "speculative" ? 0.35 : 0.3;
    const confidence = Math.max(0.1, Math.min(0.9, typeof f.confidence === "number" ? Math.min(f.confidence, baseConf + 0.15) : baseConf) - (overclaim ? 0.15 : 0));
    const ctx = this.ctx(reason, "claude", input.task_id);
    // Same insight already stored? Add the new sources to it instead of duplicating.
    const iv = localEmbed(insight);
    const sim = this.db
      .all<Row>("SELECT * FROM memories WHERE user_id = ? AND memory_type = 'research' AND status = 'active' AND title NOT LIKE 'Research: %' ORDER BY updated_at DESC LIMIT 2000", [this.store.userId])
      .map((r) => ({ m: this.store.toMemory(r), score: cosine(iv, localEmbed(String(r.content).split("\n\n")[0])) }))
      .filter((x) => x.score >= 0.85)
      .sort((a, b) => b.score - a.score)[0];
    if (sim?.m) {
      const added = this.addSources(sim.m.id, sources);
      if (!sim.m.content.includes(insight.slice(0, 100))) this.store.appendMemory(sim.m.id, insight, ctx, { heading: "Also found" });
      else this.store.updateMemory(sim.m.id, { confidence: Math.min(0.9, sim.m.confidence + 0.05) }, ctx, { changeType: "reinforced" });
      if (added && sim.m.evidence !== "sourced" && evidence === "sourced") this.store.updateMemory(sim.m.id, { evidence: "sourced" }, ctx, { changeType: "update", recordEvent: false, force: true });
      return sim.m.id;
    }
    const m = this.store.createMemory(
      {
        title: f.title?.trim() ? truncate(f.title.trim(), 120) : deriveTitle(insight, 80),
        content: `${insight}${evidence === "speculative" ? "\n\n_Speculation: not directly supported by the cited research._" : evidence === "unsourced" ? "\n\n_No supporting source was provided._" : ""}${overclaim ? "\n\n_Note: research suggests possibilities; results are not guaranteed._" : ""}`,
        category: "research", memory_type: "research", domain: input.domain ?? "", evidence,
        project_id: reusable ? null : project?.id ?? null, scope: reusable || !project ? "global" : "project",
        tags: uniq(["research", ...(input.domain ?? "").split(/[\/,]/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 4), ...(overclaim ? ["overclaim"] : [])]),
        source: input.source ?? "claude-research", confidence,
      },
      ctx,
    );
    this.addSources(m.id, sources);
    if (hubId) this.store.link(m.id, hubId, "BELONGS_TO", `Insight from research on "${truncate(input.topic, 80)}"`, ctx, { strength: 0.8, recordEvent: false });
    const hubOfProject = project ? this.store.getProject(project.id)?.hub_memory_id : null;
    if (hubOfProject && reusable && hubOfProject !== m.id) this.store.link(m.id, hubOfProject, "RELATED_TO", "Research done while working on this project", ctx, { strength: 0.5, recordEvent: false });
    return m.id;
  }

  /**
   * Stores research Claude completed: one hub memory per topic, one research memory per insight, every source preserved
   * exactly as submitted. Insights that claim evidence but cite nothing go to the Memory Inbox instead of being stored as fact.
   */
  submitResearch(input: ResearchInput): Row {
    if (!input || typeof input.topic !== "string" || !input.topic.trim()) throw new MothError("invalid_input", "topic is required");
    if (!Array.isArray(input.findings) || !input.findings.length) throw new MothError("invalid_input", "findings must contain at least one insight");
    if (this.brain.privacyMode()) throw new MothError("paused", "Privacy Mode is on in MOTH, so research is not being saved right now. The user can turn it off in MOTH.");
    const project = this.resolveProject(input.project);
    const report = { topic: input.topic, hub_id: "", stored: [] as Row[], needs_review: [] as Row[], sources_saved: 0 };
    this.db.tx(() => {
      const hub = this.topicHub(input, project);
      report.hub_id = hub.id;
      for (const f of input.findings.slice(0, 25)) {
        if (!f || typeof f.insight !== "string" || !f.insight.trim()) continue;
        const sources = this.cleanSources(f.sources);
        if (f.basis !== "speculation" && !sources.length) {
          const rid = this.brain.inbox.add({
            kind: "research", operation: "store_unsourced_research", statement: f.insight, reason: "Presented as evidence but no source was provided. Approve to keep it labelled as unsourced, or reject it.",
            risk: "medium", confidence: f.confidence ?? null, source: input.source ?? "claude-research", task_id: input.task_id, proposal: { input: { ...input, findings: [] }, finding: f },
          });
          report.needs_review.push({ insight: truncate(f.insight, 160), review_id: rid, reason: "no sources" });
          continue;
        }
        const id = this.storeFinding(input, f, project, `Research insight on "${truncate(input.topic, 80)}"`, hub.id);
        report.sources_saved += sources.length;
        const m = this.store.requireMemory(id);
        report.stored.push({ id, title: m.title, evidence: m.evidence, confidence: m.confidence, sources: sources.length, scope: m.scope });
      }
    });
    for (const s of report.stored) if (this.brain.role === "app") this.brain.jobs.enqueue("discover_links", { memory_id: s.id }, { dedupe: `links:${s.id}`, delayMs: 1500 });
    else for (const s of report.stored) this.brain.learning.discoverLinks(String(s.id), this.ctx("New research insight analysed for connections"));
    this.store.logActivity({ kind: "research", source: input.source ?? "claude", action: "research_stored", detail: { topic: input.topic, stored: report.stored.length, review: report.needs_review.length } });
    return report;
  }

  listResearch(f: { domain?: string; q?: string; limit?: number } = {}): Row[] {
    const rows = this.db.all<Row>(
      `SELECT * FROM memories WHERE user_id = ? AND memory_type = 'research' AND status = 'active' ${f.domain ? "AND domain LIKE ?" : ""} ORDER BY updated_at DESC LIMIT ?`,
      f.domain ? [this.store.userId, `%${f.domain}%`, f.limit ?? 300] : [this.store.userId, f.limit ?? 300],
    );
    const ql = (f.q ?? "").toLowerCase();
    return rows
      .map((r) => this.store.toMemory(r))
      .filter((m) => !ql || `${m.title} ${m.content} ${m.domain}`.toLowerCase().includes(ql))
      .map((m) => ({ ...m, sources: this.sourcesOf(m.id), is_topic: m.title.startsWith("Research: ") }));
  }

  // ---------------------------------------------------------------- lessons from corrections
  private storeLesson(input: LessonInput, reason: string): Memory {
    const project = this.resolveProject(input.project);
    const lesson = this.clean(input.lesson, "lesson", 1500);
    const problem = this.clean(input.problem, "problem", 2000);
    const correction = this.clean(input.correction, "correction", 2000);
    const scope = input.scope === "global" ? "global" : project ? "project" : "global";
    const ctx = this.ctx(reason, "claude", input.task_id);
    const content = `${lesson}\n\n**Problem:** ${problem}\n\n**Verified correction:** ${correction}${input.evidence ? `\n\n**Evidence:** ${truncate(input.evidence, 1500)}` : ""}`;
    const sim = this.brain.search.similarToText(lesson, 5).map((x) => ({ ...x, m: this.store.getMemory(x.id) })).find((x) => x.m && x.m.status === "active" && x.m.memory_type === "lesson" && x.score >= 0.8);
    if (sim?.m) {
      this.store.appendMemory(sim.m.id, `Seen again${project ? ` in ${project.name}` : ""}: ${problem} → ${correction}`, ctx, { heading: "Confirmed again" });
      this.store.updateMemory(sim.m.id, { confidence: Math.min(0.95, sim.m.confidence + 0.05) }, ctx, { changeType: "reinforced", recordEvent: false });
      return this.store.requireMemory(sim.m.id);
    }
    const m = this.store.createMemory(
      {
        title: deriveTitle(lesson, 80), content, category: "solution", memory_type: "lesson", project_id: project?.id ?? null, scope, domain: input.domain ?? "",
        tags: uniq(["lesson", ...keywords(lesson, 3)]), source: input.source ?? "claude", confidence: input.verified ? 0.8 : 0.5, importance: 0.7,
        verification: input.verified ? "verified" : "unverified",
      },
      ctx,
    );
    this.db.run("INSERT INTO lesson_meta(memory_id, problem, correction, evidence, verified, status, created_at) VALUES (?,?,?,?,?, 'active', ?)", [m.id, problem, correction, input.evidence ?? "", input.verified ? 1 : 0, nowIso()]);
    return m;
  }

  recordLesson(input: LessonInput): Row {
    for (const k of ["problem", "correction", "lesson"] as const) if (typeof input?.[k] !== "string" || !input[k].trim()) throw new MothError("invalid_input", `${k} is required`);
    if (this.brain.privacyMode()) throw new MothError("paused", "Privacy Mode is on in MOTH, so lessons are not being saved right now.");
    if (!input.verified) {
      const rid = this.brain.inbox.add({
        kind: "lesson", operation: "store_lesson", statement: input.lesson, reason: "The correction was not verified yet. Approve once it is confirmed to work.",
        risk: "medium", source: input.source ?? "claude", task_id: input.task_id, proposal: { input },
      });
      return { stored: false, review_id: rid, note: "Unverified corrections wait in the Memory Inbox." };
    }
    const m = this.db.tx(() => this.storeLesson(input, "Verified correction submitted by Claude"));
    if (this.brain.role === "app") this.brain.jobs.enqueue("discover_links", { memory_id: m.id }, { dedupe: `links:${m.id}`, delayMs: 1500 });
    return { stored: true, id: m.id, title: m.title, scope: m.scope, project_id: m.project_id };
  }

  listLessons(): Row[] {
    return this.db
      .all<Row>("SELECT m.*, l.problem, l.correction, l.evidence AS l_evidence, l.verified, l.status AS l_status FROM memories m LEFT JOIN lesson_meta l ON l.memory_id = m.id WHERE m.user_id = ? AND m.memory_type = 'lesson' AND m.status = 'active' ORDER BY m.updated_at DESC LIMIT 300", [this.store.userId])
      .map((r) => ({ ...this.store.toMemory(r), problem: r.problem, correction: r.correction, verified: !!r.verified }));
  }

  // ---------------------------------------------------------------- knowledge transfer
  /**
   * Finds reusable knowledge for a project: research, verified lessons, procedures and preferences.
   * Rules: relevance-based only; never from private projects; other projects' decisions and plain facts
   * are never transferred; transfer can be disabled per project or globally.
   */
  transferCandidates(projectId: string, extraText = "", limit = 6): Row[] {
    const p = this.store.requireProject(projectId);
    if (!this.brain.settings.get("transfer.enabled") || !p.transfer_enabled) return [];
    const text = `${p.name} ${p.aliases.join(" ")} ${p.description} ${p.goals} ${extraText}`.trim();
    if (tokenize(text).length < 2) return [];
    const dismissed = new Set(this.db.all<Row>("SELECT memory_id FROM transfer_suggestions WHERE project_id = ? AND status = 'dismissed'", [projectId]).map((r) => r.memory_id as string));
    const privateProjects = this.brain.search.privateProjects();
    const qv = localEmbed(text);
    const qTok = new Set(tokenize(text));
    const rows = this.db.all<Row>(
      `SELECT m.* FROM memories m WHERE m.user_id = ? AND m.status = 'active' AND m.scope <> 'private'
         AND m.memory_type IN ('research','lesson','procedural')
         AND COALESCE(m.project_id,'') <> ? AND m.confidence >= 0.4 LIMIT 3000`,
      [this.store.userId, projectId],
    );
    const projNames = new Map(this.store.listProjects(true).map((x) => [x.id, x.name]));
    const out: Row[] = [];
    for (const r of rows) {
      const m = this.store.toMemory(r);
      if (dismissed.has(m.id)) continue;
      if (m.project_id && privateProjects.has(m.project_id)) continue;
      if (m.title.startsWith("Research: ")) continue; // topic hubs are containers, suggest the insights
      const sim = cosine(qv, localEmbed(`${m.title} ${m.domain} ${m.content}`));
      const overlap = tokenize(`${m.title} ${m.domain} ${m.tags.join(" ")}`).filter((t) => qTok.has(t)).length;
      const score = sim * 0.75 + Math.min(0.3, overlap * 0.08) + (m.memory_type === "lesson" ? 0.04 : 0) + m.confidence * 0.05;
      if (score < 0.3) continue;
      const from = m.project_id ? projNames.get(m.project_id) ?? "another project" : null;
      out.push({
        memory_id: m.id, title: m.title, memory_type: m.memory_type, summary: truncate(m.summary || m.content, 240), confidence: m.confidence,
        evidence: m.evidence, source: m.source, from_project: from, scope: m.scope, score: Math.round(score * 100) / 100,
        reason: `${m.memory_type === "research" ? "Research insight" : m.memory_type === "lesson" ? "Lesson learned" : "Reusable procedure"}${from ? ` from ${from}` : ""}${m.scope === "project" ? " (project-specific: check it fits before reusing)" : ""}`,
      });
    }
    const prefs = this.relevantPreferences(text, projectId, 3).filter((x) => String(x.scope) === "global").map((x) => ({ memory_id: x.id, title: truncate(String(x.preference), 90), memory_type: "preference", summary: x.preference, confidence: x.confidence, evidence: null, source: x.source, from_project: null, scope: "global", score: Number(x.relevance), reason: "Your working preference" }));
    return [...out.sort((a, b) => Number(b.score) - Number(a.score)).slice(0, limit), ...prefs].slice(0, limit + 3);
  }

  /** Stores fresh suggestions for the project's panel (idempotent). */
  refreshTransfer(projectId: string): Row {
    const cands = this.transferCandidates(projectId).filter((c) => c.memory_type !== "preference");
    const t = nowIso();
    let added = 0;
    for (const c of cands) {
      const r = this.db.run("INSERT OR IGNORE INTO transfer_suggestions(user_id, project_id, memory_id, reason, score, status, created_at) VALUES (?,?,?,?,?,'new',?)", [this.store.userId, projectId, c.memory_id, c.reason, c.score, t]);
      added += r.changes;
    }
    return { project_id: projectId, suggestions: this.transferSuggestions(projectId), added };
  }

  transferSuggestions(projectId: string, status = "new"): Row[] {
    return this.db
      .all<Row>("SELECT * FROM transfer_suggestions WHERE project_id = ? AND user_id = ? AND (? = 'all' OR status = ?) ORDER BY score DESC LIMIT 20", [projectId, this.store.userId, status, status])
      .map((s) => {
        const m = this.store.getMemory(s.memory_id as string);
        return m ? { ...s, title: m.title, memory_type: m.memory_type, summary: truncate(m.summary || m.content, 240), confidence: m.confidence, evidence: m.evidence, sources: this.sourcesOf(m.id).length } : null;
      })
      .filter(Boolean) as Row[];
  }

  decideTransfer(id: number, decision: "dismissed" | "accepted"): Row {
    const s = this.db.get<Row>("SELECT * FROM transfer_suggestions WHERE id = ? AND user_id = ?", [id, this.store.userId]);
    if (!s) throw new MothError("not_found", `No suggestion ${id}`);
    this.db.tx(() => {
      this.db.run("UPDATE transfer_suggestions SET status = ?, decided_at = ? WHERE id = ?", [decision, nowIso(), id]);
      const p = this.store.getProject(s.project_id as string);
      if (decision === "accepted" && p?.hub_memory_id && this.store.getMemory(s.memory_id as string))
        this.store.link(s.memory_id as string, p.hub_memory_id, "RELATED_TO", "You marked this knowledge as useful for the project", this.ctx("Knowledge transfer accepted", "user"), { strength: 0.6 });
      this.brain.cortex.recordRetrievalFeedback({ useful: decision === "accepted" ? [s.memory_id as string] : [], not_useful: decision === "dismissed" ? [s.memory_id as string] : [], source: "knowledge_transfer" });
    });
    return { id, status: decision };
  }

  // ---------------------------------------------------------------- the profile at a glance
  profile(): Row {
    const prefs = this.listPreferences({ include_archived: false });
    const byStatus = (s: string) => prefs.filter((p) => p.status === s).length;
    return {
      notice: "MOTH personalises by storing and retrieving these records. It does not change any AI model's weights.",
      preferences: prefs,
      counts: { confirmed: byStatus("confirmed"), tentative: byStatus("tentative"), outdated: byStatus("outdated"), rejected: Number(this.db.value("SELECT COUNT(*) FROM preference_meta WHERE status = 'rejected'") ?? 0) },
      lessons: this.listLessons().slice(0, 50).map((l) => ({ id: l.id, title: l.title, scope: l.scope, project_id: l.project_id, verified: l.verified, confidence: l.confidence })),
      research_count: Number(this.db.value("SELECT COUNT(*) FROM memories WHERE user_id = ? AND memory_type = 'research' AND status = 'active'", [this.store.userId]) ?? 0),
      settings: { enabled: this.brain.settings.get("adaptation.enabled"), inferAfter: this.brain.settings.get("adaptation.inferAfter"), maxInContext: this.brain.settings.get("adaptation.maxInContext") },
    };
  }

  /** For the research library: sources stored per memory id. */
  sourcesFor(ids: string[]): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    for (const id of ids) out[id] = this.sourcesOf(id);
    return out;
  }
}

export function parseList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" ? safeJson<string[]>(v, []) : [];
}
