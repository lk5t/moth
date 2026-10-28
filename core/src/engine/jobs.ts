// Durable job system (SQLite).
//
// Every background task in MOTH (Cortex learning, agents, scans, backups…) is a row in `jobs`, so it survives
// restarts and is visible to the user. Properties:
//  - Atomic claiming (UPDATE … RETURNING) — safe with several processes; only the desktop app runs jobs, one at a
//    time, so local inference can never run concurrently.
//  - Lifecycle: pending (queued) → running → done (completed) | failed | cancelled | interrupted | awaiting_approval.
//  - Bounded retries with exponential backoff; per-job time limits; cancellation (also across processes: a running
//    job notices within ~1 s when another process marks it cancelled).
//  - Safe recovery: after a crash or quit, a job is only re-queued if its kind is declared `resumable`
//    (re-running cannot duplicate writes). Otherwise it becomes "interrupted" and waits for the user.
//  - Checkpoints: `ctx.step(key, fn)` records completed steps in `job_steps`; a re-run skips them.
//  - Awaiting approval: a job that proposed consequential changes stays "awaiting_approval" until every review it
//    created (review_queue.job_id) has been decided.
//  - Audit: every state change is written to the change feed; failures keep the real error text.
import type { Database, Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import { safeJson } from "./store.ts";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "interrupted" | "awaiting_approval";

/** User-facing names for the internal statuses (the spec's Queued / Completed). */
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending: "Queued",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  awaiting_approval: "Awaiting approval",
};

export interface Job {
  id: number;
  kind: string;
  payload: any;
  attempts: number;
  max_attempts: number;
  owner: string;
  title: string;
  project_id: string | null;
  scope: string;
}

export interface JobContext {
  /** Runs `fn` once per job: if this step completed before (e.g. before a crash), its stored result is returned. */
  step<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
  /** Throws if the job was cancelled or timed out. */
  checkCancelled(): void;
}

export type JobHandler = (job: Job, signal: AbortSignal, ctx: JobContext) => Promise<unknown>;

export interface JobKindOptions {
  /** Re-running after an interruption cannot duplicate writes (idempotent, deduplicated or checkpointed). */
  resumable?: boolean;
  /** Default time limit for jobs of this kind. */
  timeoutMs?: number;
  /** Feature that owns this kind (shown in the UI and used for filtering). */
  owner?: string;
}

export interface EnqueueOptions {
  dedupe?: string;
  delayMs?: number;
  priority?: number;
  maxAttempts?: number;
  owner?: string;
  title?: string;
  projectId?: string | null;
  scope?: string;
  timeoutMs?: number;
}

const AWAIT = Symbol("awaiting_approval");
/** Return this from a handler when the job created reviews that the user must decide. */
export function awaitingApproval(result: unknown): unknown {
  return { [AWAIT]: true, result };
}

export class JobCancelled extends Error {
  constructor(msg = "Cancelled") {
    super(msg);
  }
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function pidAlive(lockedBy: string | null | undefined): boolean | null {
  const m = /^w(\d+)$/.exec(lockedBy ?? "");
  if (!m) return null;
  try {
    process.kill(Number(m[1]), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class JobQueue {
  private handlers = new Map<string, { h: JobHandler; o: JobKindOptions }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private current: { id: number; ctl: AbortController; why: string | null } | null = null;
  readonly workerId = `w${process.pid}`;
  onChange?: () => void;
  /** Optional SQL condition limiting which jobs may be claimed now (paused learning, Privacy Mode, busy PC). */
  heldSql?: () => string | null;

  constructor(private db: Database) {}

  register(kind: string, h: JobHandler, o: JobKindOptions = {}): void {
    this.handlers.set(kind, { h, o: { resumable: true, ...o } });
  }

  isRegistered(kind: string): boolean {
    return this.handlers.has(kind);
  }

  enqueue(kind: string, payload: unknown = {}, opts: EnqueueOptions = {}): number | null {
    const t = nowIso();
    const runAfter = new Date(Date.now() + (opts.delayMs ?? 0)).toISOString();
    const reg = this.handlers.get(kind)?.o;
    try {
      const r = this.db.run(
        `INSERT INTO jobs(kind, payload, dedupe_key, status, priority, attempts, max_attempts, run_after, created_at, updated_at, owner, title, project_id, scope, timeout_ms)
         VALUES (?,?,?,'pending',?,0,?,?,?,?,?,?,?,?,?)`,
        [kind, JSON.stringify(payload ?? {}), opts.dedupe ?? null, opts.priority ?? 5, opts.maxAttempts ?? 4, runAfter, t, t, opts.owner ?? reg?.owner ?? "system", (opts.title ?? "").slice(0, 200), opts.projectId ?? null, opts.scope ?? "system", opts.timeoutMs ?? null],
      );
      this.kick();
      return r.lastInsertRowid;
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) return null; // already queued
      throw e;
    }
  }

  get(id: number): Row | null {
    const r = this.db.get<Row>("SELECT * FROM jobs WHERE id = ?", [id]);
    if (!r) return null;
    const steps = this.db.all<Row>("SELECT step, at FROM job_steps WHERE job_id = ? ORDER BY at", [id]);
    return { ...this.decode(r), steps };
  }

  private decode(r: Row): Row {
    return { ...r, payload: safeJson(r.payload as string, {}), result: safeJson(r.result as string, null) };
  }

  cancel(id: number, reason = "Cancelled by you"): boolean {
    const t = nowIso();
    const r = this.db.run(
      "UPDATE jobs SET status = 'cancelled', cancel_reason = ?, finished_at = ?, updated_at = ?, locked_by = NULL WHERE id = ? AND status IN ('pending','running','awaiting_approval','interrupted')",
      [reason.slice(0, 300), t, t, id],
    );
    if (this.current?.id === id) {
      this.current.why = "cancelled";
      this.current.ctl.abort(new JobCancelled(reason));
    }
    return r.changes > 0;
  }

  retry(id: number): boolean {
    const t = nowIso();
    const r = this.db.run(
      "UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, last_error = NULL, cancel_reason = NULL, finished_at = NULL, started_at = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','cancelled','interrupted')",
      [t, t, id],
    );
    this.kick();
    return r.changes > 0;
  }

  list(limitOrFilter: number | { owner?: string; status?: string; limit?: number } = 100): Row[] {
    const f = typeof limitOrFilter === "number" ? { limit: limitOrFilter } : limitOrFilter;
    const where: string[] = [];
    const p: unknown[] = [];
    if (f.owner) (where.push("owner = ?"), p.push(f.owner));
    if (f.status) (where.push("status = ?"), p.push(f.status));
    return this.db
      .all<Row>(`SELECT * FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, [...p, Math.min(500, f.limit ?? 100)])
      .map((r) => this.decode(r));
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, interrupted: 0, awaiting_approval: 0 };
    for (const r of this.db.all<Row>("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")) out[r.status as string] = Number(r.n);
    return out;
  }

  /**
   * Recovers jobs left "running" by a process that is gone (crash, kill, power loss). Resumable kinds go back to
   * the queue; others become "interrupted" so nothing that may already have written data runs twice on its own.
   */
  recoverStale(maxAgeMs = 10 * 60_000): { requeued: number; interrupted: number } {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db.all<Row>("SELECT id, kind, locked_by, locked_at FROM jobs WHERE status = 'running'");
    let requeued = 0;
    let interrupted = 0;
    for (const r of rows) {
      const mine = r.locked_by === this.workerId && !this.current;
      const alive = pidAlive(r.locked_by as string);
      const stale = !r.locked_at || (r.locked_at as string) < cutoff;
      if (!(mine || alive === false || (alive === null && stale))) continue;
      if (this.release(Number(r.id), r.kind as string, "The job was interrupted (MOTH stopped while it was running)")) requeued++;
      else interrupted++;
    }
    return { requeued, interrupted };
  }

  /** Releases one running job: resumable → queued again (without using up a retry), otherwise interrupted. */
  private release(id: number, kind: string, why: string): boolean {
    const t = nowIso();
    if (this.handlers.get(kind)?.o.resumable) {
      this.db.run(
        "UPDATE jobs SET status = 'pending', attempts = MAX(0, attempts - 1), recoveries = recoveries + 1, locked_by = NULL, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        [`${why}; resumed automatically`, t, id],
      );
      return true;
    }
    this.db.run(
      "UPDATE jobs SET status = 'interrupted', locked_by = NULL, locked_at = NULL, last_error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      [`${why}. It was not restarted automatically because it may already have saved part of its work; you can retry it.`, t, t, id],
    );
    return false;
  }

  /** Jobs waiting for approval complete once none of their reviews is pending any more. */
  settleApprovals(): number {
    const t = nowIso();
    return this.db.run(
      `UPDATE jobs SET status = 'done', finished_at = ?, updated_at = ? WHERE status = 'awaiting_approval'
       AND NOT EXISTS (SELECT 1 FROM review_queue r WHERE r.job_id = jobs.id AND r.status = 'pending')`,
      [t, t],
    ).changes;
  }

  prune(keepDays = 7): void {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    this.db.tx(() => {
      this.db.run("DELETE FROM job_steps WHERE job_id IN (SELECT id FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?)", [cutoff]);
      this.db.run("DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?", [cutoff]);
    });
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
    if (this.current) {
      this.current.why = "shutdown";
      this.current.ctl.abort(new JobCancelled("MOTH is stopping"));
    }
  }

  /** Stops claiming new jobs and waits (up to timeoutMs) for the running one; then interrupts it. */
  async drain(timeoutMs = 8000): Promise<{ requeued: number; interrupted: number }> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const end = Date.now() + timeoutMs;
    while (this.running && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    if (this.current) {
      this.current.why = "shutdown";
      this.current.ctl.abort(new JobCancelled("MOTH is stopping"));
    }
    // Give the aborted job a moment to record its state before the database closes.
    const hard = Date.now() + 3000;
    while (this.running && Date.now() < hard) await new Promise((r) => setTimeout(r, 50));
    let requeued = 0;
    let interrupted = 0;
    for (const r of this.db.all<Row>("SELECT id, kind FROM jobs WHERE status = 'running' AND locked_by = ?", [this.workerId])) {
      if (this.release(Number(r.id), r.kind as string, "MOTH was closed while this job was running")) requeued++;
      else interrupted++;
    }
    return { requeued, interrupted };
  }

  isRunning(): boolean {
    return this.running;
  }

  currentJobId(): number | null {
    return this.current?.id ?? null;
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
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_at = ?, updated_at = ?, started_at = COALESCE(started_at, ?)
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_after <= ? AND kind IN (${kinds.map(() => "?").join(",")}) ${held ? `AND ${held}` : ""} ORDER BY priority ASC, id ASC LIMIT 1)
       RETURNING *`,
      [this.workerId, t, t, t, t, ...kinds],
    );
  }

  private contextFor(job: Job, signal: AbortSignal): JobContext {
    const checkCancelled = () => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new JobCancelled();
    };
    return {
      checkCancelled,
      step: async <T>(key: string, fn: () => Promise<T> | T): Promise<T> => {
        const done = this.db.get<Row>("SELECT result FROM job_steps WHERE job_id = ? AND step = ?", [job.id, key]);
        if (done) return safeJson(done.result as string, null) as T;
        checkCancelled();
        const out = await fn();
        this.db.run("INSERT OR IGNORE INTO job_steps(job_id, step, result, at) VALUES (?,?,?,?)", [job.id, key, JSON.stringify(out ?? null).slice(0, 20000), nowIso()]);
        return out;
      },
    };
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
        const job: Job = {
          id: Number(row.id),
          kind: row.kind as string,
          payload: safeJson(row.payload as string, {}),
          attempts: Number(row.attempts),
          max_attempts: Number(row.max_attempts),
          owner: row.owner as string,
          title: row.title as string,
          project_id: (row.project_id as string) ?? null,
          scope: row.scope as string,
        };
        const reg = this.handlers.get(job.kind)!;
        const ctl = new AbortController();
        const cur = { id: job.id, ctl, why: null as string | null };
        this.current = cur;
        const timeoutMs = Number(row.timeout_ms ?? 0) || reg.o.timeoutMs || DEFAULT_TIMEOUT_MS;
        const timeout = setTimeout(() => {
          cur.why = "timeout";
          ctl.abort(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        // Cancellation requested from another process (the MCP server or a second window) is noticed here.
        const watch = setInterval(() => {
          try {
            const st = this.db.value<string>("SELECT status FROM jobs WHERE id = ?", [job.id]);
            if (st === "cancelled" && !ctl.signal.aborted) {
              cur.why = "cancelled";
              ctl.abort(new JobCancelled("Cancelled"));
            }
          } catch {
            /* database closing */
          }
        }, 1000);
        try {
          const out = await reg.h(job, ctl.signal, this.contextFor(job, ctl.signal));
          const st = this.db.value<string>("SELECT status FROM jobs WHERE id = ?", [job.id]);
          if (st === "running") {
            const t = nowIso();
            const awaiting = !!out && typeof out === "object" && (out as any)[AWAIT];
            const result = awaiting ? (out as any).result : out;
            this.db.run(
              "UPDATE jobs SET status = ?, result = ?, last_error = NULL, finished_at = CASE WHEN ? THEN NULL ELSE ? END, locked_by = NULL, updated_at = ? WHERE id = ?",
              [awaiting ? "awaiting_approval" : "done", JSON.stringify(result ?? null).slice(0, 8000), awaiting ? 1 : 0, t, t, job.id],
            );
            if (awaiting) this.settleApprovals();
          }
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          const st = this.db.value<string>("SELECT status FROM jobs WHERE id = ?", [job.id]);
          if (st === "cancelled") continue;
          if (cur.why === "shutdown") {
            // Leave it "running"; drain() releases it with the resume policy (requeue or interrupted).
            continue;
          }
          const t = nowIso();
          // A permission refusal won't fix itself by retrying: fail at once with the reason.
          const permanent = (e as { code?: string })?.code === "permission_denied";
          if (job.attempts >= job.max_attempts || e instanceof JobCancelled || permanent) {
            this.db.run("UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, locked_by = NULL, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), t, t, job.id]);
          } else {
            const backoff = Math.min(30 * 60_000, 15_000 * 2 ** (job.attempts - 1));
            this.db.run("UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?, locked_by = NULL, updated_at = ? WHERE id = ?", [msg.slice(0, 2000), new Date(Date.now() + backoff).toISOString(), t, job.id]);
          }
        } finally {
          clearTimeout(timeout);
          clearInterval(watch);
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

  /** Waits until a job reaches a final state (or the timeout). */
  async waitFor(id: number, timeoutMs: number): Promise<Row | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = this.db.get<Row>("SELECT * FROM jobs WHERE id = ?", [id]);
      if (!r) return null;
      if (!["pending", "running"].includes(r.status as string)) return this.decode(r);
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  }
}
