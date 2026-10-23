// Embedding provider abstraction.
//
// - "local": an offline lexical embedding (feature hashing of words, word pairs and character
//   trigrams). It needs no network and no key, so it always works (including inside the MCP
//   process). It captures shared vocabulary and word forms, not deep meaning.
// - "openai-compatible": any /v1/embeddings endpoint (OpenAI, Ollama, llama.cpp server, LM Studio…).
// - "voyage": Voyage AI (the embedding provider Anthropic recommends).
//
// Every memory always gets a local vector. A remote vector is added when a remote provider is
// configured and a key is available, and is preferred for search when the query can be embedded too.
import { tokenize } from "./text.ts";

export const LOCAL_MODEL = "local-hash-v1-384";
export const LOCAL_DIMS = 384;

export interface EmbeddingProviderConfig {
  provider: "local" | "openai-compatible" | "voyage";
  model?: string;
  baseUrl?: string;
}

export interface EmbeddingProvider {
  id: string; // model id stored with vectors, e.g. "voyage:voyage-3.5-lite"
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}

function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function localEmbed(text: string): Float32Array {
  const v = new Float32Array(LOCAL_DIMS);
  const toks = tokenize(text);
  const add = (feature: string, w: number) => {
    const h = fnv1a(feature);
    const idx = h % LOCAL_DIMS;
    const sign = (fnv1a(feature, 0x9747b28c) & 1) === 0 ? 1 : -1;
    v[idx] += sign * w;
  };
  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, c] of tf) {
    const w = 1 + Math.log(c);
    add("w:" + t, w);
    if (t.length >= 5) {
      const p = `#${t}#`;
      for (let i = 0; i + 3 <= p.length; i++) add("c:" + p.slice(i, i + 3), 0.18 * w);
    }
  }
  for (let i = 0; i + 1 < toks.length; i++) add("b:" + toks[i] + "_" + toks[i + 1], 0.5);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function blobToVec(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b); // ensure alignment
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export const localProvider: EmbeddingProvider = {
  id: LOCAL_MODEL,
  async embed(texts) {
    return texts.map(localEmbed);
  },
};

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 30000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

export function createRemoteProvider(cfg: EmbeddingProviderConfig, apiKey: string | undefined): EmbeddingProvider | null {
  if (cfg.provider === "voyage") {
    if (!apiKey) return null;
    const model = cfg.model || "voyage-3.5-lite";
    return {
      id: `voyage:${model}`,
      async embed(texts, kind) {
        const json = await postJson(
          "https://api.voyageai.com/v1/embeddings",
          { input: texts, model, input_type: kind === "query" ? "query" : "document" },
          { authorization: `Bearer ${apiKey}` },
        );
        return (json.data as { embedding: number[] }[]).map((d) => Float32Array.from(d.embedding));
      },
    };
  }
  if (cfg.provider === "openai-compatible") {
    const base = (cfg.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
    const model = cfg.model || "nomic-embed-text";
    return {
      id: `oai:${model}@${base}`,
      async embed(texts) {
        const json = await postJson(`${base}/embeddings`, { input: texts, model }, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
        return (json.data as { embedding: number[]; index: number }[])
          .sort((a, b) => a.index - b.index)
          .map((d) => Float32Array.from(d.embedding));
      },
    };
  }
  return null;
}
