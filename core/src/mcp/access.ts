// Per-client project access for MCP tools (MOTH Connect).
//
// Enforced in the engine, on every tool call, for each connected app separately (subject "client:<name>"):
//  - before the call: reading needs "read_memories", changing needs "write_memories" — globally, for the project a
//    tool names, and for the project of every memory id passed in;
//  - after the call: memories and projects the client may not read are removed from the result (wherever they
//    appear), and the result says how many were withheld, so nothing is hidden silently.
import type { Row } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { MothError } from "../engine/types.ts";
import type { Permission } from "../intelligence/permissions.ts";

const ID_KEYS = new Set(["id", "ids", "source_id", "target_id", "keep_id", "merge_ids", "memory_id", "memory_ids", "relates_to", "related_to", "into", "from"]);

export class ClientAccess {
  private projectOf = new Map<string, string | null>();
  withheld = 0;
  constructor(
    private brain: Brain,
    readonly subject: string,
  ) {}

  private memProject(id: string): string | null {
    if (!this.projectOf.has(id)) this.projectOf.set(id, (this.brain.db.value<string>("SELECT project_id FROM memories WHERE id = ?", [id]) ?? null) as string | null);
    return this.projectOf.get(id)!;
  }

  /** Throws permission_denied before the tool runs if this client may not do this. */
  preflight(tool: string, kind: "read" | "write", args: Row): void {
    const p = this.brain.permissions;
    const need: Permission = kind === "read" ? "read_memories" : "write_memories";
    p.assert(this.subject, need, null, tool);
    if (typeof args.project === "string" && args.project) {
      const proj = this.brain.store.getProject(args.project);
      if (proj) p.assert(this.subject, need, proj.id, `${tool} in project ${proj.name}`);
    }
    const ids = new Set<string>();
    for (const [k, v] of Object.entries(args ?? {})) {
      if (!ID_KEYS.has(k)) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && (x.startsWith("mem_") || x.startsWith("doc_"))) ids.add(x);
    }
    for (const id of ids) {
      const pid = id.startsWith("doc_") ? this.docProject(id) : this.memProject(id);
      if (pid) p.assert(this.subject, need, pid, `${tool} on a memory in a restricted project`);
    }
  }

  private deniedProject(pid: unknown): boolean {
    return typeof pid === "string" && pid !== "" && !this.brain.permissions.allowed(this.subject, "read_projects", pid);
  }
  private deniedMemory(id: string): boolean {
    const pid = this.memProject(id);
    return !!pid && !this.brain.permissions.allowed(this.subject, "read_memories", pid);
  }
  private docProject(id: string): string | null {
    const key = `doc:${id}`;
    if (!this.projectOf.has(key)) this.projectOf.set(key, (this.brain.db.value<string>("SELECT project_id FROM documents WHERE id = ?", [id]) ?? null) as string | null);
    return this.projectOf.get(key)!;
  }
  private denied(o: Row): boolean {
    const id = typeof o.id === "string" ? o.id : null;
    if (id?.startsWith("mem_")) return this.deniedMemory(id);
    if (id?.startsWith("doc_")) {
      const pid = this.docProject(id);
      return !!pid && !this.brain.permissions.allowed(this.subject, "read_memories", pid);
    }
    if (id?.startsWith("prj_")) return this.deniedProject(id);
    if (o.memory && typeof o.memory === "object" && typeof (o.memory as Row).id === "string" && ((o.memory as Row).id as string).startsWith("mem_")) return this.deniedMemory((o.memory as Row).id as string);
    if ("project_id" in o && this.deniedProject(o.project_id)) return true;
    return false;
  }

  /** Removes what the client may not read, wherever it appears in the result. */
  filter<T>(value: T): T {
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > 12 || v === null || typeof v !== "object") return v;
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        for (const x of v) {
          if (x && typeof x === "object" && !Array.isArray(x) && this.denied(x as Row)) {
            this.withheld++;
            continue;
          }
          out.push(walk(x, depth + 1));
        }
        return out;
      }
      const o: Row = {};
      for (const [k, x] of Object.entries(v as Row)) {
        if (x && typeof x === "object" && !Array.isArray(x) && this.denied(x as Row)) {
          this.withheld++;
          o[k] = null;
        } else o[k] = walk(x, depth + 1);
      }
      return o;
    };
    // A single requested memory the client may not read is a denial, not an empty answer.
    if (value && typeof value === "object" && !Array.isArray(value) && this.denied(value as Row)) {
      throw new MothError("permission_denied", "This memory belongs to a project this app isn't allowed to read. You can change this in MOTH → Connections → Permissions.");
    }
    const out = walk(value, 0) as T;
    if (this.withheld && out && typeof out === "object" && !Array.isArray(out)) {
      (out as Row).withheld = { count: this.withheld, note: "Some memories or projects were left out because this app isn't allowed to read those projects (MOTH → Connections → Permissions)." };
    }
    return out;
  }
}
