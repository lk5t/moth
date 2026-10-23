import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import sea from "node:sea";

export function dataDir(): string {
  if (process.env.MOTH_DATA_DIR) return path.resolve(process.env.MOTH_DATA_DIR);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "MOTH");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "MOTH");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "moth");
}

export function paths(base = dataDir()) {
  const p = {
    base,
    db: path.join(base, "moth.db"),
    backups: path.join(base, "backups"),
    exports: path.join(base, "exports"),
    logs: path.join(base, "logs"),
    pendingRestore: path.join(base, "restore-pending.db"),
    endpoint: path.join(base, "core-endpoint.json"),
  };
  for (const d of [p.base, p.backups, p.exports, p.logs]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export type MothPaths = ReturnType<typeof paths>;

/** The command Claude clients should run to start MOTH's MCP server. */
export function selfCommand(): { command: string; args: string[] } {
  // In the packaged app this process is a single executable (Node SEA): execPath is moth-core.exe.
  let isSea = false;
  try {
    isSea = sea.isSea();
  } catch {
    isSea = false;
  }
  if (isSea || !/node(\.exe)?$/i.test(path.basename(process.execPath))) return { command: process.execPath, args: [] };
  const script = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve("src/index.ts");
  return { command: process.execPath, args: [script] };
}
