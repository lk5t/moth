// Publishes the real-AI evidence file as GitHub annotations (one per step).
import fs from "node:fs";
const file = process.argv[2];
if (!fs.existsSync(file)) {
  console.log("::warning title=Real AI evidence::no evidence file was written");
  process.exit(0);
}
const e = JSON.parse(fs.readFileSync(file, "utf8"));
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
console.log(`::notice title=Real AI ${e.platform} ${e.result ?? "FAIL"}::${esc(`model ${e.model}, ${e.cpu} x${e.cpus}, ${e.ram_gb} GB RAM, ${e.started} → ${e.finished ?? "unfinished"}`)}`);
for (const s of e.steps.slice(0, 9)) console.log(`::notice title=Real AI ${e.platform} / ${s.name}::${esc(JSON.stringify(s.data).slice(0, 3500))}`);
