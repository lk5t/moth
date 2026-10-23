// MOCKED Cortex tests: runtime lifecycle, router retries, validator, review queue, feedback,
// downloads/extraction and MCP plumbing. A deterministic fake server stands in for llama.cpp,
// so these tests prove the plumbing, NOT the intelligence. Real inference: test-real/.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { Brain } from "../src/engine/brain.ts";
import { download, extractTarGz, extractZip, findFile } from "../src/cortex/fetchfile.ts";
import { MODELS, RUNTIMES } from "../src/cortex/manifest.ts";
import { IntelligenceRouter, validateSchema, type ModelProvider } from "../src/cortex/providers.ts";
import { LlamaRuntime } from "../src/cortex/runtime.ts";
import { validateProposal } from "../src/cortex/validator.ts";
import { recommendModel } from "../src/cortex/hardware.ts";
import { tmpDir, user } from "./helpers.ts";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-llama-server.mjs");
const dummyModel = path.join(tmpDir("model"), "mock.gguf");
fs.writeFileSync(dummyModel, "not a real model");
process.env.MOTH_LLAMA_SERVER = FAKE;
process.env.MOTH_MODEL_PATH = dummyModel;
process.env.MOTH_MODEL_ID = "mock-model";

const brains: Brain[] = [];
after(() => {
  for (const b of brains) b.close();
});
function open(dir = tmpDir()): Brain {
  const b = Brain.open({ dataDir: dir, role: "test" });
  b.settings.set("cortex.idleTimeoutMin", 5);
  brains.push(b);
  return b;
}

test("manifest entries are complete and pinned (no invented values)", () => {
  for (const m of MODELS) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.size > 100_000_000);
    assert.match(m.url, /^https:\/\/huggingface\.co\/Qwen\//);
    assert.ok(m.license);
  }
  for (const r of RUNTIMES) {
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.match(r.url, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b\d+\//);
  }
  assert.equal(recommendModel({ totalRamGb: 4 }).model.parameters, "0.5B");
  assert.equal(recommendModel({ totalRamGb: 16 }).model.parameters, "1.5B");
});

test("runtime (mock server): loads on demand, unloads when idle, recovers from a crash, cleans up", async () => {
  const dir = tmpDir("rt");
  const rt = new LlamaRuntime({ serverPath: FAKE, modelPath: dummyModel, modelId: "mock", contextSize: 512, threads: 1, gpuLayers: 0, idleTimeoutMs: 1200, stateFile: path.join(dir, "state.json") });
  assert.equal(rt.state, "unloaded");
  const r = await rt.complete([{ role: "system", content: "x" }, { role: "user", content: "y" }]);
  assert.equal(r.text, "{}");
  assert.equal(rt.state, "ready");
  assert.ok(fs.existsSync(path.join(dir, "state.json")));
  await new Promise((res) => setTimeout(res, 2200));
  assert.equal(rt.state, "unloaded", "model should unload after the idle timeout");
  assert.ok(!fs.existsSync(path.join(dir, "state.json")));

  await rt.load();
  const pid = rt.info().pid!;
  process.kill(pid);
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(rt.state, "error");
  assert.match(rt.lastError ?? "", /stopped unexpectedly/);
  const again = await rt.complete([{ role: "user", content: "after crash" }]);
  assert.equal(again.text, "{}");
  assert.equal(rt.stats.crashes, 1);

  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(rt.complete([{ role: "user", content: "x" }], { signal: ctl.signal }), /Cancelled/);
  await rt.unload();
  assert.equal(rt.state, "unloaded");
});

test("router: bounded retries on invalid JSON; no silent cloud fallback", async () => {
  let n = 0;
  const local: ModelProvider = { kind: "local", id: () => "local:test", availability: () => ({ ok: true }), generate: async () => ({ text: n++ === 0 ? "nope" : '{"a":"x"}', ms: 1 }) };
  const cloud: ModelProvider = { kind: "cloud", id: () => "cloud:test", availability: () => ({ ok: false, reason: "Cloud fallback is switched off" }), generate: async () => { throw new Error("must not be called"); } };
  const b = open();
  const router = new IntelligenceRouter(local, cloud, b.store);
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const r = await router.generate<{ a: string }>({ purpose: "t", system: "s", user: "u", schema });
  assert.equal(r.attempts, 2);
  assert.equal(r.provider, "local");
  const bad: ModelProvider = { ...local, generate: async () => ({ text: '{"b":1}', ms: 1 }) };
  await assert.rejects(new IntelligenceRouter(bad, cloud, b.store).generate({ purpose: "t", system: "s", user: "u", schema }), /Invalid structured output.*Cloud fallback not used/s);
  assert.deepEqual(validateSchema({ a: 1 }, schema), ["$.a must be a string"]);
});

test("validator: balanced autonomy rules", () => {
  const mem = (o: Partial<any> = {}) => ({ id: "mem_1", title: "Inventory", content: "6 slots", status: "active", version: 1, manual_lock: false, importance: 0.5, flags: [], ...o }) as any;
  const base = { statement: "s", autonomy: "balanced" as const, minConfidence: 0.35, duplicateThreshold: 0.88, maxSimilarityToAny: 0.2, sourcePresent: true };
  const c = [{ index: 1, memory: mem(), similarity: 0.7 }];
  const p = (o: any) => ({ same_subject: 0, existing_value: "", new_value: "", values_differ: false, signals_change: false, relation: "new", target: 0, operation: "create", title: "t", content: "c", link_type: "none", reason: "r", confidence: 0.8, ...o });
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({}) }).action, "apply");
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({ relation: "correction", operation: "update", target: 1 }) }).action, "review");
  assert.equal(validateProposal({ ...base, autonomy: "autonomous", candidates: c, proposal: p({ relation: "correction", operation: "update", target: 1, confidence: 0.95 }) }).action, "apply");
  assert.equal(validateProposal({ ...base, autonomy: "autonomous", candidates: [{ index: 1, memory: mem({ manual_lock: true }), similarity: 1 }], proposal: p({ relation: "correction", operation: "update", target: 1, confidence: 0.99 }) }).action, "review");
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({ target: 7, relation: "extends", operation: "append" }) }).action, "reject");
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({ relation: "new", operation: "update", target: 1 }) }).action, "review");
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({ confidence: 0.1 }) }).action, "review");
  assert.equal(validateProposal({ ...base, maxSimilarityToAny: 0.95, candidates: c, proposal: p({}) }).action, "review");
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({ relation: "extends", operation: "append", target: 1 }) }).action, "apply");
  assert.equal(validateProposal({ ...base, candidates: c, proposal: p({ relation: "contradiction", operation: "flag_contradiction", target: 1 }) }).action, "review");
  assert.equal(validateProposal({ ...base, sourcePresent: false, candidates: c, proposal: p({}) }).action, "review");
  // Safety net: an "append" whose values conflict with the target is never applied silently.
  const conflict = validateProposal({ ...base, statement: "The inventory now has 10 slots.", candidates: c, proposal: p({ relation: "extends", operation: "append", target: 1, content: "now 10 slots" }) });
  assert.equal(conflict.action, "review");
  assert.ok(conflict.checks.some((x) => x.startsWith("conflicting evidence")));
  const evidence = validateProposal({ ...base, statement: "Upgraded to ten.", candidates: c, proposal: p({ relation: "extends", operation: "append", target: 1, values_differ: true, signals_change: true, existing_value: "six", new_value: "ten" }) });
  assert.equal(evidence.action, "review");
});

test("pipeline (mock model): correction goes to review, approval updates with history, survives restart; feedback recorded", async () => {
  const dir = tmpDir();
  let b = open(dir);
  const orig = b.store.createMemory({ title: "Roblox inventory", content: "My Roblox game uses a custom inventory system with six slots." }, user);
  const rep = await b.cortex.learn({ text: "The inventory system has been upgraded to ten slots.", source: "test" });
  assert.equal(rep.statements.length, 1);
  const s = rep.statements[0];
  assert.equal(s.relation, "correction");
  assert.equal(s.action, "queued_for_review");
  assert.equal(s.target?.id, orig.id);
  assert.match(b.store.getMemory(orig.id)!.content, /six slots/, "nothing changes before approval");
  const reviews = b.cortex.listReviews();
  assert.equal(reviews.length, 1);
  const ap = b.cortex.approve(Number(reviews[0].id));
  assert.equal(ap.status, "applied");
  const now = b.store.getMemory(orig.id)!;
  assert.match(now.content, /ten slots/);
  assert.ok(b.store.versions(orig.id).some((v: any) => /six slots/.test(v.content)), "old version kept");
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM feedback WHERE verdict = 'correct'")), 1);
  b.close();
  b = open(dir);
  const found = await b.search.hybrid("how many inventory slots");
  assert.match(found[0].memory.content, /ten slots/);

  // New information is created automatically; already-known information only reinforces.
  const rep2 = await b.cortex.learn({ text: "The shop opens with the B key.", source: "test" });
  assert.equal(rep2.statements[0].action, "applied");
  assert.ok(rep2.statements[0].memory_id);
  // Analyze-only changes nothing.
  const before = b.store.listMemories().total;
  const an = await b.cortex.learn({ text: "Pets follow the player.", source: "test", analyze_only: true });
  assert.equal(an.statements[0].action, "proposed");
  assert.equal(b.store.listMemories().total, before);
  // Rejection is recorded as feedback and appears in later prompts' examples.
  await b.cortex.learn({ text: "The inventory system has been upgraded to twelve slots.", source: "test" });
  const pending = b.cortex.listReviews()[0];
  b.cortex.reject(Number(pending.id), "We kept ten slots");
  assert.match(b.store.getMemory(orig.id)!.content, /ten slots/);
  assert.equal(Number(b.db.value("SELECT COUNT(*) FROM feedback WHERE verdict = 'incorrect'")), 1);
});

test("router retry with the mock server returning garbage once", async () => {
  process.env.FAKE_GARBAGE_FIRST = "1";
  try {
    const b = open();
    const rep = await b.cortex.learn({ text: "The forge melts iron ore.", source: "test" });
    assert.equal(rep.statements[0].action, "applied");
  } finally {
    delete process.env.FAKE_GARBAGE_FIRST;
  }
});

test("retrieval feedback nudges ranking and is reported", async () => {
  const b = open();
  const a = b.store.createMemory({ title: "Sword damage", content: "The iron sword deals 12 damage." }, user);
  const c = b.store.createMemory({ title: "Sword damage table", content: "The iron sword deals 12 damage per hit." }, user);
  b.cortex.recordRetrievalFeedback({ useful: [c.id, c.id, c.id], not_useful: [a.id, a.id, a.id], source: "test" });
  const r = await b.search.hybrid("iron sword damage");
  assert.equal(r[0].memory.id, c.id);
  assert.ok(r[0].why.includes("marked useful before"));
});

test("downloads: resume, SHA-256 verification, zip and tar.gz extraction with traversal protection", async () => {
  const dir = tmpDir("dl");
  const payload = crypto.randomBytes(300_000);
  const sha = crypto.createHash("sha256").update(payload).digest("hex");
  let ranges = 0;
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ""));
    if (m) {
      ranges++;
      const start = Number(m[1]);
      res.writeHead(206, { "content-length": payload.length - start, "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}` });
      return res.end(payload.subarray(start));
    }
    res.writeHead(200, { "content-length": payload.length });
    res.end(payload);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/file.bin`;
  const dest = path.join(dir, "file.bin");
  fs.writeFileSync(`${dest}.part`, payload.subarray(0, 100_000));
  const r = await download(url, dest, { sha256: sha, size: payload.length });
  assert.equal(r.sha256, sha);
  assert.equal(ranges, 1, "resumed with a range request");
  await assert.rejects(download(url, path.join(dir, "bad.bin"), { sha256: "0".repeat(64) }), /Integrity check failed/);
  assert.ok(!fs.existsSync(path.join(dir, "bad.bin")));
  server.close();

  // zip (stored + deflate) built by hand, including a path-traversal entry that must be ignored
  const entries = [
    { name: "bin/llama-server.exe", data: Buffer.from("server"), deflate: true },
    { name: "bin/ggml.dll", data: Buffer.from("x".repeat(1000)), deflate: false },
    { name: "../evil.txt", data: Buffer.from("nope"), deflate: false },
  ];
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const comp = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, name, comp);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  const zipFile = path.join(dir, "rt.zip");
  fs.writeFileSync(zipFile, Buffer.concat([...parts, cd, eocd]));
  const out = path.join(dir, "zip-out");
  extractZip(zipFile, out);
  assert.equal(fs.readFileSync(path.join(out, "bin/llama-server.exe"), "utf8"), "server");
  assert.equal(fs.readFileSync(path.join(out, "bin/ggml.dll"), "utf8").length, 1000);
  assert.ok(!fs.existsSync(path.join(dir, "evil.txt")));
  assert.equal(findFile(out, ["llama-server.exe"]), path.join(out, "bin", "llama-server.exe"));

  // tar.gz via the system tar
  const src = path.join(dir, "tsrc", "build", "bin");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "llama-server"), "#!/bin/sh\n", { mode: 0o755 });
  const tgz = path.join(dir, "rt.tar.gz");
  // On Windows use the built-in bsdtar (Git's GNU tar treats "C:" as a remote host).
  const tarBin = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tarBin, ["-czf", tgz, "-C", path.join(dir, "tsrc"), "build"]);
  const tout = path.join(dir, "tar-out");
  extractTarGz(tgz, tout);
  assert.ok(findFile(tout, ["llama-server"]));
});

test("MCP process never runs the model itself: moth_learn queues for the desktop app", async () => {
  const dir = tmpDir();
  const mcp = Brain.open({ dataDir: dir, role: "mcp" });
  brains.push(mcp);
  assert.equal(mcp.cortex.runtime(), null);
  const id = mcp.cortex.enqueueLearn({ text: "The arena has four spawn points.", source: "claude" }, "mcp");
  const row = await mcp.cortex.waitForJob(id, 800);
  assert.equal(row, null, "still pending: no app process");
  // The desktop app's engine picks it up.
  const app = open(dir);
  app.cortex.registerJobs();
  await app.jobs.tick();
  const done = await mcp.cortex.waitForJob(id, 5000);
  assert.equal(done?.status, "done");
  assert.equal((done!.result as any).applied, 1);
  const st = await mcp.cortex.status();
  assert.equal((st.queue as any).pending_jobs, 0);
});
