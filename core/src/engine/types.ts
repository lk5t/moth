export const CATEGORIES = [
  "project", "fact", "idea", "decision", "task", "solution", "error", "research", "person", "concept", "preference",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const RELATION_TYPES = [
  "RELATED_TO", "BELONGS_TO", "DEPENDS_ON", "SOLVES", "CAUSED_BY", "REFERENCES", "SUPERSEDES", "CONTINUES",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export type MemoryStatus = "active" | "archived" | "superseded" | "merged";
export type Actor = "claude" | "moth" | "user" | "system";
export type Verification = "unverified" | "verified" | "user_confirmed" | "disputed";

export interface Memory {
  id: string;
  user_id: string;
  title: string;
  content: string;
  summary: string;
  category: Category;
  tags: string[];
  source: string;
  source_ref: string | null;
  source_timestamp: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  importance: number;
  confidence: number;
  verification: Verification;
  embedding_ref: string | null;
  status: MemoryStatus;
  archived_at: string | null;
  merged_into: string | null;
  superseded_by: string | null;
  version: number;
  manual_lock: boolean;
  task_state: "open" | "done" | null;
  flags: string[];
  access_count: number;
  last_accessed_at: string | null;
  is_demo: boolean;
}

export interface Relationship {
  id: string;
  source_id: string;
  target_id: string;
  type: RelationType;
  reason: string;
  strength: number;
  created_by: Actor;
  created_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  aliases: string[];
  description: string;
  goals: string;
  status: string;
  files: string[];
  hub_memory_id: string | null;
  archived: boolean;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
}

export interface MemoryInput {
  title?: string;
  content: string;
  summary?: string;
  category?: Category;
  tags?: string[];
  source?: string;
  source_ref?: string | null;
  source_timestamp?: string | null;
  project_id?: string | null;
  importance?: number;
  confidence?: number;
  verification?: Verification;
  task_state?: "open" | "done" | null;
  is_demo?: boolean;
}

export interface ChangeContext {
  actor: Actor;
  reason: string;
  task_id?: string | null;
}

export class MothError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
