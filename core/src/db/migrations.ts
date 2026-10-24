// Ordered, append-only schema migrations. Never edit an applied migration; add a new one.
import type { Database } from "./database.ts";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local','google')),
  email TEXT,
  name TEXT,
  picture TEXT,
  google_sub TEXT UNIQUE,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',
  hub_memory_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT,
  UNIQUE (user_id, slug)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('project','fact','idea','decision','task','solution','error','research','person','concept','preference')),
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user',
  source_ref TEXT,
  source_timestamp TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','verified','user_confirmed','disputed')),
  embedding_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','superseded','merged')),
  archived_at TEXT,
  merged_into TEXT,
  superseded_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  manual_lock INTEGER NOT NULL DEFAULT 0,
  task_state TEXT CHECK (task_state IS NULL OR task_state IN ('open','done')),
  flags TEXT NOT NULL DEFAULT '[]',
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_memories_user_status ON memories(user_id, status);
CREATE INDEX idx_memories_project ON memories(project_id, status);
CREATE INDEX idx_memories_updated ON memories(user_id, updated_at DESC);
CREATE INDEX idx_memories_category ON memories(user_id, category);

CREATE TABLE memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL,
  project_id TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  change_type TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (memory_id, version)
);

CREATE TABLE memory_relationships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('RELATED_TO','BELONGS_TO','DEPENDS_ON','SOLVES','CAUSED_BY','REFERENCES','SUPERSEDES','CONTINUES')),
  reason TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 0.5,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (source_id <> target_id),
  UNIQUE (source_id, target_id, type)
);
CREATE INDEX idx_rel_source ON memory_relationships(source_id);
CREATE INDEX idx_rel_target ON memory_relationships(target_id);

CREATE TABLE project_memories (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, memory_id)
);
CREATE INDEX idx_pm_memory ON project_memories(memory_id);

CREATE TABLE memory_embeddings (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, model)
);
CREATE INDEX idx_emb_model ON memory_embeddings(model, created_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  client TEXT,
  context_memory_ids TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_tasks_user ON tasks(user_id, started_at DESC);

CREATE TABLE learning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT,
  kind TEXT NOT NULL,
  memory_id TEXT,
  related_memory_id TEXT,
  relationship_id TEXT,
  project_id TEXT,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('claude','moth','user','system')),
  undo TEXT,
  reverted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_le_user_time ON learning_events(user_id, created_at DESC);
CREATE INDEX idx_le_memory ON learning_events(memory_id);

CREATE TABLE activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ok',
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_time ON activity_logs(created_at DESC);
CREATE INDEX idx_activity_kind ON activity_logs(kind, created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  config TEXT NOT NULL DEFAULT '{}',
  scopes TEXT NOT NULL DEFAULT '[]',
  connected_at TEXT,
  last_used_at TEXT,
  last_error TEXT,
  UNIQUE (user_id, provider)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  run_after TEXT NOT NULL,
  last_error TEXT,
  result TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_ready ON jobs(status, run_after, priority);
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

CREATE TABLE node_positions (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  client_name TEXT,
  client_version TEXT,
  transport TEXT NOT NULL,
  pid INTEGER,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_tool TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'connected'
);

-- Change feed written by triggers, so every process (desktop app, MCP server) produces
-- events the UI can stream, no matter who changed the data.
CREATE TABLE db_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER trg_mem_ins AFTER INSERT ON memories BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('memory', NEW.id, 'insert');
END;
CREATE TRIGGER trg_mem_upd AFTER UPDATE ON memories
  WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status
    OR OLD.category IS NOT NEW.category OR OLD.importance IS NOT NEW.importance OR OLD.project_id IS NOT NEW.project_id
    OR OLD.summary IS NOT NEW.summary OR OLD.tags IS NOT NEW.tags OR OLD.task_state IS NOT NEW.task_state
BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('memory', NEW.id, 'update');
END;
CREATE TRIGGER trg_mem_del AFTER DELETE ON memories BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('memory', OLD.id, 'delete');
END;
CREATE TRIGGER trg_rel_ins AFTER INSERT ON memory_relationships BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('relationship', NEW.id, 'insert');
END;
CREATE TRIGGER trg_rel_del AFTER DELETE ON memory_relationships BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('relationship', OLD.id, 'delete');
END;
CREATE TRIGGER trg_proj_any AFTER UPDATE ON projects BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('project', NEW.id, 'update');
END;
CREATE TRIGGER trg_proj_ins AFTER INSERT ON projects BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('project', NEW.id, 'insert');
END;
CREATE TRIGGER trg_le_ins AFTER INSERT ON learning_events BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('learning', CAST(NEW.id AS TEXT), 'insert');
END;
CREATE TRIGGER trg_act_ins AFTER INSERT ON activity_logs BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('activity', CAST(NEW.id AS TEXT), 'insert');
END;

-- Full-text search (external content table kept in sync by triggers).
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, content, summary, tags,
  content='memories', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER trg_fts_ins AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, summary, tags) VALUES (NEW.rowid, NEW.title, NEW.content, NEW.summary, NEW.tags);
END;
CREATE TRIGGER trg_fts_del AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, summary, tags) VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.summary, OLD.tags);
END;
CREATE TRIGGER trg_fts_upd AFTER UPDATE OF title, content, summary, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, summary, tags) VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.summary, OLD.tags);
  INSERT INTO memories_fts(rowid, title, content, summary, tags) VALUES (NEW.rowid, NEW.title, NEW.content, NEW.summary, NEW.tags);
END;
`,
  },
  {
    version: 2,
    name: "cortex: review queue, feedback, installed AI components",
    sql: `
-- Proposals from Cortex that need the user's decision (balanced autonomy).
CREATE TABLE review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','applied','failed','expired')),
  operation TEXT NOT NULL,
  target_memory_id TEXT,
  proposal TEXT NOT NULL,
  statement TEXT NOT NULL,
  relation TEXT,
  reason TEXT NOT NULL,
  risk TEXT NOT NULL,
  confidence REAL,
  provider TEXT,
  model TEXT,
  source TEXT,
  source_ref TEXT,
  task_id TEXT,
  job_id INTEGER,
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX idx_review_status ON review_queue(user_id, status, id DESC);
CREATE TRIGGER trg_review_ins AFTER INSERT ON review_queue BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('review', CAST(NEW.id AS TEXT), 'insert');
END;
CREATE TRIGGER trg_review_upd AFTER UPDATE OF status ON review_queue BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('review', CAST(NEW.id AS TEXT), 'update');
END;

-- Feedback learning: the user's verdicts on MOTH's memory decisions, retrieved as examples later.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('review','learning_event','relationship','memory')),
  subject_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('correct','incorrect','irrelevant','keep_separate','should_merge','useful','not_useful')),
  operation TEXT,
  statement TEXT,
  note TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_user ON feedback(user_id, created_at DESC);

-- Retrieval learning: was a retrieved memory useful for a task? (explicit signals only)
CREATE TABLE retrieval_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  task_id TEXT,
  query TEXT,
  useful INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rf_memory ON retrieval_feedback(memory_id);

-- Installed local AI components (runtime builds and GGUF models), verified by SHA-256.
CREATE TABLE ai_components (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('runtime','model')),
  version TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: "v0.2.5 first flight & adaptation: memory types, scope, pinning, provenance, preferences, lessons, knowledge transfer, inbox",
    sql: `
-- Additive only: existing rows keep working; new columns get safe defaults and are backfilled below.
ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'semantic'
  CHECK (memory_type IN ('episodic','semantic','procedural','project','preference','research','lesson'));
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','project','private'));
ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN domain TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR evidence IN ('sourced','unsourced','speculative'));

UPDATE memories SET memory_type = CASE
  WHEN category = 'project' THEN 'project'
  WHEN category = 'preference' THEN 'preference'
  WHEN category = 'research' THEN 'research'
  WHEN category = 'solution' THEN 'procedural'
  WHEN category IN ('task','error') THEN 'episodic'
  WHEN category = 'decision' AND project_id IS NOT NULL THEN 'project'
  ELSE 'semantic' END;
UPDATE memories SET scope = CASE WHEN project_id IS NULL THEN 'global' ELSE 'project' END;
CREATE INDEX idx_memories_type ON memories(user_id, memory_type, status);
CREATE INDEX idx_memories_pinned ON memories(user_id, pinned) WHERE pinned = 1;

DROP TRIGGER trg_mem_upd;
CREATE TRIGGER trg_mem_upd AFTER UPDATE ON memories
  WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status
    OR OLD.category IS NOT NEW.category OR OLD.importance IS NOT NEW.importance OR OLD.project_id IS NOT NEW.project_id
    OR OLD.summary IS NOT NEW.summary OR OLD.tags IS NOT NEW.tags OR OLD.task_state IS NOT NEW.task_state
    OR OLD.pinned IS NOT NEW.pinned OR OLD.memory_type IS NOT NEW.memory_type OR OLD.scope IS NOT NEW.scope
BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('memory', NEW.id, 'update');
END;

-- Projects: knowledge transfer can be switched off, and private projects never leak into other contexts.
ALTER TABLE projects ADD COLUMN transfer_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN private INTEGER NOT NULL DEFAULT 0;

-- Provenance for research and any other sourced memory. URLs are stored exactly as submitted; never invented.
CREATE TABLE memory_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  retrieved_at TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'citation' CHECK (kind IN ('citation','file','conversation','import')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sources_memory ON memory_sources(memory_id);

-- Adaptation profile: preferences are memories (memory_type 'preference') plus this metadata,
-- so they get versions, search, The Mind and undo for free.
CREATE TABLE preference_meta (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  area TEXT NOT NULL DEFAULT 'other' CHECK (area IN ('coding','tools','ui','workflow','communication','requirement','instruction','lesson','other')),
  status TEXT NOT NULL DEFAULT 'tentative' CHECK (status IN ('confirmed','tentative','rejected','outdated')),
  explicit INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE preference_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  observation TEXT NOT NULL,
  source TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pref_ev ON preference_evidence(memory_id);
CREATE TRIGGER trg_pref_upd AFTER UPDATE ON preference_meta BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('memory', NEW.memory_id, 'update');
END;

-- Lessons learned from verified corrections.
CREATE TABLE lesson_meta (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  problem TEXT NOT NULL,
  correction TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revised','rejected')),
  created_at TEXT NOT NULL
);

-- Knowledge transfer suggestions shown in a project space ("3 previous insights may help").
CREATE TABLE transfer_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','dismissed','accepted')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (project_id, memory_id)
);
CREATE TRIGGER trg_transfer_ins AFTER INSERT ON transfer_suggestions BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('transfer', CAST(NEW.id AS TEXT), 'insert');
END;

-- Unified Memory Inbox: the review queue gains a kind, defer, affected memories and sources.
ALTER TABLE review_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'cortex';
ALTER TABLE review_queue ADD COLUMN deferred_until TEXT;
ALTER TABLE review_queue ADD COLUMN affected_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE review_queue ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
CREATE TRIGGER trg_review_defer AFTER UPDATE OF deferred_until ON review_queue BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('review', CAST(NEW.id AS TEXT), 'update');
END;

-- Settings changes reach every window (e.g. Privacy Mode toggled from the tray). Timestamps that change often are skipped.
CREATE TRIGGER trg_settings_ins AFTER INSERT ON settings WHEN NEW.key NOT IN ('inbox.lastScan','sleep.lastRun','backup.lastOk','vault.lastSync') BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('settings', NEW.key, 'update');
END;
CREATE TRIGGER trg_settings_upd AFTER UPDATE ON settings WHEN NEW.key NOT IN ('inbox.lastScan','sleep.lastRun','backup.lastOk','vault.lastSync') AND OLD.value IS NOT NEW.value BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('settings', NEW.key, 'update');
END;

-- Files picked up from the Claude Inbox folder (content hash prevents duplicates).
CREATE TABLE inbox_files (
  hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('imported','learned','queued','skipped','failed')),
  memory_ids TEXT NOT NULL DEFAULT '[]',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`,
  },
  {
    // v0.4.0 "Consciousness" — Milestone 1: durable intelligence foundation.
    // Jobs gain lifecycle states (interrupted, awaiting approval), ownership, scope, time limits and timestamps.
    // SQLite cannot change a CHECK constraint in place, so the table is rebuilt; every existing row is kept.
    version: 4,
    name: "intelligence_foundation",
    sql: `
CREATE TABLE jobs_v4 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled','interrupted','awaiting_approval')),
  priority INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  run_after TEXT NOT NULL,
  last_error TEXT,
  result TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  scope TEXT NOT NULL DEFAULT 'system',
  timeout_ms INTEGER,
  started_at TEXT,
  finished_at TEXT,
  cancel_reason TEXT,
  result_ref TEXT,
  recoveries INTEGER NOT NULL DEFAULT 0
);
INSERT INTO jobs_v4(id, kind, payload, dedupe_key, status, priority, attempts, max_attempts, run_after, last_error, result, locked_by, locked_at, created_at, updated_at, finished_at)
  SELECT id, kind, payload, dedupe_key, status, priority, attempts, max_attempts, run_after, last_error, result, locked_by, locked_at, created_at, updated_at,
         CASE WHEN status IN ('done','failed','cancelled') THEN updated_at END
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_v4 RENAME TO jobs;
CREATE INDEX idx_jobs_ready ON jobs(status, run_after, priority);
CREATE INDEX idx_jobs_owner ON jobs(owner, id DESC);
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running','awaiting_approval');
CREATE TRIGGER trg_jobs_ins AFTER INSERT ON jobs BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('job', CAST(NEW.id AS TEXT), 'insert');
END;
CREATE TRIGGER trg_jobs_status AFTER UPDATE OF status ON jobs WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('job', CAST(NEW.id AS TEXT), 'update');
END;

-- A job "awaiting approval" completes when the last review it created is decided (in any process).
CREATE TRIGGER trg_review_settles_job AFTER UPDATE OF status ON review_queue
  WHEN NEW.job_id IS NOT NULL AND NEW.status <> 'pending'
BEGIN
  UPDATE jobs SET status = 'done', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id = NEW.job_id AND status = 'awaiting_approval'
    AND NOT EXISTS (SELECT 1 FROM review_queue r WHERE r.job_id = NEW.job_id AND r.status = 'pending');
END;

-- Checkpoints: a step recorded here is never executed twice, even if the job runs again after a crash.
CREATE TABLE job_steps (
  job_id INTEGER NOT NULL,
  step TEXT NOT NULL,
  result TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (job_id, step)
);

-- Least-privilege permissions for background work, agents and integrations. Checked by the engine.
-- project_id '*' = every project; a project-specific row overrides the '*' row.
CREATE TABLE permissions (
  subject TEXT NOT NULL,
  permission TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '*',
  allowed INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'user',
  PRIMARY KEY (subject, permission, project_id)
);
CREATE TRIGGER trg_perm_any AFTER INSERT ON permissions BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('permission', NEW.subject, 'update');
END;
CREATE TRIGGER trg_perm_upd AFTER UPDATE ON permissions BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('permission', NEW.subject, 'update');
END;

-- Findings: everything MOTH's intelligence produces (awareness, knowledge health, discoveries, agent
-- recommendations), always with its evidence and how it was produced. The fingerprint identifies "the same
-- finding" across scans; evidence_hash changes when the supporting memories change materially.
CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('awareness','health','discovery','agent')),
  category TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  project_ids TEXT NOT NULL DEFAULT '[]',
  memory_ids TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  algorithm TEXT NOT NULL,
  model TEXT,
  confidence REAL,
  evidence_status TEXT NOT NULL DEFAULT 'possible' CHECK (evidence_status IN ('confirmed','possible')),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','low','medium','high')),
  suggested_action TEXT NOT NULL DEFAULT '',
  action TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','viewed','dismissed','resolved','superseded','confirmed')),
  review_id INTEGER,
  job_id INTEGER,
  agent TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_findings_status ON findings(user_id, kind, status, id DESC);
CREATE INDEX idx_findings_fp ON findings(user_id, kind, fingerprint, id DESC);
CREATE UNIQUE INDEX idx_findings_active ON findings(user_id, kind, fingerprint) WHERE status IN ('new','viewed');
CREATE TRIGGER trg_find_ins AFTER INSERT ON findings BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('finding', CAST(NEW.id AS TEXT), 'insert');
END;
CREATE TRIGGER trg_find_upd AFTER UPDATE OF status ON findings WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO db_changes(entity, entity_id, op) VALUES ('finding', CAST(NEW.id AS TEXT), 'update');
END;
`,
  },
];

export function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.tx(() => {
      // Another process may have applied it while we waited for the write lock.
      const already = db.value("SELECT 1 FROM schema_migrations WHERE version = ?", [m.version]);
      if (already) return;
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)", [m.version, m.name, new Date().toISOString()]);
    });
  }
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
