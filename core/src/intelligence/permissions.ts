// Least-privilege permissions for MOTH's proactive intelligence (background analysis and agents).
//
// Checked in the engine (never only in the UI): every agent/background action calls `assert()` before reading a
// project or changing anything. A denial throws `permission_denied` and is written to the activity log.
//
// Resolution order for (subject, permission, project): explicit project row → explicit '*' row → built-in default.
// Private projects are never readable by background work or agents unless the user explicitly allows that project.
import type { Database, Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { MemoryStore } from "../engine/store.ts";
import { MothError } from "../engine/types.ts";

export const PERMISSIONS = [
  "read_memories",
  "read_projects",
  "create_analysis",
  "propose_changes",
  "apply_safe_changes",
  "modify_important",
  "read_local_folders",
  "network",
  "external_tools",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABEL: Record<Permission, { label: string; hint: string }> = {
  read_memories: { label: "Read memories", hint: "Look at stored memories to analyse them." },
  read_projects: { label: "Read project data", hint: "Look at projects, their decisions, blockers and handoffs." },
  create_analysis: { label: "Create analysis results", hint: "Save findings, summaries and suggestions (never changes memories)." },
  propose_changes: { label: "Propose memory changes", hint: "Put suggested merges, links or edits in your review queue." },
  apply_safe_changes: { label: "Apply safe changes", hint: "Rebuild search indexes and other derived data that can always be recreated." },
  modify_important: { label: "Change important knowledge", hint: "Merge, replace or delete memories, change confirmed preferences or project requirements without asking." },
  read_local_folders: { label: "Read approved local folders", hint: "Read files in folders you approved in MOTH." },
  network: { label: "Use the internet", hint: "Fetch web pages or call online services." },
  external_tools: { label: "Use external tools", hint: "Run programs or write to other apps." },
};

export const SUBJECTS = ["background", "agent:research_analyst", "agent:memory_curator", "agent:project_analyst", "agent:knowledge_connector"] as const;
export type Subject = (typeof SUBJECTS)[number] | `client:${string}`;

/** Built-in defaults: analysis and proposals yes, anything consequential or external no. */
const DEFAULTS: Record<Permission, boolean> = {
  read_memories: true,
  read_projects: true,
  create_analysis: true,
  propose_changes: true,
  apply_safe_changes: true,
  modify_important: false,
  read_local_folders: false,
  network: false,
  external_tools: false,
};

/** Permissions that can never be granted to automated work, whatever the database says. */
const NEVER_AUTOMATIC = new Set<Permission>(["modify_important", "external_tools"]);

export class Permissions {
  constructor(
    private db: Database,
    private store: MemoryStore,
  ) {}

  private row(subject: string, perm: Permission, projectId: string): Row | undefined {
    return this.db.get<Row>("SELECT allowed FROM permissions WHERE subject = ? AND permission = ? AND project_id = ?", [subject, perm, projectId]);
  }

  /** Is `subject` allowed `perm` (optionally for one project)? */
  allowed(subject: Subject | string, perm: Permission, projectId?: string | null): boolean {
    if (!(PERMISSIONS as readonly string[]).includes(perm)) return false;
    if (NEVER_AUTOMATIC.has(perm) && (subject === "background" || subject.startsWith("agent:"))) return false;
    if (projectId) {
      const own = this.row(subject, perm, projectId);
      if (own) return !!own.allowed;
      // Private projects stay out of automated analysis unless explicitly allowed above.
      if ((perm === "read_memories" || perm === "read_projects") && (subject === "background" || subject.startsWith("agent:"))) {
        const priv = this.db.value<number>("SELECT private FROM projects WHERE id = ?", [projectId]);
        if (priv) return false;
      }
    }
    const all = this.row(subject, perm, "*");
    if (all) return !!all.allowed;
    return DEFAULTS[perm];
  }

  assert(subject: Subject | string, perm: Permission, projectId?: string | null, what?: string): void {
    if (this.allowed(subject, perm, projectId)) return;
    const label = PERMISSION_LABEL[perm]?.label ?? perm;
    this.store.logActivity({ kind: "permission", source: subject, action: "denied", status: "error", detail: { permission: perm, project_id: projectId ?? null, what: what ?? null } });
    throw new MothError("permission_denied", `${describe(subject)} is not allowed to: ${label.toLowerCase()}${projectId ? " in this project" : ""}. You can change this in MOTH → Connect → Permissions.`);
  }

  set(subject: Subject | string, perm: Permission, allowed: boolean, projectId: string | null = null, by = "user"): Row {
    if (!(PERMISSIONS as readonly string[]).includes(perm)) throw new MothError("invalid_input", `Unknown permission "${perm}"`);
    if (allowed && NEVER_AUTOMATIC.has(perm) && (subject === "background" || subject.startsWith("agent:"))) {
      throw new MothError("invalid_input", `${PERMISSION_LABEL[perm].label} can't be given to automated work: those changes always wait for your approval.`);
    }
    this.db.run(
      `INSERT INTO permissions(subject, permission, project_id, allowed, updated_at, updated_by) VALUES (?,?,?,?,?,?)
       ON CONFLICT(subject, permission, project_id) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [subject, perm, projectId ?? "*", allowed ? 1 : 0, nowIso(), by],
    );
    this.store.logActivity({ kind: "permission", source: by, action: allowed ? "granted" : "revoked", detail: { subject, permission: perm, project_id: projectId ?? "*" } });
    return { subject, permission: perm, project_id: projectId ?? "*", allowed };
  }

  /** Removes a project-specific override (the '*' / default rule applies again). */
  clear(subject: string, perm: Permission, projectId: string): void {
    this.db.run("DELETE FROM permissions WHERE subject = ? AND permission = ? AND project_id = ?", [subject, perm, projectId]);
  }

  /** The effective matrix for the UI. */
  matrix(subjects: string[] = [...SUBJECTS]): Row[] {
    const overrides = this.db.all<Row>("SELECT * FROM permissions WHERE project_id <> '*' ORDER BY subject, permission");
    return subjects.map((s) => ({
      subject: s,
      label: describe(s),
      permissions: PERMISSIONS.map((p) => ({ permission: p, ...PERMISSION_LABEL[p], allowed: this.allowed(s, p), locked: NEVER_AUTOMATIC.has(p) && (s === "background" || s.startsWith("agent:")) })),
      project_overrides: overrides.filter((o) => o.subject === s).map((o) => ({ permission: o.permission, project_id: o.project_id, allowed: !!o.allowed })),
    }));
  }
}

export function describe(subject: string): string {
  const names: Record<string, string> = {
    background: "Background analysis",
    "agent:research_analyst": "Research Analyst",
    "agent:memory_curator": "Memory Curator",
    "agent:project_analyst": "Project Analyst",
    "agent:knowledge_connector": "Knowledge Connector",
  };
  if (names[subject]) return names[subject];
  if (subject.startsWith("client:")) return subject.slice(7);
  return subject;
}
