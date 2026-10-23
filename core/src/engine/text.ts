// Small, dependency-free text utilities used for summaries, keywords and similarity.
import crypto from "node:crypto";

const STOP = new Set(
  `a an and are as at be been but by can could did do does doing done for from had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours also get got make made use used using via about after again against all am any because before being below between both down during each few further let lets ok okay yes thing things way really just
le la les un une des du de et est en que qui pour pas sur dans par avec au aux ce cette ces il elle ils elles je tu nous vous on se sa son ses leur leurs mais ou donc ni car ne plus tres`.split(/\s+/),
);

export function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip control characters (except tab/newline) that could confuse renderers or terminals. */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "");
}

export function tokenize(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const m of lower.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)) {
    let w = m[0].replace(/^['-]+|['-]+$/g, "").replace(/'s$/, "");
    if (w.length < 2 || STOP.has(w)) continue;
    w = stem(w);
    if (w.length < 2) continue;
    out.push(w);
  }
  return out;
}

/** Very light English stemmer: enough to match "fixes"/"fixed"/"fixing" → "fix". */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  const rules: [RegExp, string][] = [
    [/ies$/, "y"], [/sses$/, "ss"], [/([^s])s$/, "$1"], [/eed$/, "ee"],
    [/([a-z]{3,})ing$/, "$1"], [/([a-z]{3,})ed$/, "$1"], [/([a-z]{3,})ly$/, "$1"], [/([a-z]{4,})ment$/, "$1"],
  ];
  for (const [re, rep] of rules) {
    if (re.test(w)) {
      w = w.replace(re, rep);
      break;
    }
  }
  // collapse doubled final consonant from -ing/-ed removal (e.g. "stopp" → "stop")
  if (/([bdfgklmnprt])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

export function keywords(text: string, n = 8): string[] {
  const counts = new Map<string, number>();
  const original = new Map<string, string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)) {
    const raw = m[0];
    if (raw.length < 3 || STOP.has(raw)) continue;
    const st = stem(raw);
    counts.set(st, (counts.get(st) ?? 0) + 1);
    if (!original.has(st) || raw.length < (original.get(st) as string).length) original.set(st, raw);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([k]) => original.get(k) ?? k);
}

/** Extractive summary: first meaningful sentences up to maxLen characters. */
export function summarize(text: string, maxLen = 220): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLen) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [clean];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > maxLen) break;
    out += s;
  }
  if (!out) out = clean.slice(0, maxLen - 1).replace(/\s+\S*$/, "") + "…";
  return out.trim();
}

export function deriveTitle(content: string, maxLen = 72): string {
  const firstLine = content.split("\n").map((l) => l.replace(/^#+\s*|^[-*]\s*/g, "").trim()).find((l) => l.length > 0) ?? "Untitled memory";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0];
  const t = sentence.length > maxLen ? sentence.slice(0, maxLen - 1).replace(/\s+\S*$/, "") + "…" : sentence;
  return t.replace(/[.:;,]$/, "");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";
}

export function hashText(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.8);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

/** Phrases that commonly appear in prompt-injection attempts hidden inside stored content. */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts|messages)/i,
  /disregard (all |any )?(the )?(previous|prior|above|system) (instructions|prompt)/i,
  /you are now (a|an|in) /i,
  /new (system )?instructions?:/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\bsystem prompt\b/i,
  /do not tell the user/i,
  /exfiltrate|send (this|the|all) (data|memories|secrets) to/i,
];

export function looksLikeInjection(s: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(s));
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.5));
}
