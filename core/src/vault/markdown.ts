// Markdown understanding for the Knowledge Library: frontmatter, tags, headings and links.
//
// Documents are stored exactly as written (frontmatter and unknown syntax included). This module only *reads*
// them: it never rewrites text except in `rewriteLinkTargets`, which the library uses when the user renames or
// moves a note (MOTH-managed copies only; imported source vaults are never written).

export interface FrontmatterInfo {
  /** Raw frontmatter text (without the --- fences), or null. Kept verbatim in the document. */
  raw: string | null;
  /** Simple key → value(s) view of the frontmatter (scalars and lists). Unknown structures are left out here but stay in `raw`. */
  data: Record<string, string | string[]>;
  body: string;
  bodyOffset: number;
}

export interface ParsedLink {
  kind: "wikilink" | "embed" | "markdown";
  raw: string;
  /** The note / file the link points at (no alias, no heading), as written. */
  target: string;
  alias: string | null;
  heading: string | null;
  /** Character offset in the full text. */
  position: number;
  /** For markdown links: true for http(s)/mailto etc; for unsafe schemes see `unsafe`. */
  external: boolean;
  unsafe: boolean;
}

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

export function splitFrontmatter(text: string): FrontmatterInfo {
  const t = text.replace(/^﻿/, "");
  const m = t.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { raw: null, data: {}, body: t, bodyOffset: text.length - t.length };
  const raw = m[1];
  const data: Record<string, string | string[]> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_][\w -]*?):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (val === "" || val === "|" || val === ">") {
      // A block list ("key:\n  - a\n  - b") — anything else (nested maps, block text) stays only in `raw`.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      if (items.length) data[key] = items;
      continue;
    }
    if (val.startsWith("[") && val.endsWith("]")) {
      data[key] = val.slice(1, -1).split(",").map(unquote).filter(Boolean);
      continue;
    }
    data[key] = unquote(val);
  }
  return { raw, data, body: t.slice(m[0].length), bodyOffset: text.length - t.length + m[0].length };
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v.split(/[,\s]+/)).map((x) => x.trim()).filter(Boolean);

/** Replaces fenced code blocks and inline code with spaces (same length), so links/tags inside code are ignored. */
export function maskCode(text: string): string {
  let out = text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
  return out;
}

/** Tags from frontmatter (tags / tag) and inline #tags in the text (not in code, not headings, not URLs). */
export function extractTags(text: string): string[] {
  const fm = splitFrontmatter(text);
  const tags = new Set<string>();
  for (const t of [...list(fm.data.tags), ...list(fm.data.tag)]) {
    const clean = t.replace(/^#/, "").trim();
    if (clean && !/\s/.test(clean)) tags.add(clean.toLowerCase());
  }
  const body = maskCode(fm.body);
  for (const m of body.matchAll(/(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu)) {
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue; // "#1" is not a tag in Obsidian
    tags.add(tag.toLowerCase().replace(/\/+$/, ""));
  }
  return [...tags].slice(0, 200);
}

export function extractAliases(text: string): string[] {
  const fm = splitFrontmatter(text);
  return [...new Set([...list(fm.data.aliases), ...list(fm.data.alias)].map((a) => a.trim()).filter((a) => a && a.length <= 200))].slice(0, 50);
}

export function extractHeadings(text: string): { level: number; text: string }[] {
  const body = maskCode(splitFrontmatter(text).body);
  return [...body.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((m) => ({ level: m[1].length, text: m[2] }));
}

/** Title for a new note: frontmatter title, then the first heading, then the first line. */
export function deriveDocTitle(text: string, fallback = "Untitled"): string {
  const fm = splitFrontmatter(text);
  const t = typeof fm.data.title === "string" ? fm.data.title : extractHeadings(text)[0]?.text ?? fm.body.split(/\r?\n/).find((l) => l.trim())?.replace(/^[#>*\-\s]+/, "");
  return (t ?? fallback).trim().slice(0, 180) || fallback;
}

const SAFE_SCHEMES = /^(https?|mailto|tel|obsidian):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decodeTarget(t: string): string {
  let v = t.trim();
  if (v.startsWith("<") && v.endsWith(">")) v = v.slice(1, -1);
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep as written */
  }
  return v;
}

/** All links in the text, in order. Links inside code are ignored. Unsupported syntax is simply not matched (and stays in the text). */
export function extractLinks(text: string): ParsedLink[] {
  const masked = maskCode(text);
  const out: ParsedLink[] = [];
  for (const m of masked.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/g)) {
    const raw = text.slice(m.index!, m.index! + m[0].length);
    const inner = raw.slice(m[1] ? 3 : 2, -2);
    const bar = inner.indexOf("|");
    const targetPart = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const alias = bar >= 0 ? inner.slice(bar + 1).trim() || null : null;
    const hash = targetPart.indexOf("#");
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const heading = hash >= 0 ? targetPart.slice(hash + 1).trim() || null : null;
    out.push({ kind: m[1] ? "embed" : "wikilink", raw, target, alias, heading, position: m.index!, external: false, unsafe: false });
  }
  for (const m of masked.matchAll(/(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g)) {
    if (m.index! > 0 && masked[m.index! - 1] === "[" ) continue; // part of a wikilink-like construct
    const raw = text.slice(m.index!, m.index! + m[0].length);
    const href = decodeTarget(m[3]);
    const hash = href.startsWith("#") ? 0 : href.indexOf("#");
    const target = hash >= 0 ? href.slice(0, hash) : href;
    const heading = hash >= 0 ? href.slice(hash + 1) || null : null;
    const external = SAFE_SCHEMES.test(href) && !/^obsidian:/i.test(href);
    const unsafe = ANY_SCHEME.test(href) && !SAFE_SCHEMES.test(href);
    out.push({ kind: m[1] ? "embed" : "markdown", raw, target: target.trim(), alias: m[2] || null, heading, position: m.index!, external, unsafe });
  }
  return out.sort((a, b) => a.position - b.position);
}

/** Lower-cased note name without .md, used for title matching. */
export function normTarget(t: string): string {
  return t.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").trim().toLowerCase();
}

/**
 * Rewrites links whose target matches one of `from` (normalized) to `to`, keeping alias, heading and the link kind.
 * Returns the new text and how many links changed.
 */
export function rewriteLinkTargets(text: string, from: string[], to: string): { text: string; changed: number } {
  const want = new Set(from.map(normTarget));
  const links = extractLinks(text).filter((l) => (l.kind === "wikilink" || l.kind === "embed" || l.kind === "markdown") && !l.external && !l.unsafe && want.has(normTarget(l.target)));
  if (!links.length) return { text, changed: 0 };
  let out = "";
  let at = 0;
  for (const l of links) {
    out += text.slice(at, l.position);
    let repl: string;
    if (l.kind === "markdown") {
      const href = encodeURI(to.endsWith(".md") ? to : `${to}.md`) + (l.heading ? `#${encodeURIComponent(l.heading)}` : "");
      repl = `${l.raw.startsWith("!") ? "!" : ""}[${l.alias ?? ""}](${href})`;
    } else {
      repl = `${l.kind === "embed" ? "!" : ""}[[${to}${l.heading ? `#${l.heading}` : ""}${l.alias ? `|${l.alias}` : ""}]]`;
    }
    out += repl;
    at = l.position + l.raw.length;
  }
  out += text.slice(at);
  return { text: out, changed: links.length };
}

export function wordCount(text: string): number {
  return (splitFrontmatter(text).body.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);
export const NOTE_EXT = new Set([".md", ".markdown"]);

/** Markdown files are notes; every other file is kept as an attachment (stored as-is, whatever its type: 3D models,
 *  textures, scripts...). MOTH previews images, PDF, audio, video and text; other types are stored and can be
 *  opened or saved from the Files page. */
export function fileKind(name: string): "note" | "attachment" {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return NOTE_EXT.has(ext) ? "note" : "attachment";
}

export function mediaType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
    pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
    csv: "text/csv", txt: "text/plain", json: "application/json", zip: "application/zip", canvas: "application/json", excalidraw: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", mtl: "model/mtl", stl: "model/stl", fbx: "application/octet-stream", dae: "model/vnd.collada+xml",
    hdr: "image/vnd.radiance", html: "text/html", htm: "text/html", lua: "text/plain", luau: "text/plain", py: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

export const isImage = (name: string) => IMAGE_EXT.has(name.slice(name.lastIndexOf(".")).toLowerCase());

/** A folder / note name that is safe on Windows and contains no path separators. */
export function validName(name: string, what = "Name"): string {
  const n = String(name ?? "").trim();
  if (!n) throw new Error(`${what} can't be empty`);
  if (n.length > 180) throw new Error(`${what} is too long (180 characters at most)`);
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) throw new Error(`${what} can't contain \\ / : * ? " < > |`);
  if (n === "." || n === "..") throw new Error(`${what} can't be "." or ".."`);
  return n;
}
