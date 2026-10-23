// File logger with size-based rotation. Never writes to stdout (stdout carries the MCP protocol).
import fs from "node:fs";
import path from "node:path";

let file: string | null = null;
const MAX = 5 * 1024 * 1024;

export function initLogger(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `${name}.log`);
}

function rotate(): void {
  if (!file) return;
  try {
    const st = fs.statSync(file);
    if (st.size < MAX) return;
    for (let i = 2; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* missing file is fine */
  }
}

function write(level: string, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level} ${msg}${extra !== undefined ? " " + safe(extra) : ""}\n`;
  if (process.env.MOTH_LOG_STDERR !== "0") process.stderr.write(line);
  if (!file) return;
  try {
    rotate();
    fs.appendFileSync(file, line);
  } catch {
    /* logging must never crash the app */
  }
}

function safe(x: unknown): string {
  try {
    if (x instanceof Error) return `${x.message}\n${x.stack ?? ""}`;
    return JSON.stringify(x).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
  } catch {
    return String(x);
  }
}

export const log = {
  info: (m: string, x?: unknown) => write("INFO ", m, x),
  warn: (m: string, x?: unknown) => write("WARN ", m, x),
  error: (m: string, x?: unknown) => write("ERROR", m, x),
};
