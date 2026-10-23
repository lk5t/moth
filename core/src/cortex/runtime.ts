// Managed llama.cpp runtime: starts `llama-server` only when an AI task arrives, keeps it warm
// briefly, unloads it after an idle timeout, recovers from crashes and cleans up on exit.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { log } from "../logger.ts";

export type RuntimeState = "unloaded" | "starting" | "ready" | "busy" | "stopping" | "error";

export interface RuntimeConfig {
  serverPath: string; // llama-server(.exe)
  modelPath: string;
  modelId: string;
  contextSize: number;
  threads: number;
  gpuLayers: number;
  idleTimeoutMs: number;
  startupTimeoutMs?: number;
  stateFile?: string; // pid/port record for orphan cleanup after a crash
  extraArgs?: string[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  ms: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlamaRuntime {
  state: RuntimeState = "unloaded";
  lastError: string | null = null;
  loadedModelId: string | null = null;
  loadedAt: number | null = null;
  lastUsedAt: number | null = null;
  current: { label: string; startedAt: number } | null = null;
  stats = { requests: 0, failures: 0, crashes: 0, loads: 0 };
  private child: ChildProcess | null = null;
  private port = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private consecutiveCrashes = 0;
  private expectedExit = false;
  private recentLog: string[] = [];
  onChange?: () => void;

  constructor(private cfg: RuntimeConfig) {}

  configure(cfg: Partial<RuntimeConfig>): void {
    const modelChanged = (cfg.modelPath && cfg.modelPath !== this.cfg.modelPath) || (cfg.serverPath && cfg.serverPath !== this.cfg.serverPath);
    this.cfg = { ...this.cfg, ...cfg };
    if (modelChanged && this.child) void this.unload("model or runtime changed");
    else this.armIdle();
  }

  get config(): RuntimeConfig {
    return this.cfg;
  }

  info() {
    return {
      state: this.state,
      model: this.loadedModelId,
      pid: this.child?.pid ?? null,
      port: this.child ? this.port : null,
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      lastUsedAt: this.lastUsedAt ? new Date(this.lastUsedAt).toISOString() : null,
      idleUnloadAt: this.state === "ready" && this.lastUsedAt ? new Date(this.lastUsedAt + this.cfg.idleTimeoutMs).toISOString() : null,
      current: this.current,
      pending: this.pending,
      lastError: this.lastError,
      stats: this.stats,
      recentLog: this.recentLog.slice(-12),
    };
  }

  private set(s: RuntimeState) {
    this.state = s;
    this.onChange?.();
  }

  /** Kills a llama-server left behind by a previous MOTH process that crashed. */
  static async cleanupOrphan(stateFile: string): Promise<boolean> {
    if (!fs.existsSync(stateFile)) return false;
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      fs.rmSync(stateFile, { force: true });
      if (!st.pid || !st.port) return false;
      try {
        process.kill(st.pid, 0);
      } catch {
        return false;
      }
      // Only kill it if it really is our llama-server answering on the recorded port.
      const r = await fetch(`http://127.0.0.1:${st.port}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (!r) return false;
      process.kill(st.pid);
      log.warn(`Stopped an orphaned llama-server (pid ${st.pid}) from a previous session`);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<void> {
    if (this.state === "ready" || this.state === "busy") return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    const { serverPath, modelPath } = this.cfg;
    if (!fs.existsSync(serverPath)) throw new Error("The local AI runtime is not installed.");
    if (!fs.existsSync(modelPath)) throw new Error("The selected model is not installed.");
    this.set("starting");
    this.lastError = null;
    this.port = await freePort();
    const args = [
      "-m", modelPath,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "-c", String(this.cfg.contextSize),
      "-t", String(this.cfg.threads),
      "-ngl", String(this.cfg.gpuLayers),
      "-np", "1",
      ...(this.cfg.extraArgs ?? []),
    ];
    const dir = path.dirname(serverPath);
    const env = { ...process.env };
    if (process.platform !== "win32") env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    this.expectedExit = false;
    // A .js/.mjs "server" is only used by MOTH's mocked lifecycle tests (run with Node).
    const isScript = /\.(c|m)?js$/.test(serverPath);
    const child = spawn(isScript ? process.execPath : serverPath, isScript ? [serverPath, ...args] : args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const capture = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.recentLog.push(line.slice(0, 300));
      if (this.recentLog.length > 200) this.recentLog.splice(0, this.recentLog.length - 200);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    if (this.cfg.stateFile) fs.writeFileSync(this.cfg.stateFile, JSON.stringify({ pid: child.pid, port: this.port, started: new Date().toISOString() }));
    let exited = false;
    child.on("exit", (code, signal) => {
      exited = true;
      this.child = null;
      if (this.cfg.stateFile) fs.rmSync(this.cfg.stateFile, { force: true });
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (!this.expectedExit) {
        this.stats.crashes++;
        this.consecutiveCrashes++;
        this.lastError = `The local AI runtime stopped unexpectedly (${signal ?? `exit code ${code}`}). ${this.recentLog.slice(-2).join(" ")}`.trim();
        log.error(this.lastError);
        this.set("error");
      } else this.set("unloaded");
      this.loadedModelId = null;
      this.loadedAt = null;
    });
    child.on("error", (e) => {
      this.lastError = `Could not start the local AI runtime: ${e.message}`;
    });

    const deadline = Date.now() + (this.cfg.startupTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (exited) throw new Error(this.lastError ?? "The local AI runtime exited during start-up.");
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          this.loadedModelId = this.cfg.modelId;
          this.loadedAt = Date.now();
          this.lastUsedAt = Date.now();
          this.stats.loads++;
          this.consecutiveCrashes = 0;
          this.set("ready");
          this.armIdle();
          log.info(`Local model ${this.cfg.modelId} loaded (pid ${child.pid}, port ${this.port})`);
          return;
        }
      } catch {
        /* still loading */
      }
      await sleep(300);
    }
    await this.unload("start-up timed out");
    throw new Error("The local model took too long to load.");
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.child || this.pending > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending === 0 && this.state === "ready") void this.unload("idle timeout");
    }, Math.max(1000, this.cfg.idleTimeoutMs));
  }

  async unload(reason = "requested"): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) {
      if (this.state !== "error") this.set("unloaded");
      return;
    }
    this.expectedExit = true;
    this.set("stopping");
    log.info(`Unloading local model (${reason})`);
    const done = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill();
    await Promise.race([done, sleep(5000)]);
    if (this.child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      this.child = null;
      this.set("unloaded");
    }
  }

  /** Synchronous best-effort kill for process shutdown paths. */
  killNow(): void {
    this.expectedExit = true;
    try {
      this.child?.kill();
    } catch {
      /* gone */
    }
    if (this.cfg.stateFile) fs.rmSync(this.cfg.stateFile, { force: true });
  }

  /** Runs one chat completion. Requests are serialised; the model is loaded on demand. */
  complete(messages: ChatMessage[], opts: { jsonSchema?: object; maxTokens?: number; temperature?: number; signal?: AbortSignal; label?: string } = {}): Promise<CompletionResult> {
    this.pending++;
    this.onChange?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const run = async (): Promise<CompletionResult> => {
      if (opts.signal?.aborted) throw new Error("Cancelled");
      if (this.state === "error" && this.consecutiveCrashes >= 3) throw new Error(`Local AI stopped after repeated crashes. ${this.lastError ?? ""} Use “Load model” on the Cortex page to try again.`);
      await this.load();
      this.set("busy");
      this.current = { label: opts.label ?? "inference", startedAt: Date.now() };
      const started = Date.now();
      try {
        const body: Record<string, unknown> = {
          messages,
          temperature: opts.temperature ?? 0.1,
          max_tokens: opts.maxTokens ?? 700,
          cache_prompt: true,
          stream: false,
        };
        if (opts.jsonSchema) body.response_format = { type: "json_schema", json_schema: { name: "moth_response", strict: true, schema: opts.jsonSchema } };
        const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Local model error ${res.status}: ${text.slice(0, 200)}`);
        const json = JSON.parse(text);
        this.stats.requests++;
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          promptTokens: json.usage?.prompt_tokens ?? null,
          completionTokens: json.usage?.completion_tokens ?? null,
          ms: Date.now() - started,
        };
      } catch (e) {
        this.stats.failures++;
        throw e;
      } finally {
        this.current = null;
        this.lastUsedAt = Date.now();
        if (this.child && this.state === "busy") this.set("ready");
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p.finally(() => {
      this.pending--;
      this.armIdle();
      this.onChange?.();
    });
  }
}
