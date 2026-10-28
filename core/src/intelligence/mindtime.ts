// The Mind 3.0 — Neural Pathways and Knowledge Evolution, from stored records only.
//
// Pathways: the shortest chain of real, stored relationships between two memories (breadth-first search over the
// relationship table). If there's none within the search depth, that's what is reported: no invented links.
//
// Evolution: the graph as it was at a moment in the past, rebuilt from persisted history:
//  - a memory appears from its created_at; its title and status at that moment come from memory_versions
//    (merged / archived / superseded memories disappear when their version history says so);
//  - a relationship appears from its created_at, and relationships removed later are restored from the "unlinked"
//    events (which keep the removed relationship), so they show until the moment they were removed.
// Permanently deleted memories are gone by design (their content isn't kept), so they can't appear in the past.
import type { Row } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { safeJson } from "../engine/store.ts";
import { truncate } from "../engine/text.ts";
import { MothError } from "../engine/types.ts";

export class MindTime {
  constructor(private brain: Brain) {}

  /** Shortest path of stored relationships between two memories (active ones), up to `maxDepth` hops. */
  path(fromId: string, toId: string, maxDepth = 6): Row {
    const s = this.brain.store;
    const from = s.requireMemory(fromId);
    const to = s.requireMemory(toId);
    if (from.id === to.id) throw new MothError("invalid_input", "Pick two different memories");
    const db = this.brain.db;
    const prev = new Map<string, { node: string; rel: Row }>();
    const seen = new Set([from.id]);
    let frontier = [from.id];
    let found = false;
    let explored = 0;
    for (let d = 0; d < Math.min(10, maxDepth) && frontier.length && !found; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const rels = db.all<Row>(
          `SELECT r.* FROM memory_relationships r JOIN memories a ON a.id = r.source_id JOIN memories b ON b.id = r.target_id
           WHERE (r.source_id = ? OR r.target_id = ?) AND a.status = 'active' AND b.status = 'active' AND r.user_id = ?`,
          [cur, cur, s.userId],
        );
        explored += rels.length;
        for (const r of rels) {
          const other = (r.source_id === cur ? r.target_id : r.source_id) as string;
          if (seen.has(other)) continue;
          seen.add(other);
          prev.set(other, { node: cur, rel: r });
          if (other === to.id) {
            found = true;
            break;
          }
          next.push(other);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (!found) {
      return { found: false, from: { id: from.id, title: from.title }, to: { id: to.id, title: to.title }, searched_depth: maxDepth, relationships_checked: explored, message: `No chain of stored connections links these two memories within ${maxDepth} steps. MOTH doesn't invent one.` };
    }
    const chain: { node: string; rel: Row }[] = [];
    for (let cur = to.id; cur !== from.id; ) {
      const p = prev.get(cur)!;
      chain.unshift({ node: cur, rel: p.rel });
      cur = p.node;
    }
    const ids = [from.id, ...chain.map((c) => c.node)];
    const mems = new Map(s.getMany(ids).map((m) => [m.id, m]));
    const steps = chain.map((c, i) => {
      const a = ids[i];
      const b = c.node;
      const forward = c.rel.source_id === a;
      return {
        from: { id: a, title: mems.get(a)?.title },
        to: { id: b, title: mems.get(b)?.title },
        relationship: { id: c.rel.id, type: c.rel.type, reason: c.rel.reason, created_by: c.rel.created_by, created_at: c.rel.created_at, strength: c.rel.strength },
        direction: forward ? "forward" : "backward",
        explanation: `${truncate(String(mems.get(forward ? a : b)?.title ?? ""), 60)} —${String(c.rel.type).toLowerCase().replace(/_/g, " ")}→ ${truncate(String(mems.get(forward ? b : a)?.title ?? ""), 60)}${c.rel.reason ? ` (“${truncate(String(c.rel.reason), 140)}”)` : ""}`,
      };
    });
    return { found: true, hops: steps.length, node_ids: ids, edge_ids: chain.map((c) => c.rel.id), steps, relationships_checked: explored };
  }

  /** Every moment something changed in the graph (memory created / status changed, connection added / removed). */
  moments(): Row {
    const db = this.brain.db;
    const uid = this.brain.store.userId;
    const rows = db.all<Row>(
      `SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM (
         SELECT created_at AS at FROM memories WHERE user_id = :u AND is_demo = 0
         UNION ALL SELECT v.created_at FROM memory_versions v JOIN memories m ON m.id = v.memory_id WHERE m.user_id = :u AND v.version > 1
         UNION ALL SELECT created_at FROM memory_relationships WHERE user_id = :u
         UNION ALL SELECT created_at FROM learning_events WHERE user_id = :u AND kind = 'unlinked'
         UNION ALL SELECT json_extract(undo, '$.rel.created_at') FROM learning_events WHERE user_id = :u AND kind = 'unlinked' AND json_extract(undo, '$.rel.created_at') IS NOT NULL
       ) GROUP BY day ORDER BY day`,
      { u: uid },
    );
    const first = db.value<string>("SELECT MIN(created_at) FROM memories WHERE user_id = ? AND is_demo = 0", [uid]);
    return { days: rows, first: first ?? null, last: new Date().toISOString() };
  }

  /** The graph as it was at `at` (ISO time), rebuilt from stored history. */
  graphAt(at: string, f: { projectIds?: string[] } = {}): Row {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) throw new MothError("invalid_input", "Give a valid date and time");
    const iso = new Date(t).toISOString();
    const db = this.brain.db;
    const uid = this.brain.store.userId;
    const mems = db.all<Row>(
      `SELECT m.id, m.title, m.category, m.project_id, m.importance, m.created_at, m.status AS status_now, m.memory_type, m.pinned AS starred, np.x, np.y,
              (SELECT v.status FROM memory_versions v WHERE v.memory_id = m.id AND v.created_at <= :t ORDER BY v.version DESC LIMIT 1) AS status_then,
              (SELECT v.title FROM memory_versions v WHERE v.memory_id = m.id AND v.created_at <= :t ORDER BY v.version DESC LIMIT 1) AS title_then,
              (SELECT v.version FROM memory_versions v WHERE v.memory_id = m.id AND v.created_at <= :t ORDER BY v.version DESC LIMIT 1) AS version_then
       FROM memories m LEFT JOIN node_positions np ON np.memory_id = m.id
       WHERE m.user_id = :u AND m.is_demo = 0 AND m.created_at <= :t`,
      { t: iso, u: uid },
    );
    const nodes = mems
      .filter((m) => (m.status_then ?? m.status_now) === "active" || (!m.status_then && m.status_now === "active"))
      .filter((m) => !f.projectIds?.length || f.projectIds.includes(m.project_id as string))
      .map((m) => ({ id: m.id, title: (m.title_then as string) ?? m.title, category: m.category, project_id: m.project_id, importance: m.importance, x: m.x, y: m.y, starred: !!m.starred, memory_type: m.memory_type, degree: 0, version_then: m.version_then ?? 1, created_at: m.created_at }));
    const ids = new Set(nodes.map((n) => n.id as string));
    const current = db.all<Row>("SELECT id, source_id, target_id, type, strength, created_at FROM memory_relationships WHERE user_id = ? AND created_at <= ?", [uid, iso]);
    const removed = db
      .all<Row>("SELECT undo, created_at FROM learning_events WHERE user_id = ? AND kind = 'unlinked' AND created_at > ?", [uid, iso])
      .map((e) => ({ rel: safeJson<Row>(e.undo as string, {})?.rel as Row | undefined, removed_at: e.created_at }))
      .filter((x) => x.rel && String(x.rel.created_at ?? "") <= iso)
      .map((x) => ({ id: x.rel!.id, source_id: x.rel!.source_id, target_id: x.rel!.target_id, type: x.rel!.type, strength: x.rel!.strength ?? 0.5, created_at: x.rel!.created_at, removed_at: x.removed_at }));
    const seen = new Set<string>();
    const links = [...current, ...removed].filter((l) => ids.has(l.source_id as string) && ids.has(l.target_id as string) && !seen.has(l.id as string) && seen.add(l.id as string));
    const deg = new Map<string, number>();
    for (const l of links) for (const k of [l.source_id, l.target_id] as string[]) deg.set(k, (deg.get(k) ?? 0) + 1);
    for (const n of nodes) n.degree = deg.get(n.id as string) ?? 0;
    const projects = this.brain.store.listProjects(true).filter((p) => p.created_at <= iso).map((p) => ({ id: p.id, name: p.name }));
    return { at: iso, nodes, links, projects, restored_links: removed.filter((r) => links.some((l) => l.id === r.id)).length, note: "Rebuilt from version history and connection events. Permanently deleted memories can't be shown." };
  }
}
