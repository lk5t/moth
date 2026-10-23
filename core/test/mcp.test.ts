// End-to-end: real MCP server process over stdio, spoken to with raw JSON-RPC exactly like a client.
// Runs against the official SDK in CI (and an offline stand-in locally).
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { after, test } from "node:test";
import { Brain } from "../src/engine/brain.ts";
import { tmpDir } from "./helpers.ts";

const ENTRY = path.resolve(import.meta.dirname, "../src/index.ts");

class McpClient {
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

async function startClient(dataDir: string): Promise<McpClient> {
  const proc = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", ENTRY, "mcp"], {
    env: { ...process.env, MOTH_DATA_DIR: dataDir, MOTH_LOG_STDERR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const c = new McpClient(proc);
  live.add(c);
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-test-client", version: "9.9" } });
  assert.equal(init.result.serverInfo.name, "moth");
  assert.match(init.result.instructions, /moth_begin_task/);
  c.notify("notifications/initialized");
  return c;
}

test("MCP: lists all 19 tools with schemas", async () => {
  const c = await startClient(tmpDir());
  const r = await c.request("tools/list");
  const names = r.result.tools.map((t: any) => t.name).sort();
  assert.equal(names.length, 19);
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 20);
  }
  const commit = r.result.tools.find((t: any) => t.name === "moth_commit_learning");
  assert.ok(commit.inputSchema.required.includes("summary"));
  await c.close();
});

test("MCP: full learning workflow survives a restart (acceptance scenario)", async () => {
  const dir = tmpDir();
  // Weeks of prior work on a Roblox game.
  const seed = Brain.open({ dataDir: dir, role: "test" });
  seed.loadDemo();
  seed.close();

  let c = await startClient(dir);
  const begin = await c.call("moth_begin_task", { task: "Continue my Roblox game. Fix the inventory system and remember what we changed." });
  assert.equal(begin.isError, false);
  assert.equal(begin.data.project.name, "DEMO · Skyforge Inventory");
  const titles = [...begin.data.sections.decisions, ...begin.data.sections.open_tasks, ...begin.data.sections.errors_and_solutions, ...begin.data.sections.relevant].map((i: any) => i.title);
  assert.ok(titles.includes("Inventory system design"));
  const taskId = begin.data.task_id;

  const invId = begin.data.sections.decisions.find((i: any) => i.title === "Inventory system design").id;
  const commit = await c.call("moth_commit_learning", {
    task_id: taskId,
    summary: "Fixed inventory desync: client snapshot was stale after crafting. InventoryService now fires InventoryChanged after every mutation.",
    errors: [{ problem: "Inventory UI showed crafted items late (stale snapshot after crafting)", cause: "Crafting changed server data without notifying clients", fix: "Fire RemoteEvent InventoryChanged from InventoryService after AddItem/RemoveItems/MoveItem", files: ["ServerScriptService/InventoryService.lua"] }],
    items: [{ content: "InventoryService fires the InventoryChanged RemoteEvent after every mutation; the UI re-renders from that event.", category: "decision", relates_to: [invId] }],
    files_changed: ["ServerScriptService/InventoryService.lua", "StarterGui/InventoryUI/Controller.client.lua"],
    unfinished: ["Throttle InventoryChanged when many items change at once"],
    project_status: "Inventory sync fixed",
  });
  assert.equal(commit.isError, false, JSON.stringify(commit.data));
  assert.ok(commit.data.actions.length >= 3);
  const ended = await c.call("moth_end_task", { task_id: taskId });
  assert.equal(ended.data.learning_committed, true);
  await c.close();

  // "Application restarts" → knowledge remains available to a new session.
  c = await startClient(dir);
  const again = await c.call("moth_search_memories", { query: "why did the inventory UI show crafted items late?" });
  assert.ok(again.data.results.length > 0);
  assert.ok(again.data.results.slice(0, 3).some((r: any) => /stale snapshot|InventoryChanged/i.test(r.title + r.excerpt)), JSON.stringify(again.data.results.slice(0, 3)));
  const pctx = await c.call("moth_get_project_context", { project: "DEMO · Skyforge Inventory" });
  assert.equal(pctx.data.project.status, "Inventory sync fixed");
  assert.ok(pctx.data.open_tasks.some((t: any) => /Throttle InventoryChanged/.test(t.title)));
  assert.match(pctx.data.progress_log, /Fixed inventory desync/);
  const fix = pctx.data.solutions[0];
  const related = await c.call("moth_read_related", { id: fix.id });
  assert.ok(related.data.relationships.some((r: any) => r.type === "SOLVES"));
  const status = await c.call("moth_get_brain_status", {});
  assert.ok(status.data.memories > 10);
  await c.close();

  // Activity + MCP session were recorded for the Connections page.
  const b = Brain.open({ dataDir: dir, role: "test" });
  const calls = b.db.all("SELECT kind, source, action, status FROM activity_logs ORDER BY id");
  assert.ok(calls.filter((x: any) => x.kind === "mcp_call").length >= 6, JSON.stringify(calls));
  assert.ok(b.db.value("SELECT 1 FROM mcp_clients WHERE client_name = 'claude-test-client'"));
  b.close();
});

test("MCP: CRUD tools, validation errors, locked memories and permissions", async () => {
  const dir = tmpDir();
  const c = await startClient(dir);
  const created = await c.call("moth_create_memory", { content: "Ironbound uses a 0.3s parry window.", project: "Ironbound Arena", category: "decision", tags: ["combat"] });
  assert.equal(created.isError, false);
  const id = created.data.id;
  const read = await c.call("moth_read_memory", { id });
  assert.equal(read.data.memory.project.name, "Ironbound Arena");
  assert.ok(read.data.memory.relationships.some((r: any) => r.type === "BELONGS_TO"));
  const app = await c.call("moth_append_memory", { id, content: "Perfect parries stun for 0.8s." });
  assert.equal(app.data.version, 2);
  const upd = await c.call("moth_update_memory", { id, reason: "tuning changed", content: "Ironbound uses a 0.25s parry window." });
  assert.equal(upd.data.version, 3);

  const bad = await c.call("moth_link_memories", { source_id: id, target_id: id, type: "NOT_A_TYPE", reason: "x" });
  assert.equal(bad.isError, true);
  const missing = await c.call("moth_read_memory", { id: "mem_doesnotexist" });
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing.data), /not_found/);

  // User edits lock the memory against Claude overwriting it.
  const b = Brain.open({ dataDir: dir, role: "test" });
  b.store.updateMemory(id, { content: "Parry window is 0.25s (user verified)." }, { actor: "user", reason: "user edit" });
  b.close();
  const locked = await c.call("moth_update_memory", { id, reason: "x change", content: "Parry window 1s" });
  assert.equal(locked.isError, true);
  assert.match(JSON.stringify(locked.data), /locked/);

  // Permanent delete is refused unless allowed by the user; archive works.
  const del = await c.call("moth_remove_memory", { id, reason: "cleanup", mode: "delete", user_requested: true });
  assert.equal(del.isError, true);
  assert.match(JSON.stringify(del.data), /permission_denied/);
  const arch = await c.call("moth_remove_memory", { id, reason: "obsolete" });
  assert.equal(arch.data.archived.status, "archived");

  // Turning off write permission is enforced on the next call.
  const b2 = Brain.open({ dataDir: dir, role: "test" });
  b2.settings.set("mcp.permissions", { read: true, write: false, merge: false, archive: false, delete: false });
  b2.close();
  const denied = await c.call("moth_create_memory", { content: "should fail" });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.data), /permission_denied/);
  const stillReads = await c.call("moth_get_brain_status", {});
  assert.equal(stillReads.isError, false);
  await c.close();
});

test("MCP: merge and link tools", async () => {
  const c = await startClient(tmpDir());
  const a = await c.call("moth_create_memory", { title: "Cursed RNG luck", content: "Luck multiplier starts at 1x and doubles with the Blessed curse." });
  const d = await c.call("moth_create_memory", { title: "Luck in Cursed RNG", content: "The Blessed curse doubles the luck multiplier." });
  const x = await c.call("moth_create_memory", { title: "Auto Roll pass", content: "Auto Roll game pass rolls every 2 seconds." });
  const link = await c.call("moth_link_memories", { source_id: x.data.id, target_id: a.data.id, type: "DEPENDS_ON", reason: "auto roll uses the luck system" });
  assert.equal(link.isError, false);
  const merged = await c.call("moth_merge_memories", { target_id: a.data.id, source_ids: [d.data.id], reason: "duplicate" });
  assert.equal(merged.isError, false);
  const rel = await c.call("moth_read_related", { id: a.data.id });
  assert.ok(rel.data.related.some((r: any) => r.id === x.data.id));
  const rc = await c.call("moth_get_relevant_context", { query: "how does luck work" });
  assert.ok(rc.data.stats.items >= 1);
  await c.close();
});
