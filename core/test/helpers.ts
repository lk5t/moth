import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Brain } from "../src/engine/brain.ts";

process.env.MOTH_LOG_STDERR = "0";

export function tmpDir(name = "moth-test"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

export function openBrain(dir = tmpDir()): Brain {
  return Brain.open({ dataDir: dir, role: "test" });
}

export const user = { actor: "user" as const, reason: "test" };
export const claude = { actor: "claude" as const, reason: "test" };
