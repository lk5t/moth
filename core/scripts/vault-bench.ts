// Large-vault import benchmark: generates a synthetic Obsidian vault on disk, scans and imports it through the real
// engine (same code paths as the app), and reports measured numbers only.
//
//   node --experimental-transform-types scripts/vault-bench.ts <notes> <attachment MB> [--out file.json] [--keep]
//
// Measures: scan time, import time, peak process memory (sampled every 100 ms), longest pause of the engine's event
// loop (how responsive the app stays), database size, search latency after the import, and that the source vault is
// unchanged (size + modification time of every file, plus the content hash of every note).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Brain } from "../src/engine/brain.ts";

const args = process.argv.slice(2);
const notes = Number(args[0] ?? 5000);
const attachMb = Number(args[1] ?? 200);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const keep = args.includes("--keep");
process.env.MOTH_LOG_STDERR = "0";

let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const VOCAB = Array.from({ length: 6000 }, (_, i) => `w${i.toString(36)}${"aeiou"[i % 5]}`);
const word = () => VOCAB[Math.floor(Math.pow(rnd(), 2.2) * VOCAB.length)];
const sentence = (n: number) => Array.from({ length: n }, word).join(" ");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "moth-vault-bench-"));
const vault = path.join(base, "Synthetic Vault");
const t0 = Date.now();
// ---- generate
const folders = Math.max(5, Math.round(Math.sqrt(notes)));
for (let i = 0; i < notes; i++) {
  const dir = path.join(vault, `Area ${i % 9}`, `Topic ${i % folders}`);
  fs.mkdirSync(dir, { recursive: true });
  const links = Array.from({ length: 1 + (i % 4) }, () => `[[Note ${Math.floor(rnd() * notes)}]]`).join(" ");
  const body = `---\ntags: [t${i % 40}, area/${i % 9}]\n${i % 50 === 0 ? `aliases: [Alias ${i}]\n` : ""}---\n# Note ${i}\n${sentence(60)}\n\n${links}\n\n${sentence(120)}${i % 97 === 0 ? `\n![[img ${i % 200}.png]]` : ""}`;
  fs.writeFileSync(path.join(dir, `Note ${i}.md`), body);
}
const attachDir = path.join(vault, "Attachments");
fs.mkdirSync(attachDir, { recursive: true });
let attachBytes = 0;
const files = Math.max(1, Math.round(attachMb / 4));
const chunk = 1024 * 1024;
for (let i = 0; i < files && attachMb > 0; i++) {
  const size = Math.round((attachMb * 1024 * 1024) / files);
  const fd = fs.openSync(path.join(attachDir, i < 200 ? `img ${i}.png` : `file ${i}.pdf`), "w");
  for (let w = 0; w < size; w += chunk) fs.writeSync(fd, crypto.randomBytes(Math.min(chunk, size - w)));
  fs.closeSync(fd);
  attachBytes += size;
}
const genMs = Date.now() - t0;

function sourceState(): string {
  const h = crypto.createHash("sha256");
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(vault, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else {
        const st = fs.statSync(path.join(vault, r));
        h.update(`${r}:${st.size}:${st.mtimeMs}`);
        if (r.endsWith(".md")) h.update(fs.readFileSync(path.join(vault, r)));
      }
    }
  };
  walk("");
  return h.digest("hex");
}
const before = sourceState();

// ---- import through the engine
const dataDir = path.join(base, "moth-data");
const b = Brain.open({ dataDir, role: "cli" });
b.importer.registerJobs();
let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 100);
const lag = monitorEventLoopDelay({ resolution: 5 });
lag.enable();
const tick = async (id: string, statuses: string[]) => {
  for (;;) {
    const s = String(b.importer.batch(id).status);
    if (statuses.includes(s)) return b.importer.batch(id);
    await b.jobs.tick();
  }
};
const s0 = Date.now();
const imp = b.importer.startScan(vault);
const scanned = await tick(imp.id as string, ["scanned", "failed"]);
const scanMs = Date.now() - s0;
const i0 = Date.now();
b.importer.start(imp.id as string, {});
const done = await tick(imp.id as string, ["done", "failed"]);
const importMs = Date.now() - i0;
lag.disable();
clearInterval(sampler);
const searchT: number[] = [];
for (let i = 0; i < 20; i++) {
  const q = sentence(2);
  const t = process.hrtime.bigint();
  b.library.list({ q, limit: 50 });
  searchT.push(Number(process.hrtime.bigint() - t) / 1e6);
}
searchT.sort((x, y) => x - y);
const dbFile = path.join(dataDir, fs.readdirSync(dataDir).find((f) => f.endsWith(".db"))!);
const attDir = b.library.attachmentDir();
let storedBytes = 0;
const walkSize = (d: string) => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walkSize(path.join(d, e.name)) : (storedBytes += fs.statSync(path.join(d, e.name)).size);
};
walkSize(attDir);
b.close();
const after = sourceState();
const r = {
  vault: { notes, folders: folders * 9, attachment_files: attachMb > 0 ? files : 0, attachment_bytes: attachBytes, generate_ms: genMs },
  scan: { ms: scanMs, status: scanned.status, notes: (scanned.scan as any).notes, links: (scanned.scan as any).links, unresolved: (scanned.scan as any).unresolved_links },
  import: { ms: importMs, status: done.status, result: done.result, error: done.error ?? null },
  peak_rss_mb: Math.round(peakRss / 1048576),
  longest_event_loop_block_ms: Math.round(lag.max / 1e6),
  database_mb: Math.round(fs.statSync(dbFile).size / 1048576),
  attachments_stored_mb: Math.round(storedBytes / 1048576),
  search_ms: { p50: Math.round(searchT[10] * 10) / 10, p95: Math.round(searchT[19] * 10) / 10 },
  source_unchanged: before === after,
  env: { node: process.version, platform: `${process.platform} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 1e9) },
};
console.log(JSON.stringify(r, null, 1));
if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
if (!keep) fs.rmSync(base, { recursive: true, force: true });
