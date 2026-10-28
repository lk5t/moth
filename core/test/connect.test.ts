// v0.4.0 Milestone 8: MOTH Connect — per-app project access enforced in MCP, evidence-based connection states,
// extended diagnostics. Uses real MCP server processes over stdio.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { clientStates, selfTest } from "../src/connections.ts";
import { Brain } from "../src/engine/brain.ts";
import { clientSubject } from "../src/intelligence/permissions.ts";
import { startClient } from "./fixtures/mcp-client.ts";
import { tmpDir } from "./helpers.ts";

test("clientSubject drops versions so rules survive app updates", () => {
  assert.equal(clientSubject("claude-ai"), "client:claude-ai");
  assert.equal(clientSubject("Claude-Code 2.1.4"), "client:claude-code");
  assert.equal(clientSubject("cursor v1.2"), "client:cursor");
  assert.equal(clientSubject(null), "client:unknown");
});

test("v0.4.0 test 15: per-app project permissions are enforced in MCP tools; other apps are unaffected; states come from evidence", async () => {
  const dir = tmpDir();
  let c = await startClient(dir, "claude-code");
  const open = await c.call("moth_create_memory", { content: "Arena matches last three minutes", title: "Match length", project: "Arena" });
  assert.equal(open.isError, false, JSON.stringify(open.data));
  const secret = await c.call("moth_create_memory", { content: "Diary: matches with friends make me happy", title: "Private diary entry about matches", project: "Diary" });
  assert.equal(secret.isError, false, JSON.stringify(secret.data));

  // The user restricts Claude Code from the Diary project (as the Permissions tab does).
  const brain = Brain.open({ dataDir: dir, role: "test" });
  const diary = brain.store.getProject("Diary")!;
  brain.permissions.set("client:claude-code", "read_memories", false, diary.id);
  brain.permissions.set("client:claude-code", "write_memories", false, diary.id);
  brain.permissions.set("client:claude-code", "read_projects", false, diary.id);
  const m: any = brain.permissions.matrix().find((x: any) => x.subject === "client:claude-code");
  assert.ok(m, "the client appears in the permission matrix once it has connected");
  assert.deepEqual(m!.permissions.map((p: any) => p.permission), ["read_memories", "read_projects", "write_memories"]);
  assert.equal(m!.project_overrides.length, 3);

  const search = await c.call("moth_search_memories", { query: "matches" });
  assert.equal(search.isError, false, JSON.stringify(search.data));
  const ids = search.data.results.map((r: any) => r.id);
  assert.ok(ids.includes(open.data.id), "allowed project still readable");
  assert.ok(!ids.includes(secret.data.id), "restricted project's memory is not returned");
  assert.ok(search.data.withheld?.count >= 1, "the answer says something was withheld");
  const read = await c.call("moth_read_memory", { id: secret.data.id });
  assert.equal(read.isError, true);
  assert.equal(read.data.error, "permission_denied");
  const write = await c.call("moth_create_memory", { content: "More diary", project: "Diary" });
  assert.equal(write.isError, true, "writing into the restricted project is refused");
  const append = await c.call("moth_append_memory", { id: secret.data.id, content: "sneaky" });
  assert.equal(append.isError, true);
  const status = await c.call("moth_get_brain_status", {});
  assert.ok(!JSON.stringify(status.data).includes(diary.id), "the restricted project isn't listed");
  const begin = await c.call("moth_begin_task", { task: "Diary matches with friends" });
  assert.ok(!JSON.stringify(begin.data).includes(secret.data.id), "context packages leave it out too");
  const ok = await c.call("moth_create_memory", { content: "Arena uses a 3 minute timer", project: "Arena" });
  assert.equal(ok.isError, false);
  assert.equal(brain.db.value("SELECT content FROM memories WHERE id = ?", [secret.data.id]), "Diary: matches with friends make me happy", "the refused append changed nothing");

  // Another app (Claude Desktop) has no restriction.
  const d = await startClient(dir, "claude-ai");
  const dRead = await d.call("moth_read_memory", { id: secret.data.id });
  assert.equal(dRead.isError, false, "rules are per app");

  // Evidence-based states: Claude Code's last call was refused → authorization required (with the reason).
  await c.call("moth_read_memory", { id: secret.data.id });
  let st: any = clientStates(brain);
  assert.equal(st.claude_code.state, "authorization_required");
  assert.ok(st.claude_code.evidence.some((e: string) => /refused|failed/.test(e) || /isn't allowed|not allowed/.test(e)), JSON.stringify(st.claude_code.evidence));
  assert.equal(st.claude_desktop.live, true);
  // Allowing it again: next call succeeds and the state follows the evidence.
  brain.permissions.clear("client:claude-code", "read_memories", diary.id);
  brain.permissions.clear("client:claude-code", "read_projects", diary.id);
  const again = await c.call("moth_read_memory", { id: secret.data.id });
  assert.equal(again.isError, false);
  st = clientStates(brain);
  assert.equal(st.claude_code.state, "connected");
  await c.close();
  await d.close();
  await new Promise((r) => setTimeout(r, 300));
  st = clientStates(brain);
  assert.notEqual(st.claude_code.state, "connected", "no live process → not shown as connected");
  assert.ok(["disconnected", "not_configured", "configured", "restart_required"].includes(st.claude_code.state), st.claude_code.state);
  brain.close();
});

test("v0.4.0 M8: extended diagnostics run real tool calls (startup, discovery, invocation, memory and handoff retrieval, error handling)", async () => {
  const dir = tmpDir();
  const prev = process.env.MOTH_DATA_DIR;
  const prevArgv = process.argv[1];
  process.env.MOTH_DATA_DIR = dir;
  process.argv[1] = path.resolve(import.meta.dirname, "../src/index.ts");
  try {
    const r = await selfTest(30000);
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const k of ["started", "initialized", "tools_listed", "tool_executed", "memory_retrieval", "handoff_retrieval", "error_handling"]) assert.equal(r.steps[k], true, k);
    assert.match(r.details.error_handling, /not found/);
    assert.match(r.details.handoff_retrieval, /no handoff saved yet/);
  } finally {
    process.env.MOTH_DATA_DIR = prev;
    process.argv[1] = prevArgv;
  }
});
