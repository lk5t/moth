import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { startApi } from "../src/api/server.ts";
import { Brain } from "../src/engine/brain.ts";
import { tmpDir } from "./helpers.ts";

function controller(dir: string) {
  let brain = Brain.open({ dataDir: dir, role: "app" });
  return {
    brain: () => brain,
    reopen: () => {
      brain.close();
      brain = Brain.open({ dataDir: dir, role: "app" });
    },
    setHttpMcp: async () => ({ running: false }),
    httpMcpRunning: () => false,
  };
}

async function rpc(port: number, token: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/rpc`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ method, params }) });
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: r.status, body };
}

test("API: token required, origin checked, RPC methods work, SSE streams changes from another process", async () => {
  const dir = tmpDir();
  const c = controller(dir);
  const api = await startApi(c, {});
  try {
    assert.equal((await rpc(api.port, "wrong", "status")).status, 401);
    const evil = await rpc(api.port, api.token, "status", {}, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    const ok = await rpc(api.port, api.token, "status", {}, { origin: "http://tauri.localhost" });
    assert.equal(ok.status, 200);

    await rpc(api.port, api.token, "demo.load");
    const ov = await rpc(api.port, api.token, "overview");
    assert.ok(ov.body.result.stats.total_memories > 5);
    const g = await rpc(api.port, api.token, "graph.get");
    assert.ok(g.body.result.nodes.length > 5);
    const s = await rpc(api.port, api.token, "search", { query: "items duplicated when dragging" });
    assert.equal(s.body.result[0].memory.title, "Items duplicated when dragging fast");
    const ask = await rpc(api.port, api.token, "search.ask", { query: "What fixed the duplication bug?" });
    assert.match(ask.body.result.answer, /lock|mutex|duplicat/i);
    const bad = await rpc(api.port, api.token, "memories.get", { id: "nope" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "not_found");
    const set = await rpc(api.port, api.token, "settings.set", { key: "retrieval.tokenBudget", value: 3000 });
    assert.equal(set.body.result.value, 3000);
    const wrongType = await rpc(api.port, api.token, "settings.set", { key: "retrieval.tokenBudget", value: "lots" });
    assert.equal(wrongType.status, 400);

    // SSE: a write from a *separate* Brain instance (like the MCP process) reaches the UI stream.
    const got = new Promise<any>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${api.port}/api/events?token=${api.token}`, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          buf += d;
          const m = buf.match(/event: changes\ndata: (.*)\n/);
          if (m) {
            req.destroy();
            resolve(JSON.parse(m[1]));
          }
        });
      });
      req.on("error", () => undefined);
      setTimeout(() => reject(new Error("no SSE event")), 5000);
    });
    await new Promise((r) => setTimeout(r, 200));
    const other = Brain.open({ dataDir: dir, role: "mcp" });
    const m = other.store.createMemory({ content: "Created by the MCP process" }, { actor: "claude", reason: "t" });
    other.close();
    const ev = await got;
    assert.ok(ev.changes.some((x: any) => x.entity === "memory" && x.id === m.id));

    // Backup restore through the API re-opens the brain.
    const bk = await rpc(api.port, api.token, "backup.create");
    await rpc(api.port, api.token, "memories.create", { content: "temporary after backup" });
    const rs = await rpc(api.port, api.token, "backup.restore", { name: bk.body.result.name });
    assert.equal(rs.body.result?.restored, true, JSON.stringify(rs.body));
    const after = await rpc(api.port, api.token, "search", { query: "temporary after backup" });
    assert.ok(!after.body.result.some((r: any) => r.memory.content === "temporary after backup"));
  } finally {
    await api.close();
    c.brain().close();
  }
});
