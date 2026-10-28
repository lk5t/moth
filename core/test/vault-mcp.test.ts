// v0.5.0 Vault over real MCP: Claude can search and read notes; per-app project permissions apply to notes too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Brain } from "../src/engine/brain.ts";
import { startClient } from "./fixtures/mcp-client.ts";
import { tmpDir, user } from "./helpers.ts";

test("MCP: moth_search_notes / moth_read_note return real notes with links; a note in a project the app may not read is hidden and refused", async () => {
  const dir = tmpDir();
  const b = Brain.open({ dataDir: dir, role: "test" });
  const secret = b.store.createProject({ name: "Diary" }, user);
  const plan = b.library.create({ title: "Arena plan", content: "# Arena plan\nParry window is 200 ms. See [[Combat notes]]." });
  const combat = b.library.create({ title: "Combat notes", content: "Combat: parry, block, dash." });
  const diary = b.library.create({ title: "Diary parry thoughts", content: "Private parry thoughts", project_id: secret.id });
  b.permissions.set("client:claude-code", "read_memories", false, secret.id);
  b.close();
  const c = await startClient(dir, "claude-code");
  const s = await c.call("moth_search_notes", { query: "parry" });
  assert.equal(s.isError, false, JSON.stringify(s.data));
  const ids = s.data.results.map((r: any) => r.id);
  assert.ok(ids.includes(plan.id) && ids.includes(combat.id));
  assert.ok(!ids.includes(diary.id), "restricted project's note is left out");
  assert.ok(s.data.withheld?.count >= 1);
  const r = await c.call("moth_read_note", { id: plan.id });
  assert.equal(r.isError, false);
  assert.match(r.data.note.content, /200 ms/);
  assert.deepEqual(r.data.links_to.map((l: any) => l.title), ["Combat notes"]);
  const denied = await c.call("moth_read_note", { id: diary.id });
  assert.equal(denied.isError, true);
  assert.equal(denied.data.error, "permission_denied");
  await c.close();
});
