// Persistent job queue (SQLite). Atomic claiming makes it safe with several processes;
// retries use exponential backoff; dedupe keys make enqueueing idempotent; jobs can be cancelled.
import type { Database, Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import { safeJson } from "./store.ts";

export interface Job {
  id: number;
  kind: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<unknown>;

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private current: { id: number; ctl: AbortController } | null = null;
  readonly workerId = `w${process.pid}`;
  onChange?: () => void;
  /** Optional SQL condition limiting which jobs may be claimed now (paused learning, Privacy Mode, busy PC). */
  heldSql?: () => string | null;

  constructor(private db: Database) {}

  register(kind: string, h: JobHandler): void {
    this.handlers.set(kind, h);
  }

  enqueue(kind: string, payload: unknown = {}, opts: { dedupe?: string; delayMs?: number; priority?: number; maxAttempts?: number } = {}): number | null {
    const t = nowIso();
    const runAfter = new Date(Date.now() + (opts.delayMs ?? 0)).toISOString();
    try {
      const r = this.db.run(
        "INSERT INTO jobs(kind, payload, dedupe_key, status, priority, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?,?,?,'pending',?,0,?,?,?,?)",
        [kind, JSON.stringify(payload ?? {}), opts.dedupe ?? null, opts.priority ?? 5, opts.maxAttempts ?? 4, runAfter, t, t],
      );
      this.kick();
      return r.lastInsertRowid;
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) return null; // already queued
      throw e;
    }
  }

  cancel(id: number): boolean {
    const r = this.db.run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending','running')", [nowIso(), id]);
    if (this.current?.id === id) this.current.ctl.abort();
    return r.changes > 0;
  }

  retry(id: number): boolean {
    const r = this.db.run("UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','cancelled')", [nowIso(), nowIso(), id]);
    this.kick();
    return r.changes > 0;
  }

  list(limit = 100): Row[] {
    return this.db.all("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", [limit]).map((r) => ({ ...r, payload: safeJson(r.payload as string, {}), result: safeJson(r.result as string, null) }));
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of this.db.all<Row>("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")) out[r.status as string] = Number(r.n);
    return out;
  }

  /** Releases jobs left "running" by a process that crashed. */
  recoverStale(maxAgeMs = 10 * 60_000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.run("UPDATE jobs SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = ? WHERE status = 'running' AND (locked_at IS NULL OR locked_at < ? OR locked_by = ?)", [nowIso(), cutoff, this.workerId]).changes;
  }

  prune(keepDays = 7): void {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    this.db.run("DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?", [cutoff]);
  }

  start(): void {
    this.stopped = false;
    this.recoverStale();
    this.kick(200);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current?.ctl.abort();
  }

  /** Stops claiming new jobs and waits (up to timeoutMs) for the running one; then aborts it. */
  async drain(timeoutMs = 8000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const end = Date.now() + timeoutMs;
    while (this.running && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    this.current?.ctl.abort();
    // Give the aborted job a moment to record its state before the database closes.
    const hard = Date.now() + 3000;
    while (this.running && Date.now() < hard) await new Promise((r) => setTimeout(r, 50));
  }

  isRunning(): boolean {
    return this.running;
  }

  kick(delay = 50): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private claim(): Row | undefined {
    const t = nowIso();
    const kinds = [...this.handlers.keys()];
    if (!kinds.length) return undefined;
    let held: string | null = null;
    try {
      held = this.heldSql?.() ?? null;
    } catch {
      held = null;
    }
    return this.db.get<Row>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_at = ?, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_after <= ? AND kind IN (${kinds.map(() => "?").join(",")}) ${held ? `AND ${held}` : ""} ORDER BY priority ASC, id ASC LIMIT 1)
       RETURNING *`,
      [this.workerId, t, t, t, ...kinds],
    );
  }

  /** Processes ready jobs one at a time (resource limit), then sleeps until the next is due. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let n = 0; n < 25; n++) {
        if (this.stopped && n > 0) break;
        const row = this.claim();
        if (!row) break;
        const job: Job = { id: Number(row.id), kind: row.kind as string, payload: safeJson(row.payload as string, {}), attempts: Number(row.attempts), max_attempts: Number(row.max_attempts) };
        const handler = this.handlers.get(job.kind)!;
        const ctl = new AbortController();
        this.current = { id: job.id, ctl };
        try {
          const result = await handler(job, ctl.signal);
          const st = this.db.value<string>("SELECT status FROM jobs WHERE id = ?", [job.id]);
          if (st !== "cancelled") this.db.run("UPDATE jobs SET status = 'done', result = ?, last_error = NULL, updated_at = ? WHERE id = ?", [JSON.stringify(result ?? null).slice(0, 4000), nowIso(), job.id]);
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const st = this.db.value<string>("SELECT status FROM jobs WHERE id = ?", [job.id]);
          if (st === "cancelled") continue;
          if (job.attempts >= job.max_attempts) {
            this.db.run("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 1000), nowIso(), job.id]);
          } else {
            const backoff = Math.min(30 * 60_000, 15_000 * 2 ** (job.attempts - 1));
            this.db.run("UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?", [msg.slice(0, 1000), new Date(Date.now() + backoff).toISOString(), nowIso(), job.id]);
          }
        } finally {
          this.current = null;
        }
        this.onChange?.();
        if (this.stopped) break;
        await new Promise((r) => setImmediate(r)); // keep the event loop (and API) responsive
      }
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    let held: string | null = null;
    try {
      held = this.heldSql?.() ?? null;
    } catch {
      held = null;
    }
    const next = this.db.value<string>(`SELECT MIN(run_after) FROM jobs WHERE status = 'pending' ${held ? `AND ${held}` : ""}`);
    const wait = next ? Math.max(200, Math.min(60_000, Date.parse(next) - Date.now())) : 60_000;
    this.kick(wait);
  }
}
