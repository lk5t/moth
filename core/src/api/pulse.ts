// MOTH Pulse (live dashboard) and the Memory Timeline. Every number comes from the database; nothing is sample data.
import type { Row } from "../db/database.ts";
import { connectionStatus } from "../connections.ts";
import type { Brain } from "../engine/brain.ts";
import { safeJson } from "../engine/store.ts";

const FEED_KINDS: Record<string, string> = {
  created: "Memory created",
  updated: "Memory updated",
  appended: "Information added",
  linked: "Connection discovered",
  merged: "Memories merged",
  superseded: "Memory replaced by newer information",
  conflict_flagged: "Possible conflict detected",
  preference_confirmed: "Preference confirmed",
  preference_rejected: "Preference rejected",
  preference_outdated: "Preference marked outdated",
  reinforced: "Knowledge confirmed again",
  cortex_learned: "Cortex analysed new information",
  inbox_import: "Imported from the Claude Inbox",
  imported: "Imported notes",
  reverted: "Change undone",
  project_created: "Project started",
  task_ended: "Claude task finished",
  privacy_on: "Privacy Mode on",
  privacy_off: "Privacy Mode off",
  reflection: "Sleep Cycle reflection",
  conflict_cleared: "Conflict resolved",
  restored_version: "Earlier version restored",
  pinned: "Memory pinned",
};

export function pulse(brain: Brain): Row {
  const db = brain.db;
  const uid = brain.store.userId;
  const n = (sql: string, p: unknown[] = []) => Number(db.value(sql, p) ?? 0);
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const conn = connectionStatus(brain);
  const rt = brain.cortex.runtime()?.info?.() ?? null;
  const events = brain.store.listEvents({ limit: 40 }).map((e) => ({ id: e.id, at: e.created_at, kind: e.kind, label: FEED_KINDS[e.kind as string] ?? String(e.kind).replace(/_/g, " "), description: e.description, memory_id: e.memory_id, related_memory_id: e.related_memory_id, actor: e.actor, project_id: e.project_id }));
  const system = brain.store
    .listActivity({ limit: 60 })
    .filter((a) => !String(a.source).startsWith("moth-self-test"))
    .filter((a) => (a.kind === "cortex" && ["load", "unload", "install"].includes(String(a.action))) || a.kind === "mcp_connect" || (a.kind === "mcp_call" && a.status === "error") || a.kind === "sleep" || (a.kind === "system" && a.action === "backup"))
    .slice(0, 20)
    .map((a) => ({
      id: `a${a.id}`, at: a.created_at, kind: `${a.kind}:${a.action}`,
      label: a.kind === "mcp_connect" ? "Claude connected" : a.kind === "mcp_call" ? "MCP call failed" : a.kind === "sleep" ? "Sleep Cycle completed" : a.action === "backup" ? (a.status === "error" ? "Backup failed" : "Backup saved") : a.action === "load" ? "Model loaded" : a.action === "unload" ? "Model unloaded" : `Cortex ${a.action}`,
      description: a.kind === "mcp_call" ? `${a.action}: ${(a.detail as Row)?.error ?? ""}` : a.kind === "mcp_connect" ? `${a.source}` : a.status === "error" ? String((a.detail as Row)?.error ?? "") : "",
      status: a.status,
    }));
  const feed = [...events, ...system].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50);
  const recentCreated = db.all<Row>("SELECT id, title, memory_type, created_at, source FROM memories WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 6", [uid]);
  const recentUpdated = db.all<Row>("SELECT id, title, memory_type, updated_at, version FROM memories WHERE user_id = ? AND status = 'active' AND version > 1 ORDER BY updated_at DESC LIMIT 6", [uid]);
  const recentLinks = db.all<Row>(
    `SELECT r.id, r.type, r.reason, r.created_at, r.created_by, a.id AS a_id, a.title AS a_title, b.id AS b_id, b.title AS b_title
     FROM memory_relationships r JOIN memories a ON a.id = r.source_id JOIN memories b ON b.id = r.target_id
     WHERE r.user_id = ? AND r.type NOT IN ('BELONGS_TO') ORDER BY r.created_at DESC LIMIT 6`,
    [uid],
  );
  return {
    at: new Date().toISOString(),
    totals: {
      memories: n("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active'", [uid]),
      relationships: n("SELECT COUNT(*) FROM memory_relationships r JOIN memories a ON a.id = r.source_id JOIN memories b ON b.id = r.target_id WHERE r.user_id = ? AND a.status = 'active' AND b.status = 'active'", [uid]),
      projects: n("SELECT COUNT(*) FROM projects WHERE user_id = ? AND archived = 0", [uid]),
      active_projects: n("SELECT COUNT(*) FROM projects WHERE user_id = ? AND archived = 0 AND COALESCE(last_activity_at, updated_at) >= ?", [uid, week]),
      pending_reviews: Number(brain.inbox.counts().pending),
      deferred_reviews: Number(brain.inbox.counts().deferred),
      pinned: n("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active' AND pinned = 1", [uid]),
      preferences: n("SELECT COUNT(*) FROM memories m JOIN preference_meta p ON p.memory_id = m.id WHERE m.user_id = ? AND m.status = 'active' AND p.status = 'confirmed'", [uid]),
      research: n("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active' AND memory_type = 'research'", [uid]),
      lessons: n("SELECT COUNT(*) FROM memories WHERE user_id = ? AND status = 'active' AND memory_type = 'lesson'", [uid]),
    },
    today: {
      created: n("SELECT COUNT(*) FROM memories WHERE user_id = ? AND created_at >= ?", [uid, day]),
      updated: n("SELECT COUNT(*) FROM learning_events WHERE user_id = ? AND created_at >= ? AND kind IN ('updated','appended','merged','superseded')", [uid, day]),
      connections: n("SELECT COUNT(*) FROM memory_relationships WHERE user_id = ? AND created_at >= ?", [uid, day]),
    },
    recent: { created: recentCreated, updated: recentUpdated, connections: recentLinks },
    cortex: {
      readiness: brain.cortex.readiness(),
      state: rt?.state ?? "unloaded",
      model: rt?.model ?? brain.settings.get("cortex.modelId") ?? null,
      idle_unload_at: rt?.idleUnloadAt ?? null,
      queue: n("SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running') AND kind LIKE 'cortex_%'"),
    },
    mcp: {
      claude_connected: conn.claude_connected,
      live_sessions: (conn.live_sessions as Row[]).length,
      last_success: conn.last_success ? { at: (conn.last_success as Row).created_at, tool: (conn.last_success as Row).action, client: (conn.last_success as Row).source } : null,
      recent_errors: (conn.errors as Row[]).length,
    },
    state: {
      privacy: brain.privacyMode(),
      learning_paused: !!brain.settings.get("automation.paused"),
      profile: brain.settings.get("resources.profile"),
      defer_reason: brain.deferReason(),
      sleep: { mode: brain.settings.get("sleep.mode"), last_run: brain.settings.get("sleep.lastRun") || null },
      backup: { last_ok: brain.lastBackupAt(), last_error: brain.settings.get("backup.lastError") || null },
    },
    feed,
  };
}

/** Chronological learning history from the existing audit trail (learning_events + versions), with filters. */
export function timeline(brain: Brain, f: { project_id?: string; memory_type?: string; kinds?: string[]; since?: string; until?: string; source?: string; before_id?: number; limit?: number }): Row {
  const where = ["e.user_id = :uid"];
  const p: Record<string, unknown> = { uid: brain.store.userId };
  if (f.project_id) (where.push("e.project_id = :pid"), (p.pid = f.project_id));
  if (f.since) (where.push("e.created_at >= :since"), (p.since = f.since));
  if (f.until) (where.push("e.created_at <= :until"), (p.until = f.until));
  if (f.before_id) (where.push("e.id < :bid"), (p.bid = f.before_id));
  if (f.kinds?.length) where.push(`e.kind IN (${f.kinds.map((k) => `'${String(k).replace(/[^a-z_]/g, "")}'`).join(",")})`);
  if (f.memory_type) (where.push("m.memory_type = :mtype"), (p.mtype = f.memory_type));
  if (f.source) {
    // "Source" = who made the change (claude / moth / user / system) or where the memory came from.
    if (["claude", "moth", "user", "system"].includes(f.source)) (where.push("e.actor = :src"), (p.src = f.source));
    else (where.push("m.source = :src"), (p.src = f.source));
  }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const rows = brain.db.all<Row>(
    `SELECT e.*, m.title AS memory_title, m.memory_type, m.source AS memory_source, m.status AS memory_status, pr.name AS project_name
     FROM learning_events e LEFT JOIN memories m ON m.id = e.memory_id LEFT JOIN projects pr ON pr.id = e.project_id
     WHERE ${where.join(" AND ")} ORDER BY e.id DESC LIMIT ${limit}`,
    p,
  );
  return {
    items: rows.map((r) => ({ ...r, undo: safeJson(r.undo as string, null), reverted: !!r.reverted, label: FEED_KINDS[r.kind as string] ?? String(r.kind).replace(/_/g, " "), can_undo: !!r.undo && !r.reverted })),
    kinds: brain.db.all<Row>("SELECT kind, COUNT(*) AS n FROM learning_events WHERE user_id = ? GROUP BY kind ORDER BY n DESC", [brain.store.userId]).map((k) => ({ ...k, label: FEED_KINDS[k.kind as string] ?? String(k.kind).replace(/_/g, " ") })),
    sources: brain.db.all<Row>("SELECT DISTINCT source FROM memories WHERE user_id = ? ORDER BY source", [brain.store.userId]).map((r) => r.source),
  };
}
