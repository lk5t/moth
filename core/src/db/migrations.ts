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
