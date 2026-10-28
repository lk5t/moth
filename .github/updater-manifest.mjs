// Verifies the signed updater artifact produced by `tauri build` and writes the update manifest (latest.json).
//
//   node .github/updater-manifest.mjs <bundle dir> <version> <release notes file> <out dir>
//
// The signature is checked here with the PUBLIC key from tauri.conf.json, exactly like the installed app will check
// it (minisign / Ed25519, BLAKE2b-512 prehash, plus the trusted-comment global signature). A tampered copy of the
// installer must fail the same check (proves the check rejects bad files). The manifest is written only if every
// check passes; any failure exits non-zero so nothing is published.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [bundleDir, version, notesFile, outDir] = process.argv.slice(2);
const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const pubkeyB64 = conf.plugins?.updater?.pubkey;
if (!pubkeyB64) throw new Error("No updater public key in tauri.conf.json");

function parseBox(b64) {
  const text = Buffer.from(b64.trim(), "base64").toString("utf8").replace(/\r/g, "");
  return text.split("\n").filter((l) => l.length);
}
const pkLines = parseBox(pubkeyB64);
const pkRaw = Buffer.from(pkLines[1], "base64");
if (pkRaw.length !== 42 || pkRaw.subarray(0, 2).toString() !== "Ed") throw new Error("Unexpected public key format");
const keyId = pkRaw.subarray(2, 10);
const pubKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pkRaw.subarray(10)]), format: "der", type: "spki" });

export function verify(file, sigB64) {
  const lines = parseBox(sigB64);
  const sig = Buffer.from(lines[1], "base64");
  const trusted = lines[2].replace(/^trusted comment: /, "");
  const globalSig = Buffer.from(lines[3], "base64");
  const alg = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(keyId)) return { ok: false, why: "signed with a different key" };
  const data = fs.readFileSync(file);
  const msg = alg === "ED" ? crypto.createHash("blake2b512").update(data).digest() : data;
  if (!crypto.verify(null, msg, pubKey, sig.subarray(10, 74))) return { ok: false, why: "file signature does not match" };
  if (!crypto.verify(null, Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted)]), pubKey, globalSig)) return { ok: false, why: "trusted comment signature does not match" };
  return { ok: true, alg, trusted };
}

const exe = fs.readdirSync(bundleDir).find((f) => f.endsWith("-setup.exe"));
if (!exe) throw new Error(`No NSIS installer in ${bundleDir}`);
const sigFile = path.join(bundleDir, `${exe}.sig`);
if (!fs.existsSync(sigFile)) {
  console.log(`::warning title=Updater::No signature next to ${exe}. The signing key secret (TAURI_SIGNING_PRIVATE_KEY) is not set, so no update manifest is written.`);
  process.exit(0);
}
const sigB64 = fs.readFileSync(sigFile, "utf8");
const good = verify(path.join(bundleDir, exe), sigB64);
if (!good.ok) throw new Error(`Signature check FAILED for ${exe}: ${good.why}`);
// Negative check: one changed byte must be rejected.
const tampered = path.join(outDir, "tampered.exe");
fs.mkdirSync(outDir, { recursive: true });
const bytes = fs.readFileSync(path.join(bundleDir, exe));
bytes[Math.floor(bytes.length / 2)] ^= 0xff;
fs.writeFileSync(tampered, bytes);
const bad = verify(tampered, sigB64);
fs.rmSync(tampered);
if (bad.ok) throw new Error("A tampered installer passed the signature check: refusing to publish");

const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").replace(/\*\*/g, "").slice(0, 3000) : "";
const url = `https://github.com/lk5t/moth/releases/download/v${version}/${exe}`;
const platform = { signature: sigB64.trim(), url };
const manifest = { version, notes, pub_date: new Date().toISOString(), platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform } };
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(manifest, null, 2));
console.log(`::notice title=Updater manifest::Signature of ${exe} verified with the app's public key (${good.alg}, ${good.trusted}); a tampered copy was rejected; latest.json written for ${version} → ${url}`);
