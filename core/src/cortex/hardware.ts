// Best-effort hardware detection to recommend a model and runtime variant. Never assumes a GPU.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { MODELS, DEFAULT_MODEL_ID, type ModelEntry } from "./manifest.ts";

export interface Hardware {
  platform: string;
  arch: string;
  cpuModel: string;
  logicalCpus: number;
  totalRamGb: number;
  freeRamGb: number;
  freeDiskGb: number | null;
  gpus: { name: string; vramGb: number | null }[];
  gpuDetection: "ok" | "unavailable";
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

async function detectGpus(): Promise<{ gpus: Hardware["gpus"]; ok: boolean }> {
  try {
    if (process.platform === "win32") {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"]);
      if (!out.trim()) return { gpus: [], ok: false };
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return {
        ok: true,
        gpus: list
          .filter((g: any) => g?.Name && !/basic display|remote|virtual/i.test(g.Name))
          .map((g: any) => ({ name: String(g.Name), vramGb: g.AdapterRAM ? Math.round((Number(g.AdapterRAM) / 1024 ** 3) * 10) / 10 : null })),
      };
    }
    if (process.platform === "linux") {
      const nv = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
      if (nv.trim()) return { ok: true, gpus: nv.trim().split("\n").map((l) => { const [name, mem] = l.split(","); return { name: name.trim(), vramGb: Math.round(Number(mem) / 102.4) / 10 }; }) };
      const lspci = await run("lspci", []);
      if (!lspci) return { gpus: [], ok: false };
      return { ok: true, gpus: lspci.split("\n").filter((l) => /VGA|3D controller/i.test(l)).map((l) => ({ name: l.replace(/^.*?: /, "").trim(), vramGb: null })) };
    }
  } catch {
    /* fall through */
  }
  return { gpus: [], ok: false };
}

export async function detectHardware(dir: string): Promise<Hardware> {
  let freeDiskGb: number | null = null;
  try {
    const st = fs.statfsSync(dir);
    freeDiskGb = Math.round(((st.bavail * st.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    freeDiskGb = null;
  }
  const g = await detectGpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model?.trim() ?? "unknown",
    logicalCpus: os.availableParallelism?.() ?? os.cpus().length,
    totalRamGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeRamGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    freeDiskGb,
    gpus: g.gpus,
    gpuDetection: g.ok ? "ok" : "unavailable",
  };
}

export function recommendModel(hw: Pick<Hardware, "totalRamGb">): { model: ModelEntry; reason: string } {
  const apache = MODELS.filter((m) => m.license === "Apache-2.0");
  const fits = apache.filter((m) => m.minRamGb <= hw.totalRamGb).sort((a, b) => b.minRamGb - a.minRamGb);
  const pick = fits.find((m) => m.id === DEFAULT_MODEL_ID) ?? fits[0] ?? apache.sort((a, b) => a.minRamGb - b.minRamGb)[0];
  const reason =
    pick.id === DEFAULT_MODEL_ID
      ? `Your PC has ${hw.totalRamGb} GB of memory, enough for the recommended ${pick.parameters} model.`
      : `Your PC has ${hw.totalRamGb} GB of memory, so the smaller ${pick.parameters} model keeps MOTH responsive.`;
  return { model: pick, reason };
}

export function defaultThreads(): number {
  const n = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, Math.min(8, n - 1 || 1));
}
