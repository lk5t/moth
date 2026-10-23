// Anthropic API client (plain fetch, no SDK needed) + an in-memory secret vault.
// Keys live in Windows Credential Manager (handled by the desktop shell) and are handed to this
// process at runtime; they are never written to the database or logs.
import type { MemoryStore } from "./store.ts";

const secrets = new Map<string, string>();

export const Secrets = {
  set(name: string, value: string | null | undefined): void {
    if (value && value.trim()) secrets.set(name, value.trim());
    else secrets.delete(name);
  },
  get(name: string): string | undefined {
    return secrets.get(name) ?? process.env[`MOTH_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] ?? undefined;
  },
  has(name: string): boolean {
    return !!this.get(name);
  },
  names(): string[] {
    return [...secrets.keys()];
  },
};

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export class AiUnavailable extends Error {}

export class AnthropicClient {
  private recent: number[] = [];

  constructor(private store: MemoryStore) {}

  available(): { ok: boolean; reason?: string } {
    const s = this.store.settings;
    if (!s.get("ai.enabled")) return { ok: false, reason: "AI processing is turned off in Settings" };
    if (!s.get("ai.disclosureAccepted")) return { ok: false, reason: "External AI processing has not been approved yet" };
    if (!Secrets.has("anthropic_api_key")) return { ok: false, reason: "No Anthropic API key is set" };
    if (s.get("automation.paused")) return { ok: false, reason: "Automation is paused" };
    return { ok: true };
  }

  private rateLimit(): void {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 3_600_000);
    const max = this.store.settings.get("ai.maxCallsPerHour");
    if (this.recent.length >= max) throw new AiUnavailable(`AI call limit reached (${max} per hour)`);
    this.recent.push(now);
  }

  async complete(opts: { system: string; messages: AiMessage[]; maxTokens?: number; model?: string; purpose: string }): Promise<string> {
    const av = this.available();
    if (!av.ok) throw new AiUnavailable(av.reason);
    this.rateLimit();
    const key = Secrets.get("anthropic_api_key") as string;
    const model = opts.model || this.store.settings.get("ai.model");
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 90_000);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 1500, system: opts.system, messages: opts.messages }),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        this.store.logActivity({ kind: "ai", source: "anthropic", action: opts.purpose, status: "error", duration_ms: Date.now() - started, detail: { model, status: res.status, error: text.slice(0, 300) } });
        throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = JSON.parse(text);
      const out = (json.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      this.store.logActivity({
        kind: "ai", source: "anthropic", action: opts.purpose, duration_ms: Date.now() - started,
        detail: { model, input_tokens: json.usage?.input_tokens, output_tokens: json.usage?.output_tokens },
      });
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  async json<T>(opts: { system: string; prompt: string; maxTokens?: number; model?: string; purpose: string }): Promise<T> {
    const raw = await this.complete({
      system: `${opts.system}\n\nRespond with a single JSON object only. No prose, no markdown fences.`,
      messages: [{ role: "user", content: opts.prompt }],
      maxTokens: opts.maxTokens,
      model: opts.model,
      purpose: opts.purpose,
    });
    return extractJson<T>(raw);
  }

  async test(): Promise<{ ok: boolean; model: string; message: string }> {
    const model = this.store.settings.get("ai.model");
    try {
      const out = await this.complete({ system: "You are a connectivity check.", messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 10, purpose: "connection_test" });
      return { ok: true, model, message: out.trim() };
    } catch (e) {
      return { ok: false, model, message: (e as Error).message };
    }
  }
}

export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response did not contain JSON");
  return JSON.parse(body.slice(start, end + 1)) as T;
}
