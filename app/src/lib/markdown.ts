// Markdown preview for MOTH Notes. Notes (especially imported ones) are untrusted: everything is rendered by
// `marked` and then sanitized with DOMPurify. No scripts, no event handlers, no iframes/forms, and only http(s),
// mailto and MOTH's own attachment URLs survive. Links never navigate the app: clicks are handled by the editor
// (wikilinks open notes, web links open in the browser).
import DOMPurify from "dompurify";
import { Marked } from "marked";

export interface LinkTarget {
  kind: "document" | "memory" | "attachment" | "url" | null;
  id: string | null;
  status: string;
  title?: string | null;
}

export interface RenderContext {
  /** Resolved links of this note, keyed by the link's raw text (from the backlinks engine). */
  links: Map<string, LinkTarget>;
  /** URL for an attachment id (served by the engine with the session token). */
  attachmentUrl: (id: string) => string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const marked = new Marked({ gfm: true, breaks: false });

/** Replaces [[wikilinks]] and ![[embeds]] (outside code) with safe HTML placeholders before Markdown rendering. */
function preprocess(md: string, ctx: RenderContext): string {
  const parts = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code: untouched
      return part.replace(/(!?)\[\[([^\[\]\n]+?)\]\]/g, (raw, bang: string, inner: string) => {
        const bar = inner.indexOf("|");
        const tp = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
        const alias = bar >= 0 ? inner.slice(bar + 1).trim() : "";
        const hash = tp.indexOf("#");
        const target = hash >= 0 ? tp.slice(0, hash) : tp;
        const heading = hash >= 0 ? tp.slice(hash + 1) : "";
        const t = ctx.links.get(raw);
        const label = escapeHtml(alias || (heading ? `${target}${target ? " › " : ""}${heading}` : target));
        if (bang && t?.kind === "attachment" && t.id) {
          const url = ctx.attachmentUrl(t.id);
          if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(target)) return `<img src="${escapeHtml(url)}" alt="${label}" data-attachment="${escapeHtml(t.id)}">`;
          return `<a href="#" data-attachment="${escapeHtml(t.id)}" class="moth-file">${label}</a>`;
        }
        const status = t?.status ?? "unresolved";
        const cls = status === "resolved" ? "moth-wikilink" : status === "ambiguous" ? "moth-wikilink moth-ambiguous" : "moth-wikilink moth-unresolved";
        const data = t?.id ? ` data-kind="${escapeHtml(t.kind ?? "")}" data-id="${escapeHtml(t.id)}"` : ` data-target="${escapeHtml(target)}"`;
        return `<a href="#" class="${cls}"${data}${heading ? ` data-heading="${escapeHtml(heading)}"` : ""} title="${escapeHtml(status === "resolved" ? target || "this note" : status === "ambiguous" ? "Several notes have this name" : "No note with this name yet")}">${label}</a>`;
      });
    })
    .join("");
}

let hooked = false;
const ATTACHMENT_URL = /^http:\/\/127\.0\.0\.1:\d+\/api\/attachments\/att_[A-Za-z0-9]+(\?|$)/;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (/^https?:|^mailto:/i.test(href)) node.setAttribute("data-external", href);
      // Links never navigate the app itself.
      node.setAttribute("href", "#");
      node.removeAttribute("target");
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!ATTACHMENT_URL.test(src) && !/^data:image\/(png|jpeg|gif|webp);/i.test(src)) {
        // Remote images are not loaded (privacy: no tracking pixels); the alt text is shown instead.
        node.setAttribute("data-blocked-src", src.slice(0, 500));
        node.removeAttribute("src");
      }
    }
    if (node.tagName === "INPUT") node.setAttribute("disabled", "");
  });
}

/** Renders a note's Markdown to sanitized HTML. */
export function renderMarkdown(md: string, ctx: RenderContext): string {
  hook();
  // Frontmatter is shown as a small properties block, not as text.
  let body = md.replace(/^﻿/, "");
  let props = "";
  const fm = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fm) {
    body = body.slice(fm[0].length);
    props = `<pre class="moth-props">${escapeHtml(fm[1])}</pre>`;
  }
  // Standard Markdown links/images to vault files → attachment URLs when the engine resolved them.
  body = body.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g, (raw, bang: string, text: string, href: string) => {
    const t = ctx.links.get(raw);
    if (t?.kind === "attachment" && t.id) return bang ? `<img src="${escapeHtml(ctx.attachmentUrl(t.id))}" alt="${escapeHtml(text)}">` : `<a href="#" data-attachment="${escapeHtml(t.id)}">${escapeHtml(text || href)}</a>`;
    if (t?.kind === "document" && t.id) return `<a href="#" class="moth-wikilink" data-kind="document" data-id="${escapeHtml(t.id)}">${escapeHtml(text || href)}</a>`;
    return raw;
  });
  const html = (marked.parse(preprocess(body, ctx), { async: false }) as string)
    // GFM task list checkboxes → inert markers (form controls are not allowed in rendered notes).
    .replace(/<input\b[^>]*type="checkbox"[^>]*>/g, (m) => `<span class="moth-check${/\bchecked\b/.test(m) ? " done" : ""}"></span>`);
  return DOMPurify.sanitize(props + html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base", "svg", "math"],
    FORBID_ATTR: ["style", "srcset", "formaction", "action", "background", "ping"],
    ADD_ATTR: ["data-kind", "data-id", "data-target", "data-heading", "data-attachment", "data-external"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/(?:png|jpeg|gif|webp);base64,|http:\/\/127\.0\.0\.1:\d+\/api\/attachments\/)/i,
  }).replace(/<li>(\s*<p>)?\s*<span class="moth-check/g, (_m, pTag) => `<li class="moth-task">${pTag ?? ""}<span class="moth-check`);
}

/** Lightweight source highlighting for the editor overlay (headings, emphasis, links, tags, code). */
export function highlightSource(src: string): string {
  const lines = escapeHtml(src).split("\n");
  let inCode = false;
  return lines
    .map((l) => {
      if (/^(```|~~~)/.test(l)) {
        inCode = !inCode;
        return `<span class="hl-code">${l}</span>`;
      }
      if (inCode) return `<span class="hl-code">${l}</span>`;
      if (/^#{1,6}\s/.test(l)) return `<span class="hl-h">${l}</span>`;
      if (/^---$/.test(l)) return `<span class="hl-muted">${l}</span>`;
      return l
        .replace(/(`[^`]+`)/g, '<span class="hl-code">$1</span>')
        .replace(/(!?\[\[[^\]]+\]\])/g, '<span class="hl-link">$1</span>')
        .replace(/(!?\[[^\]]*\]\([^)]+\))/g, '<span class="hl-link">$1</span>')
        .replace(/(\*\*[^*]+\*\*)/g, '<span class="hl-b">$1</span>')
        .replace(/(^|\s)(#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu, '$1<span class="hl-tag">$2</span>')
        .replace(/^(\s*(?:[-*+]|\d+\.)\s(?:\[[ x]\]\s)?)/, '<span class="hl-muted">$1</span>')
        .replace(/^(&gt;.*)$/, '<span class="hl-quote">$1</span>');
    })
    .join("\n");
}
