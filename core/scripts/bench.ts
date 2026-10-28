// MOTH performance benchmark (v0.4.0). Real engine, real SQLite, generated data; prints measured numbers only.
//
//   node --experimental-transform-types scripts/bench.ts 100 1000 10000 [--out bench.json]
//
// For each size it builds a fresh database (memories spread over projects, with connections, open decisions,
// blockers and handoffs), then measures: build rate, startup (opening the database and an MCP server answering
// tools/list), search latency, graph load, Pulse, the Mind 3.0 path/history queries, the intelligence scans and the
// agents (plain checks; no AI model is installed in this benchmark, so model-written parts are skipped), process
// memory, and idle CPU of the background service (Linux only, read from /proc).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";
import { intelligencePulse, pulse } from "../src/api/pulse.ts";
import { DatabaseSync } from "node:sqlite";
import { Brain } from "../src/engine/brain.ts";

let backgroundSettleMs = 0;

const ENTRY = path.resolve(import.meta.dirname, "../src/index.ts");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const sizes = args.filter((a, i) => /^\d+$/.test(a) && (outIdx < 0 || i !== outIdx + 1)).map(Number);
if (!sizes.length) sizes.push(100, 1000);
const user = { actor: "user" as const, reason: "benchmark" };

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
// Text with a realistic shape: a Zipf-distributed vocabulary of a few thousand words (a handful very common,
// most rare), so word-based similarity behaves like it does on real notes rather than on a tiny word list.
const SYL = "ka ri to mo ne sa lu vi pe da go fi ra zo mi ta ke no su ha".split(" ");
const VOCAB = Array.from({ length: 4000 }, (_, i) => {
  let w = "";
  for (let k = i + 7, n = 2 + (i % 3); n > 0; n--, k = Math.floor(k / SYL.length) + 3) w += SYL[k % SYL.length];
  return w + (i > 400 ? String.fromCharCode(97 + (i % 26)) : "");
});
const ZIPF = (() => {
  const w = VOCAB.map((_, i) => 1 / Math.pow(i + 1, 1.07));
  const tot = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => (acc += x / tot));
})();
const word = () => {
  const r = rnd();
  let lo = 0, hi = ZIPF.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ZIPF[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return VOCAB[lo];
};
const sentence = (n: number) => Array.from({ length: n }, word).join(" ");

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const time = async <T>(fn: () => T | Promise<T>): Promise<[T, number]> => {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  return [r, ms(t0)];
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;

async function mcpStartup(dataDir: string): Promise<number> {
  const t0 = process.hrtime.bigint();
  const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", ENTRY, "mcp"], { env: { ...process.env, MOTH_DATA_DIR: dataDir, MOTH_LOG_STDERR: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  return await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => (child.kill(), reject(new Error("MCP startup timed out"))), 60000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        } else if (msg.id === 2) {
          const t = ms(t0);
          clearTimeout(timer);
          child.stdin.end();
          child.once("exit", () => resolve(t));
          setTimeout(() => child.kill(), 3000);
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "moth-bench", version: "1" } } }) + "\n");
  });
}

/** CPU used by the background service while nobody uses it (Linux /proc only). */
async function idleCpu(dataDir: string, seconds = 20): Promise<number | null> {
  if (process.platform !== "linux") return null;
  const port = 49000 + Math.floor(rnd() * 900);
  const child = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", ENTRY, "serve", "--port", String(port), "--token", "bench-token-bench-token-bench"], { env: { ...process.env, MOTH_DATA_DIR: dataDir, MOTH_LOG_STDERR: "0" }, stdio: ["pipe", "ignore", "ignore"] });
  const ticks = () => {
    const f = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1].split(" ");
    return Number(f[11]) + Number(f[12]); // utime + stime (clock ticks)
  };
  // Wait until the first round of scheduled background work (scans, agents) has finished: idle means nothing queued.
  const dbFile = path.join(dataDir, fs.readdirSync(dataDir).find((f) => f.endsWith(".db"))!);
  const t0 = Date.now();
  let quietSince = 0;
  await new Promise((r) => setTimeout(r, 26000)); // the scheduler's first cycle runs 20 s after start
  while (Date.now() - t0 < 600_000) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const busy = Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' OR (status = 'pending' AND run_after <= ?)").get(new Date(Date.now() + 60_000).toISOString()) as any).n);
    db.close();
    if (busy) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince > 5000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  backgroundSettleMs = Date.now() - t0;
  const a = ticks();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const b = ticks();
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
  if (process.env.BENCH_DEBUG) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    console.error(JSON.stringify(db.prepare("SELECT kind, status, COUNT(*) n, MAX(created_at) last FROM jobs GROUP BY kind, status").all()));
    console.error(JSON.stringify(db.prepare("SELECT kind, action, COUNT(*) n FROM activity_logs WHERE created_at >= ? GROUP BY kind, action ORDER BY n DESC LIMIT 15").all(new Date(Date.now() - seconds * 1000).toISOString())));
    db.close();
  }
  const hz = 100; // USER_HZ on Linux
  return r1((((b - a) / hz) / seconds) * 100);
}

async function run(n: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `moth-bench-${n}-`));
  let b = Brain.open({ dataDir: dir, role: "cli" });
  const projects = Array.from({ length: Math.max(3, Math.round(Math.sqrt(n) / 2)) }, (_, i) => b.store.createProject({ name: `Project ${i + 1} ${word()}` }, user));
  const ids: string[] = [];
  const byProject = new Map<string, string[]>();
  const [, buildMs] = await time(() => {
    for (let i = 0; i < n; i++) {
      const p = pick(projects);
      const cat = pick(["fact", "decision", "task", "research", "error", "idea", "solution"]);
      const m = b.store.createMemory({ title: `${sentence(3)} ${i}`, content: `${sentence(25)}. ${sentence(18)}.`, category: cat as any, project_id: p.id }, user);
      ids.push(m.id);
      const list = byProject.get(p.id) ?? byProject.set(p.id, []).get(p.id)!;
      if (list.length) b.store.link(m.id, pick(list.slice(-30)), pick(["RELATED_TO", "DEPENDS_ON", "REFERENCES"]) as any, "benchmark link", user);
      if (list.length > 5 && rnd() < 0.3) {
        try {
          b.store.link(m.id, pick(list), "RELATED_TO" as any, "benchmark link", user);
        } catch {
          /* duplicate link */
        }
      }
      list.push(m.id);
    }
    for (const p of projects.slice(0, 6)) {
      b.projectIntel.addItem(p.name, { kind: "unresolved_decision", title: `Decide ${sentence(3)}` });
      b.projectIntel.addItem(p.name, { kind: "blocker", title: `Waiting for ${sentence(2)}` });
      b.handoffs.save({ project: p.name, client: "bench", session_id: `s-${p.id}`, summary: sentence(10), completed: [sentence(4)], next_steps: [sentence(5)], created_by: "claude" } as any);
    }
  });
  const links = Number(b.db.value("SELECT COUNT(*) FROM memory_relationships"));
  b.close();

  const [reopened, openMs] = await time(() => Brain.open({ dataDir: dir, role: "cli" }));
  b = reopened;
  b.registerIntelligenceJobs();
  const queries = Array.from({ length: 30 }, () => sentence(3));
  const searchT: number[] = [];
  for (const q of queries) searchT.push((await time(() => b.search.hybrid(q, {}, { limit: 10 })))[1]);
  const kwT: number[] = [];
  for (const q of queries) kwT.push((await time(() => b.search.keyword(q, 20)))[1]);
  const [, graphMs] = await time(() => b.graph({}));
  const [, pulseMs] = await time(() => pulse(b));
  const [, intelMs] = await time(() => intelligencePulse(b));
  const pathT: number[] = [];
  for (let i = 0; i < 10; i++) pathT.push((await time(() => b.mindTime.path(pick(ids), pick(ids))))[1]);
  const [, historyMs] = await time(() => b.mindTime.graphAt(new Date(Date.now() - 1000).toISOString()));
  // How long the engine is blocked at a time while each scan runs (it serves the app from the same process).
  const blocks: Record<string, number> = {};
  const timed = async (name: string, fn: () => Promise<unknown>) => {
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const [, t] = await time(fn);
    h.disable();
    blocks[name] = r1(h.max / 1e6);
    return t;
  };
  const awarenessMs = await timed("awareness_scan", () => b.awareness.scan({ as: "background" }));
  const healthMs = await timed("health_scan", () => b.health.scan({ as: "background" }));
  // Later, after a few edits: the possible-duplicates check only compares what changed.
  const editT: number[] = [];
  for (const id of ids.slice(0, 20)) editT.push((await time(() => b.store.updateMemory(id, { content: `${sentence(25)}. edited` }, user)))[1]);
  const healthIncMs = await timed("health_scan_after_20_edits", () => b.health.scan({ as: "background" }));
  const discoveryMs = await timed("discovery_scan", () => b.discovery.scan({ as: "background" }));
  const maxBlockMs = Math.max(...Object.values(blocks));
  const agentMs: Record<string, number> = {};
  for (const id of ["memory_curator", "project_analyst", "knowledge_connector", "research_analyst"]) {
    const [, t] = await time(async () => {
      const jid = b.agents.run(id as any, {});
      if (jid == null) return null;
      for (let i = 0; i < 50 && ["pending", "running"].includes(String(b.jobs.get(jid)!.status)); i++) await b.jobs.tick();
      return b.jobs.get(jid);
    });
    agentMs[id] = r1(t);
  }
  const rssMb = r1(process.memoryUsage().rss / 1048576);
  const dbMb = r1(fs.statSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".db")) ?? "moth.db")).size / 1048576);
  b.close();
  const mcpMs = await mcpStartup(dir);
  const cpu = await idleCpu(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  return {
    memories: n, projects: projects.length, connections: links,
    build_ms_per_memory: r1(buildMs / n),
    startup: { open_database_ms: r1(openMs), mcp_server_ready_ms: r1(mcpMs) },
    query_ms: { hybrid_search_p50: r1(pct(searchT, 50)), hybrid_search_p95: r1(pct(searchT, 95)), keyword_p50: r1(pct(kwT, 50)), keyword_p95: r1(pct(kwT, 95)), graph_load: r1(graphMs), pulse: r1(pulseMs), pulse_intelligence: r1(intelMs), mind_path_p95: r1(pct(pathT, 95)), mind_history: r1(historyMs), edit_memory_p50: r1(pct(editT, 50)), edit_memory_p95: r1(pct(editT, 95)) },
    job_ms: { longest_block_during_scans: maxBlockMs, longest_block_by_scan: blocks, awareness_scan: r1(awarenessMs), health_scan: r1(healthMs), health_scan_after_20_edits: r1(healthIncMs), discovery_scan: r1(discoveryMs), agents: agentMs },
    memory: { process_rss_mb: rssMb, database_mb: dbMb },
    idle_cpu_percent: cpu,
    first_background_round_ms: cpu === null ? null : backgroundSettleMs,
  };
}

const results = [];
for (const n of sizes) {
  const r = await run(n);
  console.log(JSON.stringify(r));
  results.push(r);
}
const env = { node: process.version, platform: `${process.platform} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, at: new Date().toISOString() };
if (out) fs.writeFileSync(out, JSON.stringify({ env, results }, null, 2));
console.log(JSON.stringify(env));
