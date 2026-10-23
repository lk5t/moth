// SQLite access layer built on Node's built-in node:sqlite (SQLite 3.4x with FTS5).
// No native modules: the same code runs in tests, in the desktop sidecar and in the MCP process.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations.ts";

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | Uint8Array;
export type Params = Record<string, Param> | Param[];

function normalize(p: unknown): Param {
  if (p === undefined) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  if (p instanceof Float32Array) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  if (p !== null && typeof p === "object" && !(p instanceof Uint8Array)) return JSON.stringify(p);
  return p as Param;
}

function normalizeParams(params?: unknown): Param[] | Record<string, Param> {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(normalize);
  const out: Record<string, Param> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) out[k] = normalize(v);
  return out;
}

export class Database {
  readonly file: string;
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    this.file = file;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file, { readOnly: opts.readOnly ?? false });
    this.raw.exec("PRAGMA busy_timeout = 8000");
    if (file !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA temp_store = MEMORY");
    if (!opts.readOnly) runMigrations(this);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, params?: unknown): { changes: number; lastInsertRowid: number } {
    const p = normalizeParams(params);
    const r = Array.isArray(p) ? this.stmt(sql).run(...p) : this.stmt(sql).run(p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params?: unknown): T | undefined {
    const p = normalizeParams(params);
    return (Array.isArray(p) ? this.stmt(sql).get(...p) : this.stmt(sql).get(p)) as T | undefined;
  }

  all<T = Row>(sql: string, params?: unknown): T[] {
    const p = normalizeParams(params);
    return (Array.isArray(p) ? this.stmt(sql).all(...p) : this.stmt(sql).all(p)) as T[];
  }

  value<T = unknown>(sql: string, params?: unknown): T | undefined {
    const row = this.get(sql, params);
    if (!row) return undefined;
    return Object.values(row)[0] as T;
  }

  /** Runs fn inside a transaction (nested calls use savepoints). Rolls back on throw. */
  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.depth--;
      if (this.depth === 0) this.raw.exec("ROLLBACK");
      else this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}

/** Returns "ok" or the first problem SQLite reports. */
export function quickCheck(file: string): string {
  if (!fs.existsSync(file)) return "ok";
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const r = db.prepare("PRAGMA quick_check").get() as Row | undefined;
      const v = r ? String(Object.values(r)[0]) : "ok";
      return v;
    } finally {
      db.close();
    }
  } catch (e) {
    return (e as Error).message || "unreadable";
  }
}

export const nowIso = (): string => new Date().toISOString();
