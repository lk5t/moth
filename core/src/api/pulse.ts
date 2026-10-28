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

/**
 * Pulse 2.0: the intelligence side of the Overview. Counts are plain SQL over stored records; feeds list stored
 * findings, jobs and handoffs. Nothing is estimated and nothing is shown that isn't in the database.
 */
export function intelligencePulse(brain: Brain): Row {
  const db = brain.db;
  const uid = brain.store.userId;
  const n = (sql: string, p: unknown[] = []) => Number(db.value(sql, p) ?? 0);
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const HIGH = 0.75;
  const active = "status IN ('new','viewed')";
  const openItems = (kind: string) => n(`SELECT COUNT(*) FROM project_items i JOIN projects p ON p.id = i.project_id WHERE i.user_id = ? AND i.kind = ? AND i.status = 'open' AND p.archived = 0`, [uid, kind]);
  const counts = {
    active_projects: n("SELECT COUNT(*) FROM projects WHERE user_id = ? AND archived = 0 AND COALESCE(last_activity_at, updated_at) >= ?", [uid, week]),
    projects: n("SELECT COUNT(*) FROM projects WHERE user_id = ? AND archived = 0", [uid]),
    unresolved_decisions: openItems("unresolved_decision"),
    open_blockers: openItems("blocker"),
    pending_reviews: Number(brain.inbox.counts().pending),
    high_confidence_discoveries: n(`SELECT COUNT(*) FROM findings WHERE user_id = ? AND kind = 'discovery' AND ${active} AND confidence >= ?`, [uid, HIGH]),
    discoveries: n(`SELECT COUNT(*) FROM findings WHERE user_id = ? AND kind = 'discovery' AND ${active}`, [uid]),
    awareness_items: n(`SELECT COUNT(*) FROM findings WHERE user_id = ? AND kind = 'awareness' AND ${active}`, [uid]),
    health_confirmed: n(`SELECT COUNT(*) FROM findings WHERE user_id = ? AND kind = 'health' AND ${active} AND evidence_status = 'confirmed'`, [uid]),
    health_possible: n(`SELECT COUNT(*) FROM findings WHERE user_id = ? AND kind = 'health' AND ${active} AND evidence_status = 'possible'`, [uid]),
    agent_approvals: n("SELECT COUNT(*) FROM review_queue r JOIN jobs j ON j.id = r.job_id WHERE r.status = 'pending' AND j.owner LIKE 'agent:%'"),
  };
  const sev: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
  const awareness = brain.findings
    .list({ kind: "awareness", status: "active", limit: 200 })
    .sort((a, b) => (sev[a.severity as string] ?? 4) - (sev[b.severity as string] ?? 4) || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 6);
  const discoveries = brain.findings
    .list({ kind: "discovery", status: "active", limit: 200 })
    .filter((f) => Number(f.confidence ?? 0) >= HIGH)
    .sort((a, b) => Number(b.confidence) - Number(a.confidence))
    .slice(0, 4);
  const agentJobs = brain.jobs
    .list({ limit: 40 })
    .filter((j) => String(j.owner).startsWith("agent:"))
    .slice(0, 6)
    .map((j) => ({ id: j.id, title: j.title, owner: j.owner, status: j.status, created_at: j.created_at, finished_at: j.finished_at, summary: (j.result as Row | null)?.summary ?? null, error: j.status === "failed" || j.status === "interrupted" ? j.last_error : null }));
  const projects = db.all<Row>("SELECT id, name, COALESCE(last_activity_at, updated_at) AS at FROM projects WHERE user_id = ? AND archived = 0 ORDER BY at DESC LIMIT 4", [uid]);
  const continuity = projects.map((p) => {
    let next: Row | null = null;
    let handoff: Row | null = null;
    try {
      const r = brain.projectIntel.resume(p.id as string);
      next = (r.next_step as Row | null) ?? null;
      handoff = (r.latest_handoff as Row | null) ?? null;
    } catch {
      /* project removed meanwhile */
    }
    return {
      project_id: p.id, name: p.name, last_activity_at: p.at,
      next_step: next ? { text: next.text, why: next.why } : null,
      handoff: handoff ? { id: handoff.id, summary: handoff.summary, client: handoff.client, updated_at: handoff.updated_at } : null,
      unresolved: n("SELECT COUNT(*) FROM project_items WHERE project_id = ? AND kind = 'unresolved_decision' AND status = 'open'", [p.id]),
      blockers: n("SELECT COUNT(*) FROM project_items WHERE project_id = ? AND kind = 'blocker' AND status = 'open'", [p.id]),
    };
  });
  const repairs7d = n("SELECT COUNT(*) FROM activity_logs WHERE kind = 'health_repair' AND created_at >= ?", [week]);
  const health = { ...brain.health.summary(), confirmed: counts.health_confirmed, possible: counts.health_possible, repairs_7d: repairs7d };
  return { at: new Date().toISOString(), counts, feeds: { awareness, discoveries, agents: agentJobs, continuity, health: { last_scan: (health as Row).last_scan, confirmed: health.confirmed, possible: health.possible, repairs_7d: repairs7d, top: ((health as Row).checks as Row[]).filter((c) => Number(c.confirmed) + Number(c.possible) > 0).slice(0, 4) } } };
}
