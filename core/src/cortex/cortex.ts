// MOTH Cortex: local intelligence for the memory system.
// Understand → Recall → Compare → Propose (model) → Validate (deterministic) → Commit or Review.
import fs from "node:fs";
import path from "node:path";
import type { Row } from "../db/database.ts";
import { nowIso } from "../db/database.ts";
import type { Brain } from "../engine/brain.ts";
import { localEmbed, cosine } from "../engine/embeddings.ts";
import { redactSecrets } from "../engine/security.ts";
import { safeJson } from "../engine/store.ts";
import { stripControl, truncate, normalizeWhitespace } from "../engine/text.ts";
import { MothError, type Category, type ChangeContext, type Memory, type RelationType } from "../engine/types.ts";
import { log } from "../logger.ts";
import { download, extractTarGz, extractZip, findFile, hashFile } from "./fetchfile.ts";
import { defaultThreads, detectHardware, recommendModel, type Hardware } from "./hardware.ts";
import { DEFAULT_MODEL_ID, findModel, MODELS, RUNTIMES, runtimeFor, type ModelEntry, type RuntimeBuild } from "./manifest.ts";
import { COMPARE_SCHEMA, COMPARE_SYSTEM, CONTEXT_SCHEMA, CONTEXT_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, type Comparison, type Extraction } from "./prompts.ts";
import { AnthropicCloudProvider, IntelligenceRouter, LocalModelProvider } from "./providers.ts";
import { LlamaRuntime } from "./runtime.ts";
import { validateProposal, type Autonomy, type Candidate, type Decision } from "./validator.ts";

export interface LearnInput {
  text: string;
  source?: string;
  source_ref?: string | null;
  project?: string | null;
  task_id?: string | null;
  analyze_only?: boolean;
}

export interface StatementOutcome {
  statement: string;
  kind: string;
  relation: string | null;
  proposed_operation: string | null;
  action: "applied" | "queued_for_review" | "rejected" | "proposed" | "failed";
  target: { id: string; title: string } | null;
  memory_id: string | null;
  review_id: number | null;
  reason: string;
  checks: string[];
  confidence: number | null;
  provider: string | null;
  model: string | null;
  error?: string;
}

export interface LearnReport {
  statements: StatementOutcome[];
  applied: number;
  queued: number;
  rejected: number;
  project: { id: string; name: string } | null;
  providers: string[];
  ms: number;
  note?: string;
}

const KIND_TO_CATEGORY: Record<string, Category> = {
  fact: "fact", decision: "decision", change: "fact", task: "task", idea: "idea", preference: "preference", error: "error", solution: "solution",
};

interface InstallState {
  phase: "idle" | "downloading_runtime" | "extracting" | "downloading_model" | "verifying" | "done" | "error" | "cancelled";
  component: string | null;
  received: number;
  total: number;
  bytesPerSec: number;
  error: string | null;
  startedAt: string | null;
  modelId: string | null;
}

export class Cortex {
  private rt: LlamaRuntime | null = null;
  readonly router: IntelligenceRouter;
  private install: InstallState = { phase: "idle", component: null, received: 0, total: 0, bytesPerSec: 0, error: null, startedAt: null, modelId: null };
  private installCtl: AbortController | null = null;
  private hw: Hardware | null = null;
  readonly dir: string;

  constructor(private brain: Brain) {
    this.dir = path.join(brain.paths.base, "ai");
    const local = new LocalModelProvider(
      () => this.runtime(),
      () => (brain.role === "mcp" || brain.role === "cli" ? { ok: false, reason: "Local inference runs in the MOTH desktop app" } : this.readiness()),
    );
    const cloud = new AnthropicCloudProvider(brain.ai, brain.store);
    this.router = new IntelligenceRouter(local, cloud, brain.store);
  }

  private get s() {
    return this.brain.settings;
  }

  // ------------------------------------------------------------------ components
  installedComponents(): Row[] {
    return this.brain.db.all<Row>("SELECT * FROM ai_components ORDER BY installed_at DESC").filter((c) => fs.existsSync(c.path as string));
  }

  private runtimeBuild(): RuntimeBuild | undefined {
    return runtimeFor(this.s.get("cortex.runtimeVariant"));
  }

  serverPath(): string | null {
    if (process.env.MOTH_LLAMA_SERVER) return process.env.MOTH_LLAMA_SERVER;
    const b = this.runtimeBuild();
    if (!b) return null;
    const row = this.brain.db.get<Row>("SELECT * FROM ai_components WHERE id = ?", [b.id]);
    if (!row || !fs.existsSync(row.path as string)) return null;
    return row.path as string;
  }

  selectedModel(): { entry: ModelEntry | null; id: string; path: string | null } {
    const id = this.s.get("cortex.modelId") || (this.brain.db.value<string>("SELECT id FROM ai_components WHERE kind = 'model' ORDER BY installed_at DESC") ?? DEFAULT_MODEL_ID);
    if (process.env.MOTH_MODEL_PATH) return { entry: findModel(id) ?? null, id: process.env.MOTH_MODEL_ID || path.basename(process.env.MOTH_MODEL_PATH), path: process.env.MOTH_MODEL_PATH };
    const row = this.brain.db.get<Row>("SELECT * FROM ai_components WHERE id = ? AND kind = 'model'", [id]);
    return { entry: findModel(id) ?? null, id, path: row && fs.existsSync(row.path as string) ? (row.path as string) : null };
  }

  readiness(): { ok: boolean; reason?: string } {
    if (!this.s.get("cortex.enabled")) return { ok: false, reason: "Cortex is turned off" };
    if (this.s.get("cortex.paused")) return { ok: false, reason: "Intelligence is paused" };
    if (!this.serverPath()) return { ok: false, reason: "The local AI runtime is not installed" };
    if (!this.selectedModel().path) return { ok: false, reason: "No local model is installed" };
    return { ok: true };
  }

  /** The managed runtime exists only in the desktop app's engine process (never in MCP processes). */
  runtime(): LlamaRuntime | null {
    if (this.brain.role === "mcp" || this.brain.role === "cli") return null;
    const server = this.serverPath();
    const model = this.selectedModel();
    if (!server || !model.path) return this.rt;
    const variant = this.s.get("cortex.runtimeVariant");
    const cfg = {
      serverPath: server,
      modelPath: model.path,
      modelId: model.id,
      contextSize: this.s.get("cortex.contextSize"),
      threads: this.s.get("cortex.threads") || defaultThreads(),
      gpuLayers: variant === "vulkan" ? (this.s.get("cortex.gpuLayers") || 99) : 0,
      idleTimeoutMs: this.effectiveIdleMs(),
      stateFile: path.join(this.dir, "runtime-state.json"),
    };
    if (!this.rt) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.rt = new LlamaRuntime(cfg);
      const statusFile = path.join(this.dir, "runtime-status.json");
      let lastState = "unloaded";
      this.rt.onChange = () => {
        try {
          const info = this.rt!.info();
          if (info.state !== lastState) {
            if (info.state === "ready") this.brain.store.logActivity({ kind: "cortex", source: "cortex", action: "load", detail: { model: info.model } });
            if (lastState === "ready" && info.state === "unloaded") this.brain.store.logActivity({ kind: "cortex", source: "cortex", action: "unload", detail: { model: info.model } });
            lastState = info.state;
          }
          this.brain.db.run("INSERT INTO db_changes(entity, entity_id, op) VALUES ('cortex', 'runtime', 'update')");
          // Lets other MOTH processes (e.g. the MCP server Claude launches) report the live runtime state.
          fs.writeFileSync(statusFile, JSON.stringify({ ...this.rt!.info(), recentLog: undefined, written_at: nowIso(), pid_owner: process.pid }));
        } catch {
          /* status is best-effort */
        }
      };
    } else this.rt.configure(cfg);
    return this.rt;
  }

  /** Idle unload delay after applying the resource profile (Eco unloads sooner, Performance keeps the model longer). */
  effectiveIdleMs(): number {
    const base = Math.max(0.05, this.s.get("cortex.idleTimeoutMin"));
    const profile = this.s.get("resources.profile");
    const min = profile === "eco" ? Math.min(base, 2) : profile === "performance" ? Math.max(base, 15) : base;
    return min * 60_000;
  }

  async hardware(refresh = false): Promise<Hardware> {
    if (!this.hw || refresh) this.hw = await detectHardware(this.brain.paths.base);
    return this.hw;
  }

  // ------------------------------------------------------------------ installation (explicit consent)
  async installPlan(modelId?: string) {
    const hw = await this.hardware();
    const rec = recommendModel(hw);
    const model = (modelId ? findModel(modelId) : null) ?? rec.model;
    const runtime = this.runtimeBuild();
    const haveRuntime = !!this.serverPath();
    const haveModel = !!this.brain.db.get("SELECT 1 FROM ai_components WHERE id = ?", [model.id]);
    const downloadBytes = (haveRuntime ? 0 : runtime?.size ?? 0) + (haveModel ? 0 : model.size);
    return {
      hardware: hw,
      recommended: { id: rec.model.id, reason: rec.reason },
      model,
      runtime: runtime ?? null,
      runtimeSupported: !!runtime,
      needs: { runtime: !haveRuntime, model: !haveModel },
      downloadBytes,
      diskNeededBytes: downloadBytes * 2,
      enoughDisk: hw.freeDiskGb === null ? null : hw.freeDiskGb * 1024 ** 3 > downloadBytes * 2,
      enoughRam: hw.totalRamGb >= model.minRamGb,
      models: MODELS.map((m) => ({ ...m, installed: !!this.brain.db.get("SELECT 1 FROM ai_components WHERE id = ?", [m.id]), fits: hw.totalRamGb >= m.minRamGb })),
      runtimes: RUNTIMES.filter((r) => r.platform === process.platform),
    };
  }

  installStatus(): InstallState {
    return { ...this.install };
  }

  /** Downloads + verifies the runtime and model. Requires explicit consent from the user. */
  startInstall(modelId: string, consent: boolean): InstallState {
    if (!consent) throw new MothError("consent_required", "Downloading a model needs your explicit approval.");
    const model = findModel(modelId);
    if (!model) throw new MothError("invalid_input", `Unknown model ${modelId}`);
    const runtime = this.runtimeBuild();
    if (!runtime) throw new MothError("unsupported", `No local AI runtime is available for ${process.platform}.`);
    if (["downloading_runtime", "extracting", "downloading_model", "verifying"].includes(this.install.phase)) throw new MothError("busy", "An installation is already running.");
    this.installCtl = new AbortController();
    const signal = this.installCtl.signal;
    this.install = { phase: "downloading_runtime", component: runtime.id, received: 0, total: runtime.size, bytesPerSec: 0, error: null, startedAt: nowIso(), modelId };
    const ping = () => this.brain.db.run("INSERT INTO db_changes(entity, entity_id, op) VALUES ('cortex', 'install', 'update')");
    let lastPing = 0;
    const progress = (p: { received: number; total: number; bytesPerSec: number }) => {
      this.install = { ...this.install, received: p.received, total: p.total, bytesPerSec: p.bytesPerSec };
      if (Date.now() - lastPing > 1000) (lastPing = Date.now()), ping();
    };
    void (async () => {
      try {
        if (!this.serverPath()) {
          const archive = path.join(this.dir, "downloads", path.basename(new URL(runtime.url).pathname));
          await download(runtime.url, archive, { sha256: runtime.sha256, size: runtime.size, signal, onProgress: progress });
          this.install = { ...this.install, phase: "extracting" };
          ping();
          const dest = path.join(this.dir, "runtime", runtime.id);
          fs.rmSync(dest, { recursive: true, force: true });
          fs.mkdirSync(dest, { recursive: true });
          if (runtime.archive === "zip") extractZip(archive, dest);
          else extractTarGz(archive, dest);
          const server = findFile(dest, [process.platform === "win32" ? "llama-server.exe" : "llama-server"]);
          if (!server) throw new Error("llama-server was not found in the downloaded runtime");
          if (process.platform !== "win32") fs.chmodSync(server, 0o755);
          this.brain.db.run("INSERT OR REPLACE INTO ai_components(id, kind, version, path, sha256, size, verified, installed_at) VALUES (?,?,?,?,?,?,1,?)", [runtime.id, "runtime", runtime.version, server, runtime.sha256, runtime.size, nowIso()]);
          fs.rmSync(archive, { force: true });
        }
        if (!this.brain.db.get("SELECT 1 FROM ai_components WHERE id = ?", [model.id])) {
          this.install = { ...this.install, phase: "downloading_model", component: model.id, received: 0, total: model.size };
          ping();
          const dest = path.join(this.dir, "models", model.file);
          await download(model.url, dest, { sha256: model.sha256, size: model.size, signal, onProgress: progress });
          this.install = { ...this.install, phase: "verifying" };
          this.brain.db.run("INSERT OR REPLACE INTO ai_components(id, kind, version, path, sha256, size, verified, installed_at) VALUES (?,?,?,?,?,?,1,?)", [model.id, "model", `${model.family} ${model.parameters} ${model.quantization}`, dest, model.sha256, model.size, nowIso()]);
        }
        if (!this.s.get("cortex.modelId")) this.s.set("cortex.modelId", model.id);
        this.install = { ...this.install, phase: "done", received: this.install.total };
        this.brain.store.logActivity({ kind: "cortex", source: "cortex", action: "install", detail: { model: model.id, runtime: runtime.id } });
        this.brain.notify("important", "MOTH's brain is installed", `${model.family} ${model.parameters} is ready and verified. It runs only on this PC.`, "install-done");
      } catch (e) {
        const msg = (e as Error).name === "AbortError" || signal.aborted ? "Cancelled" : (e as Error).message;
        this.install = { ...this.install, phase: signal.aborted ? "cancelled" : "error", error: msg };
        this.brain.store.logActivity({ kind: "cortex", source: "cortex", action: "install", status: "error", detail: { error: msg } });
        if (!signal.aborted) this.brain.notify("important", "Model installation failed", truncate(msg, 160), "install-failed");
        log.error("Cortex install failed", msg);
      } finally {
        ping();
      }
    })();
    return this.installStatus();
  }

  cancelInstall(): void {
    this.installCtl?.abort();
  }

  async removeModel(id: string): Promise<void> {
    const row = this.brain.db.get<Row>("SELECT * FROM ai_components WHERE id = ? AND kind = 'model'", [id]);
    if (!row) throw new MothError("not_found", "That model is not installed");
    if (this.rt?.loadedModelId === id) await this.rt.unload("model removed");
    fs.rmSync(row.path as string, { force: true });
    this.brain.db.run("DELETE FROM ai_components WHERE id = ?", [id]);
    if (this.s.get("cortex.modelId") === id) this.s.set("cortex.modelId", "");
  }

  /** Re-hashes installed files (detects corruption or tampering). */
  async verifyInstalled(): Promise<{ id: string; ok: boolean }[]> {
    const out = [];
    for (const c of this.installedComponents()) {
      if (c.kind !== "model") continue;
      const ok = (await hashFile(c.path as string)) === c.sha256;
      this.brain.db.run("UPDATE ai_components SET verified = ? WHERE id = ?", [ok ? 1 : 0, c.id]);
      out.push({ id: c.id as string, ok });
    }
    return out;
  }

  // ------------------------------------------------------------------ learning
  private ctx(reason: string, task_id?: string | null): ChangeContext {
    return { actor: "moth", reason, task_id: task_id ?? null };
  }

  private cleanInput(text: string): string {
    if (typeof text !== "string" || !text.trim()) throw new MothError("invalid_input", "text is required");
    const t = normalizeWhitespace(stripControl(text));
    if (t.length > 20000) throw new MothError("invalid_input", "text is too long (max 20,000 characters); send the important parts");
    return redactSecrets(t).text;
  }

  private relevantFeedback(statement: string, limit = 3): Row[] {
    const rows = this.brain.db.all<Row>("SELECT * FROM feedback WHERE user_id = ? AND statement IS NOT NULL ORDER BY id DESC LIMIT 300", [this.brain.store.userId]);
    if (!rows.length) return [];
    const q = localEmbed(statement);
    return rows
      .map((r) => ({ r, s: cosine(q, localEmbed(String(r.statement))) }))
      .filter((x) => x.s > 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.r);
  }

  /** Enqueues a learning job (works from any process; the desktop app's engine processes it). */
  enqueueLearn(input: LearnInput, origin: string): number {
    this.cleanInput(input.text);
    if (origin !== "user" && this.brain.privacyMode()) throw new MothError("paused", "Privacy Mode is on in MOTH, so it is not learning right now. The user can turn Privacy Mode off in MOTH.");
    const id = this.brain.jobs.enqueue("cortex_learn", { ...input, origin }, { priority: 2, maxAttempts: 2 });
    return id as number;
  }

  async waitForJob(id: number, timeoutMs: number): Promise<Row | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const row = this.brain.db.get<Row>("SELECT * FROM jobs WHERE id = ?", [id]);
      if (row && ["done", "failed", "cancelled"].includes(row.status as string)) return { ...row, result: safeJson(row.result as string, null) };
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }

  async learn(input: LearnInput & { origin?: string }, signal?: AbortSignal): Promise<LearnReport> {
    const started = Date.now();
    if (input.origin && input.origin !== "user" && this.brain.learningHeld()) throw new MothError("paused", "Learning is paused or Privacy Mode is on");
    const text = this.cleanInput(input.text);
    const ready = this.readiness();
    if (!ready.ok && !this.router.status().cloud.ok) throw new MothError("cortex_unavailable", ready.reason ?? "Local AI is not available");
    const st = this.brain.store;
    let project = input.project ? st.getProject(input.project) : null;
    if (input.project && !project) project = st.createProject({ name: input.project }, this.ctx("Named in information sent to Cortex", input.task_id));
    if (!project && input.task_id) {
      const t = st.getTask(input.task_id);
      if (t?.project_id) project = st.getProject(t.project_id as string);
    }
    const providers = new Set<string>();

    // A. Understand
    const ex = await this.router.generate<Extraction>({ purpose: "extract", system: EXTRACT_SYSTEM, user: `Information to remember:\n"""\n${truncate(text, 6000)}\n"""`, schema: EXTRACT_SCHEMA, maxTokens: 900, signal, projectId: project?.id });
    providers.add(ex.model);
    const statements = ex.data.statements.filter((s) => s.text.trim().length > 3).slice(0, 8);
    const report: LearnReport = { statements: [], applied: 0, queued: 0, rejected: 0, project: project ? { id: project.id, name: project.name } : null, providers: [], ms: 0 };
    if (!statements.length) report.note = "Nothing in this information looked worth remembering.";

    for (const s of statements) {
      if (signal?.aborted) throw new Error("Cancelled");
      const outcome: StatementOutcome = { statement: s.text, kind: s.kind, relation: null, proposed_operation: null, action: "failed", target: null, memory_id: null, review_id: null, reason: "", checks: [], confidence: null, provider: null, model: null };
      try {
        let sProject = project;
        if (!sProject && s.project) sProject = st.getProject(s.project);
        // B. Recall
        const query = `${s.text} ${s.entities.join(" ")}`;
        const found = await this.brain.search.hybrid(query, {}, { limit: 6, minScore: 0.1, boostProjectId: sProject?.id ?? null });
        const exclude = new Set((input as { exclude_ids?: string[] }).exclude_ids ?? []);
        const candidates: Candidate[] = found.filter((f) => f.memory.category !== "project" && !exclude.has(f.memory.id)).slice(0, 6).map((f, i) => ({ index: i + 1, memory: f.memory, similarity: f.score }));
        const sims = this.brain.search.similarToText(s.text, 3);
        const maxSim = sims.length ? Math.max(...sims.map((x) => (!exclude.has(x.id) && st.getMemory(x.id)?.status === "active" ? x.score : 0))) : 0;
        const fb = this.relevantFeedback(s.text);
        // C/D. Compare + propose
        const memList = candidates.length ? candidates.map((c) => `[${c.index}] ${c.memory.title}: ${truncate(c.memory.content, 500)} (updated ${c.memory.updated_at.slice(0, 10)})`).join("\n") : "(no related memories found)";
        const fbText = fb.length ? `\nPast decisions the user corrected or confirmed:\n${fb.map((f) => `- "${truncate(String(f.statement), 140)}" -> ${f.operation ?? "?"} was ${f.verdict}${f.note ? ` (${truncate(String(f.note), 100)})` : ""}`).join("\n")}` : "";
        const cmp = await this.router.generate<Comparison>(
          { purpose: "compare", system: COMPARE_SYSTEM, user: `Existing memories:\n${memList}\n${fbText}\nNew statement: "${s.text}"`, schema: COMPARE_SCHEMA, maxTokens: 700, signal, projectId: sProject?.id },
          { needsEscalation: (d) => (d.relation === "contradiction" && d.confidence < 0.6 ? "Complex contradiction" : d.confidence < 0.25 ? "Insufficient evidence" : null) },
        );
        providers.add(cmp.model);
        const p = cmp.data;
        outcome.relation = p.relation;
        outcome.proposed_operation = p.operation;
        outcome.confidence = p.confidence;
        outcome.provider = cmp.provider;
        outcome.model = cmp.model;
        // E. Validate
        const target = p.target > 0 ? candidates.find((c) => c.index === p.target)?.memory ?? null : null;
        const existingLink = target ? false : false;
        const d = validateProposal({
          proposal: p,
          statement: s.text,
          candidates,
          autonomy: this.s.get("cortex.autonomy") as Autonomy,
          minConfidence: this.s.get("cortex.minConfidence"),
          duplicateThreshold: this.s.get("automation.duplicateThreshold"),
          maxSimilarityToAny: maxSim,
          sourcePresent: !!(input.source || input.task_id || input.source_ref),
          existingLink,
        });
        outcome.target = d.target ? { id: d.target.id, title: d.target.title } : null;
        outcome.reason = d.reason;
        outcome.checks = d.checks;
        if (input.analyze_only) {
          outcome.action = d.action === "reject" ? "rejected" : "proposed";
        } else if (d.action === "apply") {
          // F. Commit
          outcome.memory_id = this.applyOperation(d, p, s, sProject?.id ?? null, input, cmp.model, false);
          outcome.action = "applied";
          report.applied++;
        } else if (d.action === "review") {
          outcome.review_id = this.queueReview(d, p, s.text, input, cmp, sProject?.id ?? null, target);
          outcome.action = "queued_for_review";
          report.queued++;
        } else {
          outcome.action = "rejected";
          report.rejected++;
        }
      } catch (e) {
        outcome.error = (e as Error).message;
        outcome.reason = `Could not analyse this statement: ${(e as Error).message}`;
      }
      report.statements.push(outcome);
    }
    report.providers = [...providers];
    report.ms = Date.now() - started;
    if (!input.analyze_only) {
      this.brain.store.recordEvent({
        kind: "cortex_learned", actor: "moth", task_id: input.task_id ?? null, project_id: project?.id ?? null,
        description: `Cortex analysed ${report.statements.length} statement(s): ${report.applied} applied, ${report.queued} waiting for review`,
        reason: `Local intelligence (${report.providers.join(", ") || "no model"})`, undo: null,
      });
    }
    this.brain.store.logActivity({ kind: "cortex", source: input.source ?? "cortex", action: input.analyze_only ? "analyze" : "learn", duration_ms: report.ms, detail: { statements: report.statements.length, applied: report.applied, queued: report.queued, providers: report.providers } });
    return report;
  }

  private applyOperation(d: Decision, p: Comparison, s: { text: string; kind: string }, projectId: string | null, input: LearnInput, model: string, approved: boolean): string | null {
    const st = this.brain.store;
    const why = `${approved ? "Approved by you. " : ""}Cortex (${model}): ${p.reason || d.reason}`;
    const ctx = this.ctx(why, input.task_id);
    const target = d.target;
    const createFromStatement = () =>
      this.brain.createMemoryWithLinks(
        { title: p.title?.trim() || undefined, content: (p.content ?? "").trim() || s.text, category: KIND_TO_CATEGORY[s.kind] ?? "fact", project_id: projectId ?? target?.project_id ?? null, source: input.source || "cortex", source_ref: input.source_ref ?? null, tags: ["cortex"] },
        ctx,
      );
    switch (d.operation) {
      case "create": {
        const m = createFromStatement();
        if (target && p.link_type !== "none") st.link(m.id, target.id, p.link_type as RelationType, p.reason || "Related according to Cortex", ctx, { strength: 0.6 });
        return m.id;
      }
      case "link": {
        const m = createFromStatement();
        st.link(m.id, target!.id, (p.link_type === "none" ? "RELATED_TO" : p.link_type) as RelationType, p.reason || "Related according to Cortex", ctx, { strength: Math.min(0.9, p.confidence) });
        return m.id;
      }
      case "append":
        return st.appendMemory(target!.id, (p.content ?? "").trim() || s.text, ctx).id;
      case "update":
      case "flag_contradiction": {
        const m = st.updateMemory(target!.id, { content: (p.content ?? "").trim() || s.text, ...(p.title?.trim() ? { title: p.title.trim() } : {}) }, ctx, { changeType: "updated", force: approved });
        this.clearFlag(m.id, "possible_conflict");
        return m.id;
      }
      case "none":
      case "mark_duplicate":
        st.updateMemory(target!.id, { confidence: Math.min(1, target!.confidence + 0.05) }, ctx, { changeType: "reinforced" });
        return target!.id;
      case "review":
      default:
        return createFromStatement().id;
    }
  }

  private clearFlag(memoryId: string, flag: string): void {
    this.brain.db.run("UPDATE memories SET flags = (SELECT json_group_array(value) FROM json_each(memories.flags) WHERE value <> ?) WHERE id = ?", [flag, memoryId]);
  }

  private queueReview(d: Decision, p: Comparison, statement: string, input: LearnInput, cmp: { provider: string; model: string }, projectId: string | null, target: Memory | null): number {
    if (d.operation === "flag_contradiction" && target) {
      const flags = [...new Set([...target.flags, "possible_conflict"])];
      this.brain.db.run("UPDATE memories SET flags = ? WHERE id = ?", [JSON.stringify(flags), target.id]);
      this.brain.store.recordEvent({ kind: "conflict_flagged", actor: "moth", memory_id: target.id, project_id: target.project_id, description: `New information may contradict "${target.title}"`, reason: truncate(statement, 200), undo: { op: "unflag", flag: "possible_conflict", memory_id: target.id } });
      this.brain.notify("important", "Memory conflict needs your decision", `New information may contradict "${truncate(target.title, 60)}". Open the Review Queue.`, `conflict-${target.id}`);
    }
    const r = this.brain.db.run(
      `INSERT INTO review_queue(user_id, status, kind, affected_ids, operation, target_memory_id, proposal, statement, relation, reason, risk, confidence, provider, model, source, source_ref, task_id, created_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.brain.store.userId, d.operation === "flag_contradiction" ? "conflict" : d.operation === "mark_duplicate" ? "duplicate" : "cortex", JSON.stringify(target ? [target.id] : []), d.operation, target?.id ?? null, JSON.stringify({ ...p, project_id: projectId, target_version: target?.version ?? null, checks: d.checks, kind: p.operation }), statement, p.relation, d.reason, d.risk, p.confidence, cmp.provider, cmp.model, input.source ?? null, input.source_ref ?? null, input.task_id ?? null, nowIso()],
    );
    return r.lastInsertRowid;
  }

  // ------------------------------------------------------------------ review queue
  listReviews(status = "pending", limit = 100): Row[] {
    return this.brain.db
      .all<Row>(`SELECT * FROM review_queue WHERE user_id = ? ${status === "all" ? "" : "AND status = ?"} ORDER BY id DESC LIMIT ?`, status === "all" ? [this.brain.store.userId, limit] : [this.brain.store.userId, status, limit])
      .map((r) => ({ ...r, proposal: safeJson(r.proposal as string, {}), result: safeJson(r.result as string, null), target: r.target_memory_id ? this.brain.store.getMemory(r.target_memory_id as string) : null }));
  }

  approve(id: number, edits: { content?: string; title?: string } = {}): Row {
    const r = this.brain.db.get<Row>("SELECT * FROM review_queue WHERE id = ? AND user_id = ?", [id, this.brain.store.userId]);
    if (!r) throw new MothError("not_found", `No review item ${id}`);
    if (r.status !== "pending") throw new MothError("invalid_input", `This item was already ${r.status}`);
    const cleanEdits = Object.fromEntries(Object.entries(edits).filter(([, v]) => typeof v === "string" && v.trim()));
    const p = { ...(safeJson<Comparison & { project_id?: string | null; target_version?: number | null }>(r.proposal as string, {} as any)), ...cleanEdits };
    const target = r.target_memory_id ? this.brain.store.getMemory(r.target_memory_id as string) : null;
    if (r.target_memory_id && (!target || target.status !== "active")) {
      this.brain.db.run("UPDATE review_queue SET status = 'failed', decided_at = ?, decided_by = 'user', result = ? WHERE id = ?", [nowIso(), JSON.stringify({ error: "The memory it refers to was deleted or archived" }), id]);
      throw new MothError("stale", "The memory this proposal refers to no longer exists or is archived.");
    }
    const changedSince = !!(target && p.target_version && target.version !== p.target_version);
    // A generic "review" about an existing memory: approving with edited text updates it, otherwise the statement is added to it.
    let operation = r.operation as Decision["operation"];
    if (operation === "review" && target) operation = cleanEdits.content ? "update" : "append";
    if (operation === "append" && target && !cleanEdits.content && !(p as Comparison).content) (p as Comparison).content = r.statement as string;
    if (operation === "append" && target && r.operation === "review") (p as Comparison).content = r.statement as string;
    const decision: Decision = { action: "apply", operation, target, risk: r.risk as Decision["risk"], checks: [], reason: r.reason as string };
    const memoryId = this.brain.db.tx(() => {
      const mid = this.applyOperation(decision, p as Comparison, { text: r.statement as string, kind: (p as any).kind ?? "fact" }, p.project_id ?? null, { text: r.statement as string, source: (r.source as string) ?? "cortex", source_ref: r.source_ref as string, task_id: r.task_id as string }, (r.model as string) ?? "local model", true);
      this.brain.db.run("UPDATE review_queue SET status = 'applied', decided_at = ?, decided_by = 'user', result = ? WHERE id = ?", [nowIso(), JSON.stringify({ memory_id: mid, target_changed_since_proposal: changedSince }), id]);
      this.recordFeedback({ subject_type: "review", subject_id: String(id), verdict: "correct", operation: r.operation as string, statement: r.statement as string, note: edits.content ? "approved with edits" : null });
      return mid;
    });
    return { id, status: "applied", memory_id: memoryId, target_changed_since_proposal: changedSince };
  }

  reject(id: number, note?: string, verdict: "incorrect" | "irrelevant" | "keep_separate" = "incorrect"): Row {
    const r = this.brain.db.get<Row>("SELECT * FROM review_queue WHERE id = ? AND user_id = ?", [id, this.brain.store.userId]);
    if (!r) throw new MothError("not_found", `No review item ${id}`);
    if (r.status !== "pending") throw new MothError("invalid_input", `This item was already ${r.status}`);
    this.brain.db.tx(() => {
      this.brain.db.run("UPDATE review_queue SET status = 'rejected', decided_at = ?, decided_by = 'user', result = ? WHERE id = ?", [nowIso(), JSON.stringify({ note: note ?? null }), id]);
      if (r.operation === "flag_contradiction" && r.target_memory_id) this.clearFlag(r.target_memory_id as string, "possible_conflict");
      this.recordFeedback({ subject_type: "review", subject_id: String(id), verdict, operation: r.operation as string, statement: r.statement as string, note: note ?? null });
    });
    return { id, status: "rejected" };
  }

  // ------------------------------------------------------------------ feedback learning
  recordFeedback(f: { subject_type: "review" | "learning_event" | "relationship" | "memory"; subject_id: string; verdict: string; operation?: string | null; statement?: string | null; note?: string | null; context?: unknown }): number {
    return this.brain.db.run(
      "INSERT INTO feedback(user_id, subject_type, subject_id, verdict, operation, statement, note, context, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [this.brain.store.userId, f.subject_type, f.subject_id, f.verdict, f.operation ?? null, f.statement ? truncate(f.statement, 1000) : null, f.note ? truncate(f.note, 500) : null, JSON.stringify(f.context ?? {}), nowIso()],
    ).lastInsertRowid;
  }

  recordRetrievalFeedback(input: { task_id?: string | null; query?: string | null; useful?: string[]; not_useful?: string[]; source: string }): number {
    let n = 0;
    for (const [ids, useful] of [[input.useful ?? [], 1], [input.not_useful ?? [], 0]] as const) {
      for (const id of ids.slice(0, 50)) {
        if (!this.brain.store.getMemory(id)) continue;
        this.brain.db.run("INSERT INTO retrieval_feedback(user_id, memory_id, task_id, query, useful, source, created_at) VALUES (?,?,?,?,?,?,?)", [this.brain.store.userId, id, input.task_id ?? null, input.query ?? null, useful, input.source, nowIso()]);
        n++;
      }
    }
    return n;
  }

  feedbackSummary(): Row {
    const uid = this.brain.store.userId;
    return {
      decisions: this.brain.db.all("SELECT verdict, COUNT(*) AS n FROM feedback WHERE user_id = ? GROUP BY verdict", [uid]),
      retrieval: this.brain.db.get("SELECT SUM(useful) AS useful, COUNT(*) - SUM(useful) AS not_useful FROM retrieval_feedback WHERE user_id = ?", [uid]),
      recent: this.brain.db.all("SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT 20", [uid]),
    };
  }

  // ------------------------------------------------------------------ intelligent context
  async intelligentContext(query: string, opts: { project?: string | null; synthesize?: boolean; signal?: AbortSignal } = {}): Promise<Row> {
    const { buildContext } = await import("../engine/context.ts");
    const pkg = await buildContext(this.brain.store, this.brain.search, query, { project: opts.project });
    const items = [...pkg.sections.decisions, ...pkg.sections.open_tasks, ...pkg.sections.errors_and_solutions, ...pkg.sections.relevant];
    if (!opts.synthesize || !items.length || !this.readiness().ok) {
      return { ...pkg, brief: null, brief_note: !opts.synthesize ? null : !items.length ? "Nothing relevant stored" : `Local AI not used: ${this.readiness().reason}` };
    }
    const list = items.map((it, i) => `[${i + 1}] ${it.title}: ${truncate(it.summary || it.excerpt, 400)}`).join("\n");
    const r = await this.router.generate<{ brief: string; relevant: number[] }>({ purpose: "context", system: CONTEXT_SYSTEM, user: `Task: ${truncate(query, 1000)}\n\nMemories:\n${list}`, schema: CONTEXT_SCHEMA, maxTokens: 400, signal: opts.signal, projectId: pkg.project?.id });
    const relevant = new Set(r.data.relevant.filter((n) => n >= 1 && n <= items.length).map((n) => items[n - 1].id));
    return { ...pkg, brief: r.data.brief, brief_model: r.model, brief_provider: r.provider, model_marked_relevant: [...relevant] };
  }

  // ------------------------------------------------------------------ status & lifecycle
  async status(): Promise<Row> {
    const db = this.brain.db;
    const sel = this.selectedModel();
    const rt = this.rt?.info() ?? this.remoteRuntimeInfo() ?? { state: "unloaded", model: null, pid: null, port: null, loadedAt: null, lastUsedAt: null, idleUnloadAt: null, current: null, pending: 0, lastError: null, stats: { requests: 0, failures: 0, crashes: 0, loads: 0 }, recentLog: [] };
    const running = db.get<Row>("SELECT id, kind, payload, locked_at FROM jobs WHERE status = 'running' AND kind LIKE 'cortex_%' ORDER BY id DESC LIMIT 1");
    return {
      enabled: this.s.get("cortex.enabled"),
      paused: this.s.get("cortex.paused"),
      readiness: this.readiness(),
      role: this.brain.role,
      runtime: { ...rt, installed: !!this.serverPath(), build: this.runtimeBuild() ?? null, variant: this.s.get("cortex.runtimeVariant") },
      selected_model: { id: sel.id, installed: !!sel.path, entry: sel.entry },
      installed: this.installedComponents(),
      install: this.installStatus(),
      current_task: rt.current ?? (running ? { label: running.kind, startedAt: running.locked_at, job: running.id } : null),
      queue: {
        pending_jobs: Number(db.value("SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running') AND kind LIKE 'cortex_%'") ?? 0),
        pending_reviews: Number(db.value("SELECT COUNT(*) FROM review_queue WHERE user_id = ? AND status = 'pending'", [this.brain.store.userId]) ?? 0),
      },
      recent: this.brain.store.listActivity({ kind: "cortex", limit: 15 }),
      errors: [
        ...(rt.lastError ? [{ at: null, message: rt.lastError }] : []),
        ...db.all<Row>("SELECT updated_at AS at, last_error AS message, kind FROM jobs WHERE kind LIKE 'cortex_%' AND status = 'failed' ORDER BY id DESC LIMIT 5"),
        ...(this.install.error ? [{ at: this.install.startedAt, message: `Install: ${this.install.error}` }] : []),
      ],
      providers: this.router.status(),
      settings: {
        idleTimeoutMin: this.s.get("cortex.idleTimeoutMin"),
        autonomy: this.s.get("cortex.autonomy"),
        contextSize: this.s.get("cortex.contextSize"),
        threads: this.s.get("cortex.threads") || defaultThreads(),
        cloudFallback: this.s.get("cortex.cloudFallback"),
      },
      feedback: this.feedbackSummary(),
    };
  }

  /** Runtime state as last reported by the desktop app's engine (used from MCP/CLI processes). */
  private remoteRuntimeInfo(): any | null {
    if (this.brain.role !== "mcp" && this.brain.role !== "cli") return null;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(this.dir, "runtime-status.json"), "utf8"));
      try {
        process.kill(st.pid_owner, 0);
      } catch {
        return { ...st, state: "unloaded", note: "The MOTH desktop app is not running" };
      }
      return { ...st, recentLog: [] };
    } catch {
      return null;
    }
  }

  /**
   * Organises a memory the user already saved (Quick Capture, First Flight): Cortex compares it with what MOTH knows.
   * Related memories are linked automatically; duplicates and conflicts go to the Memory Inbox. The memory itself
   * was saved before this runs and is never changed without approval.
   */
  async organize(memoryId: string, signal?: AbortSignal): Promise<Row> {
    const m = this.brain.store.getMemory(memoryId);
    if (!m || m.status !== "active") return { skipped: "memory no longer active" };
    const report = await this.learn({ text: m.content, analyze_only: true, project: m.project_id ?? undefined, source: "quick-capture", exclude_ids: [m.id] } as LearnInput, signal);
    const st = this.brain.store;
    const actions: Row[] = [];
    for (const o of report.statements) {
      if (!o.target || o.target.id === m.id || !st.getMemory(o.target.id)) continue;
      const target = st.requireMemory(o.target.id);
      const ctx = this.ctx(`Cortex (${o.model ?? "local model"}) compared your captured memory with "${target.title}"`);
      if (o.relation === "already_known") {
        const rid = this.brain.inbox.add({ kind: "duplicate", operation: "merge", statement: m.content, target_memory_id: target.id, affected_ids: [target.id, m.id], reason: `Looks like the same information as "${target.title}". Approve to merge your new note into it (both versions are kept in history).`, risk: "medium", confidence: o.confidence, source: "quick-capture", proposal: { handler: "merge_capture", target_id: target.id, new_id: m.id } });
        actions.push({ action: "review_duplicate", review_id: rid, target: target.id });
      } else if (o.relation === "contradiction" || o.relation === "correction") {
        const rid = this.brain.inbox.add({ kind: "conflict", operation: "supersede", statement: m.content, target_memory_id: target.id, affected_ids: [target.id, m.id], reason: `Your new note may replace or contradict "${target.title}". Approve to mark the old memory as superseded (it is kept in history).`, risk: "high", confidence: o.confidence, source: "quick-capture", proposal: { handler: "supersede_capture", target_id: target.id, new_id: m.id } });
        actions.push({ action: "review_conflict", review_id: rid, target: target.id });
      } else if (o.relation === "extends" || o.relation === "historical") {
        const exists = this.brain.db.value("SELECT 1 FROM memory_relationships WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)", [m.id, target.id, target.id, m.id]);
        if (!exists) st.link(m.id, target.id, "RELATED_TO", truncate(o.reason || "Related according to Cortex", 300), ctx, { strength: Math.min(0.85, o.confidence ?? 0.5) });
        actions.push({ action: "linked", target: target.id });
      }
    }
    return { memory_id: m.id, statements: report.statements.length, actions };
  }

  registerOrganizeHandlers(): void {
    this.brain.inbox.register("merge_capture", {
      approve: (item) => {
        const p = item.proposal as { target_id: string; new_id: string };
        return { memory_id: this.brain.store.merge(p.target_id, [p.new_id], { actor: "user", reason: "Approved merge of a captured duplicate" }).id };
      },
    });
    this.brain.inbox.register("supersede_capture", {
      approve: (item) => {
        const p = item.proposal as { target_id: string; new_id: string };
        this.brain.store.supersede(p.target_id, p.new_id, { actor: "user", reason: "Approved: the captured memory replaces the older one" });
        return { memory_id: p.new_id };
      },
    });
  }

  registerJobs(): void {
    this.brain.jobs.register("cortex_organize", async (job, signal) => this.organize(job.payload.memory_id, signal));
    this.brain.jobs.register("cortex_learn", async (job, signal) => this.learn(job.payload as LearnInput, signal));
    this.brain.jobs.register("cortex_context", async (job, signal) => this.intelligentContext(job.payload.query, { project: job.payload.project, synthesize: true, signal }));
    const stateFile = path.join(this.dir, "runtime-state.json");
    void LlamaRuntime.cleanupOrphan(stateFile);
  }

  async load(): Promise<void> {
    const rt = this.runtime();
    const r = this.readiness();
    if (!rt || !r.ok) throw new MothError("cortex_unavailable", r.reason ?? "Local AI is not available");
    await rt.load();
  }

  async unload(): Promise<void> {
    await this.rt?.unload("requested");
  }

  shutdown(): void {
    this.installCtl?.abort();
    this.rt?.killNow();
  }
}
