// ISOLATED TEST HELPER (not real inference): a stand-in model provider that returns scripted text, used only to test
// how MOTH validates model output, handles malformed answers and cancels/recovers jobs. Real-model tests live in
// test-real/ and run against llama.cpp + Qwen2.5 in CI.
import { IntelligenceRouter, type GenerateRequest, type ModelProvider } from "../../src/cortex/providers.ts";
import type { Brain } from "../../src/engine/brain.ts";

export function useFakeModel(b: Brain, reply: (req: GenerateRequest) => string | Promise<string>): { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  const local: ModelProvider = {
    kind: "local",
    id: () => "fake-test-model",
    availability: () => ({ ok: true }),
    generate: async (req) => {
      calls.push(req);
      return { text: await reply(req), ms: 1 };
    },
  };
  const cloud: ModelProvider = { kind: "cloud", id: () => "none", availability: () => ({ ok: false, reason: "not configured" }), generate: async () => ({ text: "", ms: 0 }) };
  (b.cortex as any).router = new IntelligenceRouter(local, cloud, b.store);
  (b.cortex as any).readiness = () => ({ ok: true });
  return { calls };
}

/** A model that never answers until the job is cancelled (for cancellation / crash tests). */
export const hangingModel = (req: GenerateRequest) =>
  new Promise<string>((_r, rej) => {
    if (req.signal?.aborted) return rej(new Error("Cancelled"));
    req.signal?.addEventListener("abort", () => rej(new Error("Cancelled")));
  });
