// Builds dist/moth-core(.exe): a Node.js Single Executable Application containing the bundled engine,
// then copies it to src-tauri/binaries with the target-triple suffix Tauri expects for sidecars.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { inject } from "postject";

const win = process.platform === "win32";
const triple = process.env.TAURI_TARGET_TRIPLE || (win ? "x86_64-pc-windows-msvc" : process.platform === "darwin" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/sea-config.json", JSON.stringify({ main: "dist/moth-core.cjs", output: "dist/sea-prep.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(process.execPath, ["--experimental-sea-config", "dist/sea-config.json"], { stdio: "inherit" });
const exe = path.join("dist", win ? "moth-core.exe" : "moth-core");
fs.copyFileSync(process.execPath, exe);
if (win) {
  try {
    execFileSync("signtool", ["remove", "/s", exe], { stdio: "ignore" });
  } catch {
    /* signtool not installed: injecting into a signed binary still works, the signature is just invalid */
  }
}
await inject(exe, "NODE_SEA_BLOB", fs.readFileSync("dist/sea-prep.blob"), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
const dest = path.join("..", "src-tauri", "binaries", `moth-core-${triple}${win ? ".exe" : ""}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(exe, dest);
if (!win) fs.chmodSync(dest, 0o755);
console.log(`sidecar ready: ${dest} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
