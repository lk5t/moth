// MOTH Notes: hybrid Markdown editing. Source mode (with light syntax highlighting), rendered preview, or both side
// by side. Autosave with clear status, revision history, backlinks. Shared state per note (lib/docstore) keeps two
// panes showing the same note in sync.
import { Archive, Bold, CheckSquare, Code2, Columns2, Eye, FolderInput, Hash, Heading2, History, Italic, Link2, List, PanelRight, PencilLine, RotateCcw, Table, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { endpoint, rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { discardLocal, dismissDraft, editDoc, refreshDoc, release, restoreDraft, retain, saveDoc, useDoc } from "../lib/docstore";
import { useLive } from "../lib/hooks";
import { highlightSource, renderMarkdown, type LinkTarget } from "../lib/markdown";
import { openExternal } from "../lib/tauri";
import { cn, timeAgo } from "../lib/utils";
import { CollectionButton } from "./CollectionButton";
import { Badge, Button, Dialog, Select, Spinner } from "./ui";

export type EditorMode = "edit" | "split" | "preview";

const STATE_TEXT: Record<string, string> = { loading: "Opening…", saved: "Saved", dirty: "Editing…", saving: "Saving…", error: "Not saved", conflict: "Changed elsewhere", missing: "Not found" };

export function NoteEditor({ id, mode, onMode, onOpen }: { id: string; mode: EditorMode; onMode: (m: EditorMode) => void; onOpen: (kind: string, id: string, opts?: { split?: boolean }) => void }) {
  const { toast } = useApp();
  const doc = useDoc(id);
  const [linksPref, setShowLinks] = useState(() => {
    try {
      return localStorage.getItem("moth.notes.links") !== "off";
    } catch {
      return true;
    }
  });
  // Narrow panes (e.g. split view): the links panel only opens on request, and the header wraps.
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [linksForced, setLinksForced] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc?.state === "loading"]);
  const narrow = width < 900;
  const showLinks = narrow ? linksForced : linksPref;
  const [history, setHistory] = useState(false);
  const [moving, setMoving] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [att, setAtt] = useState<{ port: number; token: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    retain(id);
    return () => release(id);
  }, [id]);
  useEffect(() => void endpoint().then(setAtt).catch(() => undefined), []);
  const { data: links, reload: reloadLinks } = useLive<any>("docs.backlinks", { id }, { entities: ["document"], enabled: !!doc?.doc });
  useEffect(() => {
    try {
      localStorage.setItem("moth.notes.links", showLinks ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [showLinks]);
  // Link targets come from the engine's resolver (saved text). Reload them after each save.
  useEffect(() => {
    if (doc?.state === "saved") void reloadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.version]);

  const linkMap = useMemo(() => {
    const m = new Map<string, LinkTarget>();
    for (const l of [...(links?.outgoing ?? []), ...(links?.unresolved ?? [])]) m.set(l.raw, { kind: l.target_kind, id: l.target_id, status: l.status, title: l.target_title });
    return m;
  }, [links]);
  const html = useMemo(() => {
    if (!doc || mode === "edit") return "";
    return renderMarkdown(doc.text, { links: linkMap, attachmentUrl: (aid) => (att ? `http://127.0.0.1:${att.port}/api/attachments/${aid}?token=${encodeURIComponent(att.token)}` : "") });
  }, [doc?.text, mode, linkMap, att]);

  if (!doc || doc.state === "loading") {
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (doc.state === "missing") {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-[14px] text-ink">This note no longer exists</p>
          <p className="mt-1 text-[12.5px] text-ink-3">It was deleted or its import was undone. Close this tab.</p>
        </div>
      </div>
    );
  }
  const d = doc.doc ?? {};
  const archived = d.status === "archived";

  // ---- editing helpers (keep the browser's own undo/redo history)
  const insert = (before: string, after = "", placeholder = "") => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    const { selectionStart: s, selectionEnd: e, value } = el;
    const sel = value.slice(s, e) || placeholder;
    document.execCommand("insertText", false, before + sel + after);
    el.setSelectionRange(s + before.length, s + before.length + sel.length);
  };
  const linePrefix = (prefix: string) => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    const { selectionStart: s, value } = el;
    const ls = value.lastIndexOf("\n", s - 1) + 1;
    el.setSelectionRange(ls, ls);
    document.execCommand("insertText", false, prefix);
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "b") (e.preventDefault(), insert("**", "**", "bold"));
    else if (mod && e.key.toLowerCase() === "i") (e.preventDefault(), insert("*", "*", "italic"));
    else if (mod && e.key.toLowerCase() === "k") (e.preventDefault(), insert("[[", "]]", "Note"));
    else if (mod && e.key.toLowerCase() === "s") (e.preventDefault(), void saveDoc(id));
    else if (mod && e.key.toLowerCase() === "e") (e.preventDefault(), onMode(mode === "edit" ? "preview" : "edit"));
    else if (e.key === "Tab" && !mod) (e.preventDefault(), document.execCommand("insertText", false, "  "));
    else if (e.key === "Enter" && !mod && !e.shiftKey) {
      // Continue lists and checklists.
      const el = e.currentTarget;
      const { selectionStart: s, value } = el;
      const line = value.slice(value.lastIndexOf("\n", s - 1) + 1, s);
      const m = line.match(/^(\s*)([-*+]|\d+\.)\s(\[[ x]\]\s)?/);
      if (m) {
        e.preventDefault();
        if (line.trim() === m[0].trim()) {
          // Empty item: end the list.
          el.setSelectionRange(s - line.length, s);
          document.execCommand("insertText", false, "\n");
        } else {
          const marker = /\d+\./.test(m[2]) ? `${Number.parseInt(m[2], 10) + 1}.` : m[2];
          document.execCommand("insertText", false, `\n${m[1]}${marker} ${m[3] ? "[ ] " : ""}`);
        }
      }
    }
  };

  const onPreviewClick = async (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    if (a.dataset.external) return void openExternal(a.dataset.external);
    if (a.dataset.attachment && att) return void openExternal(`http://127.0.0.1:${att.port}/api/attachments/${a.dataset.attachment}?token=${encodeURIComponent(att.token)}`);
    if (a.dataset.id && a.dataset.kind) return onOpen(a.dataset.kind, a.dataset.id, { split: e.ctrlKey || e.metaKey });
    if (a.dataset.target !== undefined) {
      const name = a.dataset.target;
      if (a.classList.contains("moth-ambiguous")) return toast({ kind: "info", text: `Several notes are called "${name}". Use a folder path in the link, e.g. [[Folder/${name}]].` });
      try {
        const n = await rpc<any>("docs.create", { title: name, content: `# ${name}\n`, folder_id: d.folder_id ?? null });
        toast({ kind: "ok", text: `Created "${n.title}"` });
        onOpen("document", n.id);
      } catch (err) {
        toast({ kind: "error", text: (err as Error).message });
      }
    }
  };

  const commitTitle = async () => {
    const t = titleDraft?.trim();
    setTitleDraft(null);
    if (!t || t === doc.title) return;
    try {
      await saveDoc(id);
      const r = await rpc<any>("docs.rename", { id, title: t });
      await refreshDoc(id);
      toast({ kind: "ok", text: r.links_updated ? `Renamed. Updated ${r.links_updated} link${r.links_updated === 1 ? "" : "s"} in other notes.` : "Renamed" });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };

  const tool = (label: string, icon: ReactNode, run: () => void) => (
    <button key={label} title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={run} className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-surface-2 hover:text-ink [&_svg]:size-3.5">
      {icon}
    </button>
  );

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" data-testid="note-editor">
      <div className={cn("flex items-center gap-2 border-b border-line px-4 py-2", width < 640 && "flex-wrap")}>
        <div className={cn("min-w-0 flex-1", width < 640 && "basis-full")}>
          <div className="truncate text-[11px] text-ink-3">{d.folder_path || "Library"}{d.source === "obsidian" ? " · imported" : ""}</div>
          <input
            aria-label="Note title"
            className="w-full bg-transparent text-[17px] text-ink outline-none"
            value={titleDraft ?? doc.title}
            disabled={archived}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              if (e.key === "Escape") setTitleDraft(null);
            }}
          />
        </div>
        <span className={cn("shrink-0 text-[11.5px]", doc.state === "error" || doc.state === "conflict" ? "text-danger" : doc.state === "saved" ? "text-ink-3" : "text-accent-soft")} data-testid="save-state" title={doc.error ?? undefined}>
          {STATE_TEXT[doc.state]}
          {doc.state === "saved" ? ` · v${doc.version}` : ""}
        </span>
        <div className="flex rounded-[8px] border border-line p-0.5">
          {(["edit", "split", "preview"] as EditorMode[]).map((m) => (
            <button key={m} onClick={() => onMode(m)} title={m === "edit" ? "Markdown (Ctrl+E)" : m === "split" ? "Markdown and preview" : "Preview (Ctrl+E)"} aria-pressed={mode === m} className={cn("grid size-7 place-items-center rounded-[6px] [&_svg]:size-3.5", mode === m ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink")}>
              {m === "edit" ? <PencilLine /> : m === "split" ? <Columns2 /> : <Eye />}
            </button>
          ))}
        </div>
        {tool("History", <History />, () => setHistory(true))}
        {tool("Move to folder", <FolderInput />, () => setMoving(true))}
        <CollectionButton kind="document" id={id} />
        {tool(showLinks ? "Hide links panel" : "Show links panel", <PanelRight />, () => (narrow ? setLinksForced(!showLinks) : setShowLinks(!showLinks)))}
        {archived
          ? <Button size="sm" onClick={() => void rpc("docs.restore", { id }).then(() => refreshDoc(id))}>Restore</Button>
          : tool("Archive note", <Archive />, () => void saveDoc(id).then(() => rpc("docs.archive", { id })).then(() => (refreshDoc(id), toast({ kind: "ok", text: "Archived. Restore it from Library → Archive." }))).catch((e) => toast({ kind: "error", text: e.message })))}
      </div>

      {doc.recoveredDraft !== null ? (
        <Banner tone="accent">
          Unsaved text from an earlier session was found for this note.
          <Button size="sm" onClick={() => restoreDraft(id)}>Use it</Button>
          <Button size="sm" variant="ghost" onClick={() => dismissDraft(id)}>Discard</Button>
        </Banner>
      ) : null}
      {doc.state === "conflict" ? (
        <Banner tone="danger">
          This note was changed somewhere else while you were editing. Your text is kept here.
          <Button size="sm" onClick={() => void saveDoc(id, { overwrite: true })}>Keep mine</Button>
          <Button size="sm" variant="ghost" onClick={() => void discardLocal(id)}>Use the saved version</Button>
        </Banner>
      ) : null}
      {doc.state === "error" ? (
        <Banner tone="danger">
          Couldn't save: {doc.error}. Your text is kept (also as a draft on this computer).
          <Button size="sm" onClick={() => void saveDoc(id)}>Try again</Button>
        </Banner>
      ) : null}
      {archived ? <Banner tone="neutral">This note is archived. Restore it to edit.</Banner> : null}

      <div className="relative flex min-h-0 flex-1">
        <div className={cn("grid min-h-0 min-w-0 flex-1", mode === "split" && "grid-cols-2")}>
          {mode !== "preview" ? (
            <div className="flex min-h-0 flex-col border-r border-line last:border-r-0">
              <div className="flex items-center gap-0.5 border-b border-line px-2 py-1">
                {tool("Bold (Ctrl+B)", <Bold />, () => insert("**", "**", "bold"))}
                {tool("Italic (Ctrl+I)", <Italic />, () => insert("*", "*", "italic"))}
                {tool("Heading", <Heading2 />, () => linePrefix("## "))}
                {tool("List", <List />, () => linePrefix("- "))}
                {tool("Checklist", <CheckSquare />, () => linePrefix("- [ ] "))}
                {tool("Table", <Table />, () => insert("\n| Column | Column |\n|---|---|\n| ", " |  |\n", "text"))}
                {tool("Code block", <Code2 />, () => insert("\n```\n", "\n```\n", "code"))}
                {tool("Link to a note (Ctrl+K)", <Link2 />, () => insert("[[", "]]", "Note"))}
                {tool("Tag", <Hash />, () => insert("#", "", "tag"))}
              </div>
              <div className="relative min-h-0 flex-1">
                <pre ref={pre} aria-hidden className="moth-src pointer-events-none absolute inset-0 overflow-hidden" dangerouslySetInnerHTML={{ __html: highlightSource(doc.text) + "\n" }} />
                <textarea
                  ref={ta}
                  aria-label="Note text (Markdown)"
                  className="moth-src absolute inset-0 resize-none bg-transparent text-transparent caret-[var(--color-accent-soft)] outline-none selection:bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
                  spellCheck
                  value={doc.text}
                  readOnly={archived}
                  onChange={(e) => editDoc(id, e.target.value)}
                  onKeyDown={onKey}
                  onBlur={() => void saveDoc(id)}
                  onScroll={(e) => {
                    if (pre.current) pre.current.scrollTop = e.currentTarget.scrollTop;
                  }}
                />
              </div>
            </div>
          ) : null}
          {mode !== "edit" ? (
            <div className="min-h-0 overflow-y-auto px-8 py-6">
              <article className="moth-prose selectable" onClick={(e) => void onPreviewClick(e)} dangerouslySetInnerHTML={{ __html: html }} data-testid="note-preview" />
            </div>
          ) : null}
        </div>
        {showLinks ? <LinksPanel id={id} links={links} onOpen={onOpen} reload={reloadLinks} overlay={narrow} /> : null}
      </div>
      <HistoryDialog id={id} open={history} onClose={() => setHistory(false)} />
      <MoveDialog id={id} open={moving} onClose={() => setMoving(false)} currentFolder={d.folder_id ?? null} />
    </div>
  );
}

function Banner({ tone, children }: { tone: "accent" | "danger" | "neutral"; children: ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[12.5px]", tone === "danger" ? "border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] text-danger" : tone === "accent" ? "border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent-soft" : "border-line text-ink-2")}>
      {children}
    </div>
  );
}

function LinksPanel({ id, links, onOpen, reload, overlay }: { id: string; links: any; onOpen: (kind: string, id: string, opts?: { split?: boolean }) => void; reload: () => void; overlay?: boolean }) {
  const { toast } = useApp();
  const Section = ({ title, n, children }: { title: string; n: number; children: ReactNode }) => (
    <section className="mb-4">
      <h3 className="mb-1 text-[11px] uppercase tracking-[0.12em] text-ink-3">
        {title} <span className="tabular-nums">{n}</span>
      </h3>
      {children}
    </section>
  );
  const item = (key: string | number, label: ReactNode, sub: ReactNode, onClick?: () => void, extra?: ReactNode) => (
    <li key={key} className="group rounded-[7px] px-1.5 py-1 hover:bg-surface-2">
      <div className="flex items-center gap-1">
        <button className="min-w-0 flex-1 truncate text-left text-[12.5px] text-ink" onClick={onClick} disabled={!onClick}>
          {label}
        </button>
        {extra}
      </div>
      {sub ? <div className="line-clamp-2 text-[11.5px] text-ink-3">{sub}</div> : null}
    </li>
  );
  if (!links) return <aside className="w-[260px] shrink-0 border-l border-line" />;
  return (
    <aside className={cn("w-[270px] shrink-0 overflow-y-auto border-l border-line p-3", overlay && "absolute bottom-0 right-0 top-0 z-10 bg-sidebar shadow-[-16px_0_40px_rgba(0,0,0,0.4)]")} data-testid="links-panel" aria-label="Links">
      <Section title="Linked from" n={links.incoming.length}>
        <ul>{links.incoming.map((l: any) => item(l.id, l.source_title, l.context, () => onOpen("document", l.source_id)))}</ul>
        {!links.incoming.length ? <p className="text-[12px] text-ink-3">No note links here yet.</p> : null}
      </Section>
      <Section title="Links to" n={links.outgoing.filter((o: any) => ["document", "memory", "attachment"].includes(o.target_kind)).length}>
        <ul>
          {links.outgoing
            .filter((o: any) => ["document", "memory", "attachment"].includes(o.target_kind))
            .map((o: any) =>
              item(
                o.id,
                <span>
                  {o.target_title ?? o.target_text}
                  {o.target_kind === "memory" ? <Badge className="ml-1">memory</Badge> : o.target_kind === "attachment" ? <Badge className="ml-1">file</Badge> : null}
                  {o.created_by === "user" ? <Badge className="ml-1">added by you</Badge> : null}
                </span>,
                o.heading ? `› ${o.heading}` : null,
                o.target_kind === "document" || o.target_kind === "memory" ? () => onOpen(o.target_kind, o.target_id) : undefined,
                o.created_by === "user" ? (
                  <button className="hidden text-ink-3 hover:text-danger group-hover:block" aria-label="Remove link" onClick={() => void rpc("docs.unlink", { link_id: o.id }).then(reload)}>
                    <X className="size-3.5" />
                  </button>
                ) : null,
              ),
            )}
        </ul>
      </Section>
      {links.unresolved.length ? (
        <Section title="Unresolved" n={links.unresolved.length}>
          <ul>
            {links.unresolved.map((u: any) =>
              item(u.id, <span className="text-ink-2">{u.target_text}</span>, u.status === "ambiguous" ? `Several notes match: ${u.candidates.map((c: any) => c.path).join(", ")}` : "No note with this name yet"),
            )}
          </ul>
        </Section>
      ) : null}
      <Section title="Suggestions" n={links.suggestions.length}>
        <p className="mb-1 text-[11px] text-ink-3">Word-based suggestions, not links. Link one to keep it.</p>
        <ul>
          {links.suggestions.map((s: any) =>
            item(
              `${s.kind}-${s.id}`,
              <span className="text-ink-2">
                {s.title} {s.kind === "memory" ? <Badge>memory</Badge> : null}
              </span>,
              null,
              () => onOpen(s.kind, s.id),
              <button
                className="text-[11px] text-accent hover:text-accent-soft"
                onClick={() =>
                  void rpc("docs.link", { id, target_kind: s.kind, target_id: s.id })
                    .then(() => (toast({ kind: "ok", text: "Linked" }), reload()))
                    .catch((e) => toast({ kind: "error", text: e.message }))
                }
              >
                Link
              </button>,
            ),
          )}
        </ul>
      </Section>
    </aside>
  );
}

function HistoryDialog({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) {
  const { toast } = useApp();
  const { data: revs, reload } = useLive<any[]>("docs.revisions", { id }, { entities: ["document"], enabled: open });
  const [sel, setSel] = useState<number | null>(null);
  const { data: rev } = useLive<any>("docs.revision", { id: sel }, { entities: [], enabled: open && sel !== null });
  return (
    <Dialog open={open} onClose={onClose} title="Note history" width={820}>
      <div className="grid h-[460px] grid-cols-[240px_1fr] gap-3">
        <ul className="overflow-y-auto border-r border-line pr-2">
          {(revs ?? []).map((r) => (
            <li key={r.id}>
              <button onClick={() => setSel(r.id)} className={cn("w-full rounded-[7px] px-2 py-1.5 text-left", sel === r.id ? "bg-surface-2" : "hover:bg-surface")}>
                <div className="text-[12.5px] text-ink">Version {r.version}</div>
                <div className="text-[11px] text-ink-3">
                  {timeAgo(r.created_at)} · {r.reason}
                </div>
              </button>
            </li>
          ))}
          {revs && !revs.length ? <li className="p-2 text-[12px] text-ink-3">No earlier versions yet. MOTH keeps one every 10 minutes of editing, and before renames and restores.</li> : null}
        </ul>
        <div className="flex min-h-0 flex-col">
          {rev ? (
            <>
              <pre className="selectable min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-bg p-3 text-[12px] text-ink-2">{rev.content}</pre>
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    try {
                      await saveDoc(id);
                      await rpc("docs.restoreRevision", { id: rev.id });
                      await refreshDoc(id);
                      void reload();
                      toast({ kind: "ok", text: `Restored version ${rev.version}. The text before it is kept in history.` });
                      onClose();
                    } catch (e) {
                      toast({ kind: "error", text: (e as Error).message });
                    }
                  }}
                >
                  <RotateCcw /> Restore this version
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[12.5px] text-ink-3">Pick a version to see it.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function MoveDialog({ id, open, onClose, currentFolder }: { id: string; open: boolean; onClose: () => void; currentFolder: string | null }) {
  const { toast } = useApp();
  const { data: tree } = useLive<any[]>("library.tree", {}, { entities: ["folder" as any], enabled: open });
  const [target, setTarget] = useState<string>("");
  const paths = useMemo(() => folderPaths(tree ?? []), [tree]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move note"
      footer={
        <Button
          variant="primary"
          onClick={async () => {
            try {
              await saveDoc(id);
              const r = await rpc<any>("docs.move", { id, folder_id: target || null });
              await refreshDoc(id);
              toast({ kind: "ok", text: r.links_updated ? `Moved. Updated ${r.links_updated} link${r.links_updated === 1 ? "" : "s"}.` : "Moved" });
              onClose();
            } catch (e) {
              toast({ kind: "error", text: (e as Error).message });
            }
          }}
        >
          Move
        </Button>
      }
    >
      <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Folder" className="w-full">
        <option value="">Library (top level)</option>
        {paths.filter((p) => p.id !== currentFolder).map((p) => (
          <option key={p.id} value={p.id}>
            {p.path}
          </option>
        ))}
      </Select>
      <p className="mt-2 text-[12px] text-ink-3">Links written as a folder path are updated so they keep working.</p>
    </Dialog>
  );
}

export function folderPaths(tree: any[]): { id: string; path: string; depth: number }[] {
  const byParent = new Map<string | null, any[]>();
  for (const f of tree) (byParent.get(f.parent_id ?? null) ?? byParent.set(f.parent_id ?? null, []).get(f.parent_id ?? null)!).push(f);
  const out: { id: string; path: string; depth: number }[] = [];
  const walk = (parent: string | null, prefix: string, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      const p = prefix ? `${prefix}/${f.name}` : f.name;
      out.push({ id: f.id, path: p, depth });
      if (depth < 40) walk(f.id, p, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}

