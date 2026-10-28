// A real MOTH MCP server process spoken to over stdio with raw JSON-RPC, exactly like a client.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { after } from "node:test";

const ENTRY = path.resolve(import.meta.dirname, "../../src/index.ts");

export class McpClient {
  private buf = "";
  private waiters = new Map<number, (m: any) => void>();
  private next = 1;
  constructor(public proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.waiters.has(msg.id)) {
          this.waiters.get(msg.id)!(msg);
          this.waiters.delete(msg.id);
        }
      }
    });
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
      this.waiters.set(id, (m) => (clearTimeout(t), resolve(m)));
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string, params: unknown = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async call(name: string, args: unknown): Promise<{ data: any; isError: boolean; raw: any }> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) return { data: r.error, isError: true, raw: r };
    const text = r.result.content?.[0]?.text ?? "";
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { data, isError: !!r.result.isError, raw: r };
  }
  /** Graceful close (like a client disconnecting): end stdin and wait for the server to exit. */
  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise<void>((r) => this.proc.once("exit", () => r()));
    this.proc.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (this.proc.exitCode === null) this.proc.kill();
  }
}

const live = new Set<McpClient>();
after(async () => {
  for (const c of live) await c.close();
});

export async function startClient(dataDir: string, name = "claude-test-client"): Promise<McpClient> {
  const proc = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", ENTRY, "mcp"], {
    env: { ...process.env, MOTH_DATA_DIR: dataDir, MOTH_LOG_STDERR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const c = new McpClient(proc);
  live.add(c);
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "9.9" } });
  assert.equal(init.result.serverInfo.name, "moth");
  assert.match(init.result.instructions, /moth_begin_task/);
  c.notify("notifications/initialized");
  return c;
}

