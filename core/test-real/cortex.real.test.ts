// REAL local-inference acceptance test. No mocks: MOTH's own installer downloads llama.cpp and a
// Qwen2.5 GGUF model (SHA-256 verified), then Cortex runs the inventory scenario end to end.
// Runs only with MOTH_REAL_AI=1 (CI job "Real local AI"). Evidence is written to evidence.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Brain } from "../src/engine/brain.ts";

const ENABLED = process.env.MOTH_REAL_AI === "1";
const BASE = path.resolve(process.env.MOTH_REAL_DATA ?? path.join(os.tmpdir(), "moth-real"));
const MODEL = process.env.MOTH_REAL_MODEL ?? "qwen2.5-1.5b-instruct-q4_k_m";
delete process.env.MOTH_LLAMA_SERVER;
delete process.env.MOTH_MODEL_PATH;
process.env.MOTH_LOG_STDERR = "0";

const evidence: Record<string, unknown> = { platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, ram_gb: Math.round(os.totalmem() / 1024 ** 3), model: MODEL, started: new Date().toISOString(), steps: [] };
const step = (name: string, data: unknown) => {
  (evidence.steps as unknown[]).push({ name, at: new Date().toISOString(), data });
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(path.join(BASE, "evidence.json"), JSON.stringify(evidence, null, 2));
};

test("REAL: install runtime + model, learn inventory 6 → 10 with a real local model", { skip: !ENABLED && "set MOTH_REAL_AI=1 to run real local inference" }, async () => {
  fs.mkdirSync(BASE, { recursive: true });
  for (const f of ["moth.db", "moth.db-wal", "moth.db-shm"]) fs.rmSync(path.join(BASE, f), { force: true });
  let brain = Brain.open({ dataDir: BASE, role: "app" });
  brain.settings.set("cortex.idleTimeoutMin", 5);

  // 1. Installation through MOTH's own installer (downloads skipped when already cached + verified).
  const plan = await brain.cortex.installPlan(MODEL);
  step("hardware_and_plan", { hardware: plan.hardware, recommended: plan.recommended, needs: plan.needs, downloadBytes: plan.downloadBytes });
  if (plan.needs.runtime || plan.needs.model) {
    // re-register cached files if present (download() re-verifies their SHA-256 without re-downloading)
    brain.cortex.startInstall(MODEL, true);
    const t0 = Date.now();
    for (;;) {
      const s = brain.cortex.installStatus();
      if (s.phase === "done") break;
      if (s.phase === "error" || s.phase === "cancelled") throw new Error(`Install failed: ${s.error}`);
      if (Date.now() - t0 > 30 * 60_000) throw new Error("Install timed out");
      await new Promise((r) => setTimeout(r, 1000));
    }
    step("install", { seconds: Math.round((Date.now() - t0) / 1000), components: brain.cortex.installedComponents().map((c) => ({ id: c.id, sha256: c.sha256, verified: c.verified })) });
  }
  assert.ok(brain.cortex.readiness().ok, JSON.stringify(brain.cortex.readiness()));

  // 2. Lifecycle: on-demand load + unload with the real runtime.
  let t = Date.now();
  await brain.cortex.load();
  const loadedInfo = brain.cortex.runtime()!.info();
  step("load", { seconds: (Date.now() - t) / 1000, state: loadedInfo.state, pid: loadedInfo.pid, model: loadedInfo.model });
  assert.equal(loadedInfo.state, "ready");
  await brain.cortex.unload();
  assert.equal(brain.cortex.runtime()!.state, "unloaded");

  // 3. The scenario.
  const original = brain.store.createMemory({ title: "Roblox inventory system", content: "My Roblox game uses a custom inventory system with six slots." }, { actor: "claude", reason: "initial memory" });
  t = Date.now();
  const report = await brain.cortex.learn({ text: "The inventory system has been upgraded to ten slots.", source: "acceptance-test", source_ref: "test-real" });
  step("learn", { seconds: (Date.now() - t) / 1000, report });
  const hit = report.statements.find((s) => s.target?.id === original.id);
  assert.ok(hit, `Cortex should recognise the existing inventory memory. Report: ${JSON.stringify(report.statements)}`);
  assert.equal(hit.relation, "correction", `should understand this describes a change: ${JSON.stringify(hit)}`);
  assert.equal(hit.proposed_operation, "update", JSON.stringify(hit));
  assert.equal(hit.action, "queued_for_review", "balanced autonomy: replacing a fact needs approval");
  assert.match(brain.store.getMemory(original.id)!.content, /six/, "unchanged until approved");

  // 4. Authorisation → update with history.
  const approval = brain.cortex.approve(hit.review_id!);
  const updated = brain.store.getMemory(original.id)!;
  step("approve", { approval, content: updated.content, version: updated.version });
  assert.match(updated.content, /\bten\b|\b10\b/i);
  assert.doesNotMatch(updated.content, /\bsix\b/i);
  const versions = brain.store.versions(original.id);
  assert.ok(versions.some((v: any) => /six/.test(v.content)), "six-slot version kept in history");

  // 5. Graph consistency.
  const g = brain.graph();
  const ids = new Set((g.nodes as any[]).map((n) => n.id));
  assert.ok(ids.has(original.id));
  assert.ok((g.links as any[]).every((l) => ids.has(l.source_id) && ids.has(l.target_id)));
  brain.close();

  // 6. Restart → correct current information is retrieved, including via the model's own briefing.
  brain = Brain.open({ dataDir: BASE, role: "app" });
  const found = await brain.search.hybrid("How many slots does the inventory have?");
  step("after_restart_search", found.slice(0, 3).map((f) => ({ title: f.memory.title, content: f.memory.content, score: f.score })));
  assert.equal(found[0].memory.id, original.id);
  assert.match(found[0].memory.content, /\bten\b|\b10\b/i);
  t = Date.now();
  const ctx = await brain.cortex.intelligentContext("Add a new item to the inventory. How many slots are there?", { synthesize: true });
  step("intelligent_context", { seconds: (Date.now() - t) / 1000, brief: ctx.brief, model: ctx.brief_model });
  assert.match(String(ctx.brief), /\bten\b|\b10\b/i, "the local model's briefing should state the current value");

  // 7. Idle unload with the real runtime.
  brain.settings.set("cortex.idleTimeoutMin", 0.1);
  brain.cortex.runtime();
  await new Promise((r) => setTimeout(r, 9000));
  step("idle_unload", { state: brain.cortex.runtime()!.state });
  assert.equal(brain.cortex.runtime()!.state, "unloaded");
  brain.close();
  evidence.finished = new Date().toISOString();
  evidence.result = "PASS";
  step("done", {});
});
