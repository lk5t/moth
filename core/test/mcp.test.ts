// End-to-end: real MCP server process over stdio, spoken to with raw JSON-RPC exactly like a client.
// Runs against the official SDK in CI (and an offline stand-in locally).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Brain } from "../src/engine/brain.ts";
import { TOOL_NAMES } from "../src/mcp/server.ts";
import { tmpDir } from "./helpers.ts";
import { startClient } from "./fixtures/mcp-client.ts";


test("MCP: lists all tools with schemas", async () => {
  const c = await startClient(tmpDir());
  const r = await c.request("tools/list");
  const names = r.result.tools.map((t: any) => t.name).sort();
  assert.equal(names.length, TOOL_NAMES.length);
  assert.ok(names.includes("moth_save_handoff") && names.includes("moth_resume_project"));
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

test("MCP v0.2.5: preferences, research with sources, lessons and knowledge transfer over real MCP calls", async () => {
  const dir = tmpDir();
  const c = await startClient(dir);
  const pref = await c.call("moth_record_preference", { content: "Prefers modular Roblox scripts and testing after each feature", explicit: true, area: "workflow" });
  assert.equal(pref.isError, false, JSON.stringify(pref.data));
  assert.equal(pref.data.status, "confirmed");
  const inferred = await c.call("moth_record_preference", { content: "Seems to like neon colours in menus", explicit: false });
  assert.equal(inferred.data.status, "tentative");

  const research = await c.call("moth_submit_research", {
    topic: "How to get more players on a Roblox game",
    domain: "Roblox / Game Design / Retention",
    project: "Cursed RNG",
    findings: [
      { insight: "Research suggests a clear, engaging introduction helps new players understand the goal and keep playing.", basis: "evidence", sources: [{ url: "https://example.org/roblox-onboarding", title: "Onboarding guide", retrieved_at: "2026-10-23" }] },
      { insight: "Adding a leaderboard probably helps retention.", basis: "evidence" },
    ],
  });
  assert.equal(research.isError, false, JSON.stringify(research.data));
  assert.equal(research.data.stored.length, 1);
  assert.equal(research.data.needs_review.length, 1);

  const lesson = await c.call("moth_record_lesson", { problem: "Inventory trusted client-reported quantities", correction: "Server validates inventory changes", lesson: "Validate important inventory changes on the server instead of trusting the client", verified: true, project: "Cursed RNG", scope: "global" });
  assert.equal(lesson.data.stored, true);

  const begin = await c.call("moth_begin_task", { task: "Start a new Roblox simulator project called Pet Valley with an inventory and a good first-time player experience", project: "Pet Valley" });
  assert.equal(begin.isError, false, JSON.stringify(begin.data));
  const insights = await c.call("moth_commit_learning", { summary: "Started Pet Valley", project: "Pet Valley", project_status: "Roblox pet simulator with inventory; early retention matters" });
  assert.equal(insights.isError, false, JSON.stringify(insights.data));
  const tr = await c.call("moth_get_project_insights", { project: "Pet Valley", focus: "inventory and first-time player experience in a Roblox simulator" });
  assert.equal(tr.isError, false, JSON.stringify(tr.data));
  const types = tr.data.items.map((i: any) => i.memory_type);
  assert.ok(types.includes("lesson"), JSON.stringify(tr.data.items));
  assert.ok(types.includes("research"), JSON.stringify(tr.data.items));
  const prefs = await c.call("moth_get_preferences", { task: "Write the pet inventory script" });
  assert.ok(prefs.data.preferences.some((p: any) => /modular Roblox scripts/.test(p.preference)));
  assert.ok(!prefs.data.preferences.some((p: any) => /neon/.test(p.preference)), "a single inference is not used yet");
  await c.close();

  // Privacy Mode (set in the app) blocks Claude's automatic capture.
  const b = Brain.open({ dataDir: dir, role: "test" });
  b.setPrivacyMode(true);
  b.close();
  const c2 = await startClient(dir);
  const blocked = await c2.call("moth_submit_research", { topic: "anything", findings: [{ insight: "This should not be saved while private.", basis: "speculation" }] });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked.data), /Privacy Mode/);
  await c2.close();
});

test("MCP (v0.4.0 test 4): session handoff saved over MCP survives a restart; duplicates are handled; resume uses it", async () => {
  const dir = tmpDir();
  // A project with an explicit blocker, created through MCP like a client would.
  let c = await startClient(dir);
  const mem = await c.call("moth_commit_learning", { summary: "Set up the payment service", project: "Shopfront", decisions: ["Use Stripe for card payments"] });
  assert.equal(mem.isError, false, JSON.stringify(mem.data));
  const blocker = await c.call("moth_record_project_item", { project: "Shopfront", kind: "blocker", title: "Waiting for the Stripe account approval" });
  assert.equal(blocker.isError, false, JSON.stringify(blocker.data));
  const args = { project: "Shopfront", session_id: "sess-42", summary: "Built checkout page and webhook handler.", completed: ["Checkout page", "Webhook handler"], decisions: ["Webhooks verified with signing secret"], unresolved: ["Refund flow not designed"], next_steps: ["Design the refund flow"] };
  const first = await c.call("moth_save_handoff", args);
  assert.equal(first.isError, false, JSON.stringify(first.data));
  assert.equal(first.data.outcome, "created");
  const again = await c.call("moth_save_handoff", args);
  assert.equal(again.data.outcome, "unchanged", "same session + same content must not create a duplicate");
  assert.equal(again.data.handoff.id, first.data.handoff.id);
  const edited = await c.call("moth_save_handoff", { ...args, next_steps: ["Design the refund flow", "Write webhook tests"] });
  assert.equal(edited.data.outcome, "updated");
  assert.equal(edited.data.handoff.version, 2);
  const bad = await c.call("moth_save_handoff", { ...args, session_id: "sess-43", memory_ids: ["mem_doesnotexist"] });
  assert.equal(bad.isError, true, "references to memories that don't exist are rejected");
  await c.close();

  // Restart: a brand-new server process reads the same database.
  c = await startClient(dir);
  const latest = await c.call("moth_get_latest_handoff", { project: "Shopfront" });
  assert.equal(latest.isError, false, JSON.stringify(latest.data));
  assert.equal(latest.data.handoff.id, first.data.handoff.id);
  assert.equal(latest.data.handoff.project, "Shopfront");
  assert.deepEqual(latest.data.handoff.next_steps, ["Design the refund flow", "Write webhook tests"]);
  assert.deepEqual(latest.data.handoff.completed, ["Checkout page", "Webhook handler"]);
  const list = await c.call("moth_list_handoffs", { project: "Shopfront" });
  assert.equal(list.data.handoffs.length, 1, "one handoff, two versions");
  const resume = await c.call("moth_resume_project", { project: "Shopfront" });
  assert.equal(resume.isError, false, JSON.stringify(resume.data));
  assert.match(resume.data.briefing, /Suggested next step: Design the refund flow/);
  assert.match(resume.data.briefing, /Waiting for the Stripe account approval/);
  assert.equal(resume.data.data.next_step.ref.type, "handoff");
  await c.close();
});
