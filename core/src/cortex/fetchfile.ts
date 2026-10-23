// Resumable HTTPS download with streaming SHA-256 verification, progress and cancellation,
// plus dependency-free .zip and .tar.gz extraction with path-traversal protection.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface Progress {
  received: number;
  total: number;
  bytesPerSec: number;
}

export async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve()).on("error", reject);
  });
  return h.digest("hex");
}

/**
 * Downloads `url` to `dest`. Partial data is kept in `dest.part` and resumed with an HTTP Range
 * request. The final file only appears at `dest` after its SHA-256 matches `sha256`.
 */
export async function download(url: string, dest: string, opts: { sha256: string; size?: number; signal?: AbortSignal; onProgress?: (p: Progress) => void }): Promise<{ path: string; sha256: string; bytes: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const h = await hashFile(dest);
    if (h === opts.sha256) return { path: dest, sha256: h, bytes: fs.statSync(dest).size };
    fs.rmSync(dest);
  }
  const part = `${dest}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (opts.size && have > opts.size) {
    fs.rmSync(part);
    have = 0;
  }
  const hash = crypto.createHash("sha256");
  if (have > 0) {
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(part).on("data", (c) => hash.update(c)).on("end", () => resolve()).on("error", reject);
    });
  }
  const res = await fetch(url, { headers: have > 0 ? { range: `bytes=${have}-` } : {}, signal: opts.signal, redirect: "follow" });
  if (res.status === 416 && opts.size && have === opts.size) {
    // already complete
  } else if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed: HTTP ${res.status} from ${new URL(url).host}`);
  }
  if (res.status === 200 && have > 0) {
    // Server ignored the range request: start over.
    have = 0;
    hash.update(Buffer.alloc(0));
    fs.rmSync(part, { force: true });
    return download(url, dest, opts);
  }
  const total = opts.size ?? (Number(res.headers.get("content-length") ?? 0) + have);
  const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
  let received = have;
  const started = Date.now();
  let lastReport = 0;
  try {
    if (res.body && res.status !== 416) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise((r) => out.once("drain", r));
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          opts.onProgress?.({ received, total, bytesPerSec: ((received - have) / Math.max(1, now - started)) * 1000 });
        }
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  opts.onProgress?.({ received, total, bytesPerSec: 0 });
  const digest = hash.digest("hex");
  if (digest !== opts.sha256.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error(`Integrity check failed for ${path.basename(dest)}: expected SHA-256 ${opts.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…. The file was deleted.`);
  }
  fs.renameSync(part, dest);
  return { path: dest, sha256: digest, bytes: received };
}

function safeJoin(root: string, name: string): string | null {
  const clean = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").includes("..")) return null;
  const full = path.resolve(root, clean);
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) return null;
  return full;
}

/** Minimal ZIP reader (stored + deflate), using the central directory. */
export function extractZip(file: string, destDir: string): string[] {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const written: string[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;
    const target = safeJoin(destDir, name);
    if (!target) continue;
    if (name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);
    const content = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!content) throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(target);
  }
  return written;
}

/** Minimal tar.gz reader (regular files, directories, symlinks inside the archive root). */
export function extractTarGz(file: string, destDir: string): string[] {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const written: string[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s: number, l: number) => header.subarray(s, s + l).toString("utf8").replace(/\0.*$/s, "");
    let name = longName ?? str(0, 100);
    longName = null;
    const prefix = str(345, 155);
    if (prefix && !name.startsWith(prefix)) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const mode = parseInt(str(100, 8).trim() || "644", 8);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const target = safeJoin(destDir, name);
    if (!target) continue;
    if (type === "5") fs.mkdirSync(target, { recursive: true });
    else if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { mode: mode & 0o777 });
      written.push(target);
    } else if (type === "2") {
      const linkTarget = str(157, 100);
      const resolved = safeJoin(path.dirname(target), linkTarget);
      if (resolved && resolved.startsWith(path.resolve(destDir))) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.rmSync(target, { force: true });
          fs.symlinkSync(linkTarget, target);
        } catch {
          /* symlinks may be unavailable; the real files are also present */
        }
      }
    }
  }
  return written;
}

export function findFile(root: string, names: string[]): string | null {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (names.includes(e.name)) return p;
    }
  }
  return null;
}
