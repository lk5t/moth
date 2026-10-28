// REAL local-inference tests for v0.4.0 (no stand-in model): llama.cpp + Qwen2.5 1.5B installed by the previous
// real test (cortex.real.test.ts) in the same data folder. Runs only with MOTH_REAL_AI=1. Evidence → evidence-intel.json.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Brain } from "../src/engine/brain.ts";

const ENABLED = process.env.MOTH_REAL_AI === "1";
const BASE = path.resolve(process.env.MOTH_REAL_DATA ?? path.join(os.tmpdir(), "moth-real"));
process.env.MOTH_LOG_STDERR = "0";
const evidence: Record<string, unknown> = { suite: "v0.4.0 intelligence (real model)", platform: `${process.platform}-${process.arch}`, started: new Date().toISOString(), steps: [] };
const step = (name: string, data: unknown) => {
  (evidence.steps as unknown[]).push({ name, at: new Date().toISOString(), data });
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(path.join(BASE, "evidence-intel.json"), JSON.stringify(evidence, null, 2));
};
const opts = { skip: !ENABLED && "set MOTH_REAL_AI=1 to run real local inference" };
const user = { actor: "user" as const, reason: "real test" };

async function finish(b: Brain, id: number, ms = 10 * 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await b.jobs.tick();
    const j = b.jobs.get(id)!;
    if (!["pending", "running"].includes(String(j.status))) return j;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("job did not finish in time");
}

test("REAL v0.4.0 test 8: Research Analyst extracts quoted insights with only the note's real sources", opts, async () => {
  const b = Brain.open({ dataDir: BASE, role: "app" });
  b.registerIntelligenceJobs();
  assert.ok(b.cortex.readiness().ok, JSON.stringify(b.cortex.readiness()));
  const m = b.store.createMemory({ title: "Daily walks and dog health", content: "Daily walks of at least 30 minutes keep adult dogs at a healthy weight. Dogs that walk every day show fewer behaviour problems. Puppies need shorter but more frequent walks.", category: "research", memory_type: "research", evidence: "sourced" }, user);
  b.db.run("INSERT INTO memory_sources(memory_id, url, title, publisher, published_at, kind, created_at) VALUES (?,?,?,?,?,'citation',?)", [m.id, "https://example.org/dog-walk-study", "Dog walking study", "Example University", "2023-05-02", new Date().toISOString()]);
  const t = Date.now();
  const jid = b.agents.run("research_analyst", { memory_id: m.id })!;
  const job = await finish(b, jid);
  const items = b.inbox.list({ limit: 50 }).filter((i: any) => i.job_id === jid);
  step("research_analyst", { seconds: (Date.now() - t) / 1000, status: job.status, result: job.result, insights: items.map((i: any) => ({ text: i.statement, reason: i.reason, sources: i.sources })) });
  assert.ok(["done", "awaiting_approval"].includes(String(job.status)), String(job.last_error));
  assert.equal((job.result as any).ai, "used");
  const body = m.content.toLowerCase().replace(/\s+/g, " ");
  for (const i of items) {
    const quote = String((i.proposal as any).quote).toLowerCase().replace(/\s+/g, " ").replace(/[“”"]/g, '"');
    assert.ok(body.includes(quote), `quote must come from the note: ${quote}`);
    for (const s of i.sources as any[]) assert.equal(s.url, "https://example.org/dog-walk-study", "no invented citation");
  }
  assert.ok(items.length >= 1, `the real model produced no valid insight: ${JSON.stringify(job.result)}`);
  b.close();
});

test("REAL v0.4.0: automatic Claude Code handoff from a real transcript", opts, async () => {
  const b = Brain.open({ dataDir: BASE, role: "app" });
  b.settings.set("sessions.autoHandoff", true);
  b.store.createProject({ name: "Shopfront" }, user);
  const tr = path.join(BASE, "session-real.jsonl");
  fs.writeFileSync(tr, [
    { type: "user", message: { role: "user", content: "Let's finish the checkout page for Shopfront today." } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I built the checkout page with the order summary and the card form, and added a webhook handler for payment confirmations." }] } },
    { type: "user", message: { role: "user", content: "Great. We decided to use Stripe. Refunds can wait." } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Noted: Stripe is the payment provider. The refund flow is still open. Next step: design the refund flow and write tests for the webhook." }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const t = Date.now();
  const r: any = await b.sessionHandoff({ transcript_path: tr, session_id: "real-1", cwd: "/work/Shopfront" });
  const h = b.handoffs.latest("Shopfront");
  step("session_handoff", { seconds: (Date.now() - t) / 1000, result: r, handoff: h ? { summary: h.summary, completed: h.completed, decisions: h.decisions, unresolved: h.unresolved, next_steps: h.next_steps, created_by: h.created_by } : null });
  assert.ok(h, JSON.stringify(r));
  assert.equal(h!.client, "claude-code");
  assert.ok(String(h!.summary).length > 10);
  const again: any = await b.sessionHandoff({ transcript_path: tr, session_id: "real-1", cwd: "/work/Shopfront" });
  assert.equal(b.handoffs.list({ project: "Shopfront" }).length, 1, `re-running doesn't duplicate (${again.outcome})`);
  b.close();
});

test("REAL v0.4.0 test 2: cancelling a running Cortex analysis job stops it; the model still works afterwards", opts, async () => {
  const b = Brain.open({ dataDir: BASE, role: "app" });
  b.registerIntelligenceJobs();
  const p = b.store.createProject({ name: "Long project" }, user);
  for (let i = 0; i < 6; i++) b.projectIntel.addItem(p.id, { kind: i % 2 ? "blocker" : "unresolved_decision", title: `Open question number ${i} about the networking and save system design` });
  const jid = b.agents.run("project_analyst", { project: p.id })!;
  const tick = b.jobs.tick();
  const t0 = Date.now();
  while (b.jobs.get(jid)!.status !== "running" && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 1500)); // let inference start
  const tc = Date.now();
  const cancelled = b.jobs.cancel(jid, "cancel test");
  await tick; // resolves when the handler has actually stopped
  const stoppedAfterMs = Date.now() - tc;
  const job = b.jobs.get(jid)!;
  // Afterwards the runtime must still answer (cancellation didn't break it).
  const t = Date.now();
  const ok = await b.cortex.router.generate<{ briefing: string; cites: number[] }>({ purpose: "test", system: "Reply with JSON.", user: 'Return {"briefing":"ok","cites":[1]}', schema: { type: "object", properties: { briefing: { type: "string" }, cites: { type: "array", items: { type: "number" } } }, required: ["briefing", "cites"] }, maxTokens: 40 });
  step("cancel_real_job", { cancelled, stopped_after_ms: stoppedAfterMs, status: job.status, cancel_reason: job.cancel_reason, after_cancel_generate_seconds: (Date.now() - t) / 1000, after: ok.data });
  assert.ok(cancelled);
  assert.equal(job.status, "cancelled");
  assert.ok(stoppedAfterMs < 10_000, `the job kept running for ${stoppedAfterMs} ms after cancelling`);
  b.close();
});
