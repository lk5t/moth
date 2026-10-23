// Model providers and the IntelligenceRouter.
// The local model is always primary. A cloud provider is only used when the user has configured
// AND authorised it (key + consent + "cloud fallback" switch) and the project isn't marked private.
import type { AnthropicClient } from "../engine/ai.ts";
import type { MemoryStore } from "../engine/store.ts";
import type { ChatMessage, LlamaRuntime } from "./runtime.ts";

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  description?: string;
}

export interface GenerateRequest {
  purpose: string;
  system: string;
  user: string;
  schema: JsonSchema;
  maxTokens?: number;
  signal?: AbortSignal;
  projectId?: string | null;
}

export interface GenerateResult<T> {
  data: T;
  provider: "local" | "cloud";
  model: string;
  attempts: number;
  ms: number;
  fallbackReason?: string;
}

export interface ModelProvider {
  readonly kind: "local" | "cloud";
  id(): string;
  availability(): { ok: boolean; reason?: string };
  generate(req: GenerateRequest, attempt: number): Promise<{ text: string; ms: number }>;
}

/** Validates a parsed value against the JSON-schema subset MOTH uses. Returns a list of problems. */
export function validateSchema(value: unknown, schema: JsonSchema, at = "$"): string[] {
  const errs: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of ${schema.enum.join(", ")}`);
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at} must be an object`];
      for (const r of schema.required ?? []) if (!(r in (value as object))) errs.push(`${at}.${r} is missing`);
      for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in (value as object)) errs.push(...validateSchema((value as any)[k], s, `${at}.${k}`));
      break;
    }
    case "array":
      if (!Array.isArray(value)) return [`${at} must be an array`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at} has too many items`);
      if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(v, schema.items!, `${at}[${i}]`)));
      break;
    case "string":
      if (typeof value !== "string") errs.push(`${at} must be a string`);
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) errs.push(`${at} must be a number`);
      else {
        if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at} is below ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at} is above ${schema.maximum}`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") errs.push(`${at} must be true or false`);
      break;
  }
  return errs;
}

export function parseJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error("Model output was not JSON");
  }
}

export class LocalModelProvider implements ModelProvider {
  readonly kind = "local" as const;
  constructor(private runtime: () => LlamaRuntime | null, private ready: () => { ok: boolean; reason?: string }) {}
  id(): string {
    return `local:${this.runtime()?.config.modelId ?? "none"}`;
  }
  availability() {
    return this.ready();
  }
  async generate(req: GenerateRequest, attempt: number) {
    const rt = this.runtime();
    if (!rt) throw new Error("Local AI is not set up");
    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: attempt > 1 ? `${req.user}\n\nYour previous answer was not valid. Reply with JSON that matches the schema exactly.` : req.user },
    ];
    const r = await rt.complete(messages, { jsonSchema: req.schema, maxTokens: req.maxTokens, temperature: attempt > 1 ? 0.3 : 0.1, signal: req.signal, label: req.purpose });
    return { text: r.text, ms: r.ms };
  }
}

/** Anthropic API as an optional cloud fallback. Uses MOTH's existing consent, key, rate limit and logging. */
export class AnthropicCloudProvider implements ModelProvider {
  readonly kind = "cloud" as const;
  constructor(private ai: AnthropicClient, private store: MemoryStore) {}
  id(): string {
    return `anthropic:${this.store.settings.get("ai.model")}`;
  }
  availability() {
    if (!this.store.settings.get("cortex.cloudFallback")) return { ok: false, reason: "Cloud fallback is switched off" };
    return this.ai.available();
  }
  async generate(req: GenerateRequest) {
    const started = Date.now();
    const text = await this.ai.complete({
      purpose: `cortex_${req.purpose}`,
      system: `${req.system}\n\nRespond with a single JSON object matching this JSON schema, nothing else:\n${JSON.stringify(req.schema)}`,
      messages: [{ role: "user", content: req.user }],
      maxTokens: req.maxTokens ?? 1200,
    });
    return { text, ms: Date.now() - started };
  }
}

export class IntelligenceRouter {
  constructor(private local: ModelProvider, private cloud: ModelProvider, private store: MemoryStore) {}

  status() {
    const l = this.local.availability();
    const c = this.cloud.availability();
    return {
      local: { id: this.local.id(), ...l },
      cloud: { id: this.cloud.id(), ...c, implemented: true, provider: "Anthropic API" },
      policy: "Local model first. Cloud is used only after the local model fails, and only when you have enabled cloud fallback and approved sending data.",
    };
  }

  private cloudAllowed(projectId?: string | null): { ok: boolean; reason?: string } {
    const a = this.cloud.availability();
    if (!a.ok) return a;
    const blocked = this.store.settings.get("cortex.cloudBlockedProjects");
    if (projectId && blocked.includes(projectId)) return { ok: false, reason: "This project is marked local-only" };
    return { ok: true };
  }

  private async attempt<T>(p: ModelProvider, req: GenerateRequest, maxAttempts: number): Promise<{ data: T; attempts: number; ms: number }> {
    let lastErr: Error | null = null;
    let ms = 0;
    for (let i = 1; i <= maxAttempts; i++) {
      if (req.signal?.aborted) throw new Error("Cancelled");
      try {
        const r = await p.generate(req, i);
        ms += r.ms;
        const data = parseJson(r.text);
        const problems = validateSchema(data, req.schema);
        if (problems.length) throw new Error(`Invalid structured output: ${problems.slice(0, 3).join("; ")}`);
        return { data: data as T, attempts: i, ms };
      } catch (e) {
        lastErr = e as Error;
        if (/not installed|not set up|Cancelled|repeated crashes/.test(lastErr.message)) break;
      }
    }
    throw lastErr ?? new Error("No result");
  }

  /**
   * Generates validated JSON. Local first with bounded retries; cloud fallback only when allowed.
   * `needsEscalation` lets the caller escalate a valid-but-weak local answer (e.g. low confidence).
   */
  async generate<T>(req: GenerateRequest, opts: { needsEscalation?: (d: T) => string | null } = {}): Promise<GenerateResult<T>> {
    const maxAttempts = Math.max(1, Math.min(4, this.store.settings.get("cortex.maxRetries") + 1));
    let fallbackReason: string | undefined;
    const local = this.local.availability();
    if (local.ok) {
      try {
        const r = await this.attempt<T>(this.local, req, maxAttempts);
        const escalate = opts.needsEscalation?.(r.data) ?? null;
        if (!escalate) return { data: r.data, provider: "local", model: this.local.id(), attempts: r.attempts, ms: r.ms };
        fallbackReason = escalate;
        const c = this.cloudAllowed(req.projectId);
        if (!c.ok) return { data: r.data, provider: "local", model: this.local.id(), attempts: r.attempts, ms: r.ms, fallbackReason: `${escalate}; cloud not used (${c.reason})` };
      } catch (e) {
        fallbackReason = `Local model failed: ${(e as Error).message}`;
      }
    } else fallbackReason = `Local model unavailable: ${local.reason}`;

    const c = this.cloudAllowed(req.projectId);
    if (!c.ok) throw new Error(`${fallbackReason}. Cloud fallback not used: ${c.reason}.`);
    this.store.logActivity({ kind: "ai", source: "cortex", action: "cloud_fallback", detail: { purpose: req.purpose, reason: fallbackReason } });
    const r = await this.attempt<T>(this.cloud, req, 2);
    return { data: r.data, provider: "cloud", model: this.cloud.id(), attempts: r.attempts, ms: r.ms, fallbackReason };
  }
}
