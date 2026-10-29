// Knowledge Library: everything you know in one place — your notes, imported vaults, memories and projects —
// with folders, collections, tags and files, and a workspace of tabs (up to two panes) on the right.
import { Archive, Brain, ChevronRight, FilePlus2, FileText, Folder, FolderKanban, FolderPlus, Hash, History, Import, Layers, Library as LibraryIcon, Link2Off, Paperclip, Search, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImportWizard, fmtBytes } from "../components/ImportWizard";
import { folderPaths } from "../components/NoteEditor";
import { Badge, Button, ContextMenu, Dialog, Input, Select } from "../components/ui";
import { WorkspaceProvider, WorkspaceView, useWorkspace } from "../components/Workspace";
import { endpoint, rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { openExternal } from "../lib/tauri";
import { cn, timeAgo } from "../lib/utils";

type View =
  | { kind: "all" }
  | { kind: "notes" }
  | { kind: "imported"; batch?: string }
  | { kind: "memories" }
  | { kind: "projects" }
  | { kind: "folder"; id: string | null }
  | { kind: "collection"; id: string; name: string }
  | { kind: "tag"; tag: string }
  | { kind: "attachments" }
  | { kind: "links" }
  | { kind: "archive" }
  | { kind: "imports" };

export function LibraryPage() {
  return (
    <WorkspaceProvider>
      <LibraryInner />
    </WorkspaceProvider>
  );
}

function LibraryInner() {
  const { params, toast } = useApp();
  const ws = useWorkspace();
  const [view, setView] = useState<View>({ kind: "all" });
  const [wizard, setWizard] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [listOpen, setListOpen] = useState(true);
  // Other pages open notes here with go("library", { open: id }).
  useEffect(() => {
    if (!ws.restored) return;
    if (params.open?.startsWith("doc_")) ws.open("document", params.open);
    if (params.open?.startsWith("mem_")) ws.open("memory", params.open);
    if (params.import === "1") setWizard({ open: true, id: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.open, params.import, ws.restored]);
  const newNote = async (folderId: string | null = view.kind === "folder" ? view.id : null) => {
    try {
      const d = await rpc<any>("docs.create", { title: "Untitled", content: "", folder_id: folderId });
      ws.open("document", d.id);
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <div className="flex h-full min-h-0" data-testid="library">
      <Sidebar view={view} setView={setView} onImport={() => setWizard({ open: true, id: null })} onNewNote={newNote} />
      {listOpen ? <ListColumn view={view} onNewNote={newNote} onResumeImport={(id) => setWizard({ open: true, id })} onCollapse={() => setListOpen(false)} /> : (
        <button className="w-6 shrink-0 border-r border-line text-ink-3 hover:text-ink" onClick={() => setListOpen(true)} aria-label="Show list" title="Show list">
          <ChevronRight className="mx-auto size-3.5" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <WorkspaceView />
      </div>
      <ImportWizard open={wizard.open} resumeId={wizard.id} onClose={() => setWizard({ open: false, id: null })} onOpenLibrary={(batch) => setView({ kind: "imported", batch })} />
    </div>
  );
}

// ------------------------------------------------------------------ sidebar
function Sidebar({ view, setView, onImport, onNewNote }: { view: View; setView: (v: View) => void; onImport: () => void; onNewNote: (folder?: string | null) => void }) {
  const { toast } = useApp();
  const ws = useWorkspace();
  const { data: stats } = useLive<any>("library.stats", {}, { entities: ["document", "folder", "collection", "memory", "project"] });
  const { data: tree, reload: reloadTree } = useLive<any[]>("library.tree", {}, { entities: ["folder", "document"] });
  const { data: cols, reload: reloadCols } = useLive<any[]>("collections.list", {}, { entities: ["collection"] });
  const { data: tags } = useLive<any[]>("library.tags", {}, { entities: ["document"] });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; folder: any } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; value: string; run: (v: string) => Promise<unknown> } | null>(null);
  const [moving, setMoving] = useState<any | null>(null);
  const byParent = useMemo(() => {
    const m = new Map<string | null, any[]>();
    for (const f of tree ?? []) (m.get(f.parent_id ?? null) ?? m.set(f.parent_id ?? null, []).get(f.parent_id ?? null)!).push(f);
    return m;
  }, [tree]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ kind: "ok", text: ok });
      void reloadTree();
      void reloadCols();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const item = (v: View, label: ReactNode, icon: ReactNode, count?: number) => {
    const active = JSON.stringify(view) === JSON.stringify(v);
    return (
      <button key={JSON.stringify(v)} onClick={() => setView(v)} className={cn("flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[12.5px] [&>svg]:size-3.5 [&>svg]:shrink-0", active ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink")}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined ? <span className="text-[11px] tabular-nums text-ink-3">{count.toLocaleString()}</span> : null}
      </button>
    );
  };
  const folderNode = (f: any, depth: number): ReactNode => {
    const kids = byParent.get(f.id) ?? [];
    const isOpen = open.has(f.id);
    const active = view.kind === "folder" && view.id === f.id;
    return (
      <div key={f.id}>
        <div
          className={cn("flex items-center gap-1 rounded-[7px] py-0.5 pr-2 text-[12.5px]", active ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink")}
          style={{ paddingLeft: 4 + depth * 12 }}
          onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, folder: f }))}
        >
          <button aria-label={isOpen ? "Collapse" : "Expand"} className={cn("grid size-4 place-items-center text-ink-3", !kids.length && "invisible")} onClick={() => setOpen((s) => (s.has(f.id) ? (s.delete(f.id), new Set(s)) : new Set(s.add(f.id))))}>
            <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
          </button>
          <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setView({ kind: "folder", id: f.id })}>
            <Folder className="size-3.5 shrink-0 text-ink-3" />
            <span className="truncate">{f.name}</span>
          </button>
          {f.notes ? <span className="text-[10.5px] tabular-nums text-ink-3">{f.notes}</span> : null}
        </div>
        {isOpen ? kids.map((k) => folderNode(k, depth + 1)) : null}
      </div>
    );
  };
  return (
    <aside className="flex w-[230px] shrink-0 flex-col border-r border-line bg-sidebar" aria-label="Library sections">
      <div className="flex gap-1.5 p-2.5">
        <Button size="sm" variant="primary" className="flex-1" onClick={() => onNewNote()}>
          <FilePlus2 /> New note
        </Button>
        <Button size="sm" title="New folder" aria-label="New folder" onClick={() => setPrompt({ title: "New folder", value: "", run: (v) => rpc("library.folder.create", { name: v, parent_id: view.kind === "folder" ? view.id : null }) })}>
          <FolderPlus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {item({ kind: "all" }, "All knowledge", <LibraryIcon />)}
        {item({ kind: "notes" }, "My notes", <FileText />, stats?.notes)}
        {item({ kind: "imported" }, "Imported vaults", <Import />, stats?.imported)}
        {item({ kind: "memories" }, "Memories", <Brain />, stats?.memories)}
        {item({ kind: "projects" }, "Projects", <FolderKanban />, stats?.projects)}
        <button onClick={() => ws.open("mind")} className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[12.5px] text-ink-2 hover:text-ink [&>svg]:size-3.5">
          <Sparkles /> The Mind in a tab
        </button>
        <SectionLabel>Folders</SectionLabel>
        {item({ kind: "folder", id: null }, "Library (top level)", <Folder />)}
        {(byParent.get(null) ?? []).map((f) => folderNode(f, 0))}
        <SectionLabel action={<button className="text-ink-3 hover:text-ink" onClick={() => setPrompt({ title: "New collection", value: "", run: (v) => rpc("collections.create", { name: v }) })} aria-label="New collection">+</button>}>Collections</SectionLabel>
        {(cols ?? []).map((c) => item({ kind: "collection", id: c.id, name: c.name }, c.name, <Layers />, c.items))}
        {!cols?.length ? <p className="px-2 text-[11.5px] text-ink-3">Group notes, memories and projects without moving them.</p> : null}
        <SectionLabel>Tags</SectionLabel>
        <div className="flex flex-wrap gap-1 px-1.5">
          {(tags ?? []).slice(0, 30).map((t) => (
            <button key={t.tag} onClick={() => setView({ kind: "tag", tag: t.tag })} className={cn("rounded-full border px-1.5 text-[11px]", view.kind === "tag" && view.tag === t.tag ? "border-accent/60 text-ink" : "border-line text-ink-3 hover:text-ink")}>
              #{t.tag}
            </button>
          ))}
          {!tags?.length ? <p className="text-[11.5px] text-ink-3">#tags in notes appear here.</p> : null}
        </div>
        <SectionLabel>More</SectionLabel>
        {item({ kind: "attachments" }, "Files", <Paperclip />, stats?.attachments)}
        {item({ kind: "links" }, "Unresolved links", <Link2Off />, stats?.unresolved_links)}
        {item({ kind: "archive" }, "Archive", <Archive />, stats?.archived)}
        {item({ kind: "imports" }, "Import history", <History />)}
        <button onClick={onImport} className="mt-1 flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left text-[12.5px] text-accent hover:text-accent-soft [&>svg]:size-3.5">
          <Import /> Import Obsidian vault
        </button>
      </div>
      <ContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                { label: "New note here", onSelect: () => onNewNote(menu.folder.id) },
                { label: "New folder inside", onSelect: () => setPrompt({ title: "New folder", value: "", run: (v) => rpc("library.folder.create", { name: v, parent_id: menu.folder.id }) }) },
                { label: "Rename", onSelect: () => setPrompt({ title: "Rename folder", value: menu.folder.name, run: (v) => rpc("library.folder.rename", { id: menu.folder.id, name: v }) }) },
                { label: "Move…", onSelect: () => setMoving(menu.folder) },
                { label: "Delete (only when empty)", danger: true, onSelect: () => void run(() => rpc("library.folder.delete", { id: menu.folder.id }), "Folder deleted") },
              ]
            : []
        }
      />
      <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} onDone={() => (void reloadTree(), void reloadCols())} />
      {moving ? <MoveFolderDialog folder={moving} tree={tree ?? []} onClose={() => setMoving(null)} onDone={() => void reloadTree()} /> : null}
    </aside>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-0.5 mt-3 flex items-center justify-between px-2 text-[10.5px] uppercase tracking-[0.14em] text-ink-3">
      {children}
      {action}
    </div>
  );
}

function PromptDialog({ prompt, onClose, onDone }: { prompt: { title: string; value: string; run: (v: string) => Promise<unknown> } | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [v, setV] = useState("");
  useEffect(() => setV(prompt?.value ?? ""), [prompt]);
  const submit = async () => {
    try {
      await prompt!.run(v.trim());
      onDone();
      onClose();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <Dialog open={!!prompt} onClose={onClose} title={prompt?.title ?? ""} width={420} footer={<Button variant="primary" onClick={() => void submit()} disabled={!v.trim()}>Save</Button>}>
      <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && v.trim() && void submit()} aria-label="Name" />
    </Dialog>
  );
}

function MoveFolderDialog({ folder, tree, onClose, onDone }: { folder: any; tree: any[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [target, setTarget] = useState("");
  const paths = folderPaths(tree);
  const inside = new Set<string>([folder.id]);
  for (const p of paths) if ([...inside].some((id) => paths.find((x) => x.id === id) && p.path.startsWith(`${paths.find((x) => x.id === id)!.path}/`))) inside.add(p.id);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move "${folder.name}"`}
      width={440}
      footer={
        <Button variant="primary" onClick={() => void rpc("library.folder.move", { id: folder.id, parent_id: target || null }).then(() => (onDone(), onClose())).catch((e) => toast({ kind: "error", text: e.message }))}>
          Move
        </Button>
      }
    >
      <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full" aria-label="Destination">
        <option value="">Library (top level)</option>
        {paths.filter((p) => !inside.has(p.id)).map((p) => (
          <option key={p.id} value={p.id}>
            {p.path}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}

// ------------------------------------------------------------------ list column
const ROW = 60;

function ListColumn({ view, onNewNote, onResumeImport, onCollapse }: { view: View; onNewNote: (f?: string | null) => void; onResumeImport: (id: string) => void; onCollapse: () => void }) {
  const ws = useWorkspace();
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<"updated" | "title" | "created">("updated");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 180);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setQ(""), [view.kind]);

  const docFilter: any = useMemo(() => {
    const f: any = { sort: debounced ? undefined : sort, q: debounced || undefined };
    if (view.kind === "notes") f.source = "note";
    if (view.kind === "imported") f.source = "obsidian";
    if (view.kind === "imported" && view.batch) f.batch = view.batch;
    if (view.kind === "folder") f.folder_id = view.id;
    if (view.kind === "collection") f.collection = view.id;
    if (view.kind === "tag") f.tag = view.tag;
    if (view.kind === "archive") f.status = "archived";
    return f;
  }, [view, debounced, sort]);
  const showsDocs = ["all", "notes", "imported", "folder", "collection", "tag", "archive"].includes(view.kind);
  const docs = usePaged(showsDocs ? docFilter : null);
  const { data: mems } = useLive<any>(
    debounced ? "search" : "memories.list",
    debounced ? { query: debounced, limit: 50 } : { status: "active", limit: 200, order: sort === "title" ? "title" : sort === "created" ? "created" : "updated" },
    { entities: ["memory"], enabled: view.kind === "memories" || (view.kind === "all" && !!debounced) },
  );
  const { data: projects } = useLive<any[]>("projects.list", {}, { entities: ["project"], enabled: view.kind === "projects" });
  const { data: colItems } = useLive<any[]>("collections.items", { id: view.kind === "collection" ? view.id : "" }, { entities: ["collection"], enabled: view.kind === "collection" });
  const title =
    view.kind === "all" ? "All knowledge" : view.kind === "notes" ? "My notes" : view.kind === "imported" ? (view.batch ? "Imported notes" : "Imported vaults") : view.kind === "memories" ? "Memories" : view.kind === "projects" ? "Projects"
    : view.kind === "folder" ? "Folder" : view.kind === "collection" ? view.name : view.kind === "tag" ? `#${view.tag}` : view.kind === "attachments" ? "Files" : view.kind === "links" ? "Unresolved links" : view.kind === "archive" ? "Archive" : "Import history";

  let content: ReactNode;
  if (view.kind === "imports") content = <ImportHistory onResume={onResumeImport} />;
  else if (view.kind === "attachments") content = <Attachments />;
  else if (view.kind === "links") content = <Unresolved onOpen={(id) => ws.open("document", id)} />;
  else if (view.kind === "projects")
    content = <SimpleList items={(projects ?? []).map((p) => ({ key: p.id, title: p.name, sub: `${p.memory_count ?? 0} memories`, onClick: () => ws.open("project", p.id, { title: p.name }) }))} empty="No projects yet." />;
  else if (view.kind === "memories") {
    const list = debounced ? (mems ?? []).map((r: any) => r.memory) : mems?.items ?? [];
    content = <SimpleList items={list.map((m: any) => ({ key: m.id, title: m.title, sub: `memory · ${timeAgo(m.updated_at)}`, onClick: () => ws.open("memory", m.id, { title: m.title }) }))} empty="No memories match." />;
  } else {
    const extraMems = view.kind === "all" && debounced ? (mems ?? []).slice(0, 20).map((r: any) => r.memory) : [];
    const colOthers = view.kind === "collection" ? (colItems ?? []).filter((i) => i.entity_kind !== "document") : [];
    content = (
      <>
        {extraMems.length ? (
          <div className="border-b border-line px-3 py-2">
            <div className="mb-1 text-[10.5px] uppercase tracking-[0.12em] text-ink-3">Memories</div>
            {extraMems.map((m: any) => (
              <button key={m.id} onClick={() => ws.open("memory", m.id, { title: m.title })} className="block w-full truncate rounded px-1 py-0.5 text-left text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                <Brain className="mr-1 inline size-3 text-ink-3" />
                {m.title}
              </button>
            ))}
          </div>
        ) : null}
        {colOthers.length ? (
          <div className="border-b border-line px-3 py-2">
            {colOthers.map((i) => (
              <button key={i.entity_id} onClick={() => ws.open(i.entity_kind as "memory" | "project", i.entity_id, { title: i.title })} className="block w-full truncate rounded px-1 py-0.5 text-left text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                {i.entity_kind === "memory" ? <Brain className="mr-1 inline size-3" /> : <FolderKanban className="mr-1 inline size-3" />}
                {i.title}
              </button>
            ))}
          </div>
        ) : null}
        <DocList pager={docs} onOpen={(d, split) => ws.open("document", d.id, { split, title: d.title })} empty={
          view.kind === "folder" ? (
            <span>
              Empty folder. <button className="text-accent" onClick={() => onNewNote(view.id)}>Create a note</button>
            </span>
          ) : view.kind === "archive" ? "Nothing archived." : debounced ? "No notes match." : "No notes yet. Create one, or import an Obsidian vault."
        } />
      </>
    );
  }
  return (
    <section className="flex w-[300px] shrink-0 flex-col border-r border-line" aria-label="Items">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{title}</h2>
        {showsDocs ? <span className="text-[11px] tabular-nums text-ink-3">{docs.total?.toLocaleString() ?? ""}</span> : null}
        <button className="text-ink-3 hover:text-ink" aria-label="Hide list" title="Hide list" onClick={onCollapse}>
          <ChevronRight className="size-3.5 rotate-180" />
        </button>
      </div>
      {["imports", "attachments", "links", "projects"].includes(view.kind) ? null : (
        <div className="flex gap-1.5 px-3 pb-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1.5 size-3.5 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={view.kind === "all" ? "Search notes and memories" : "Search"} className="h-7 pl-7 text-[12.5px]" aria-label="Search" />
          </div>
          <Select value={sort} onChange={(e) => setSort(e.target.value as any)} className="h-7 text-[12px]" aria-label="Sort">
            <option value="updated">Recent</option>
            <option value="title">A–Z</option>
            <option value="created">Created</option>
          </Select>
        </div>
      )}
      <div className="min-h-0 flex-1">{content}</div>
      {view.kind === "collection" ? (
        <div className="border-t border-line p-2 text-[11px] text-ink-3">
          Add notes and memories with the collection button in their tab.{" "}
          <button className="text-danger" onClick={() => void rpc("collections.delete", { id: view.id }).then(() => toast({ kind: "ok", text: "Collection removed (its notes are untouched)" }))}>
            Delete collection
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Pages through notes 200 at a time as you scroll (large libraries never load at once). */
function usePaged(filter: any | null) {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(filter);
  const seq = useRef(0);
  const load = async (offset: number) => {
    if (!filter) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const r = await rpc<any>("library.list", { ...filter, offset, limit: 200 });
      if (n !== seq.current) return;
      setTotal(r.total);
      setItems((cur) => (offset ? [...cur, ...r.items] : r.items));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    setItems([]);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Live refresh on library changes (reloads the first page).
  const { data: stamp } = useLive<any>("library.stats", {}, { entities: ["document"], enabled: !!filter });
  useEffect(() => {
    if (stamp) void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(stamp)]);
  return { items, total, loading, more: () => (total !== null && items.length < total && !loading ? void load(items.length) : undefined) };
}

function DocList({ pager, onOpen, empty }: { pager: ReturnType<typeof usePaged>; onOpen: (d: any, split: boolean) => void; empty: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { items } = pager;
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const last = Math.min(items.length, Math.ceil((top + h) / ROW) + 5);
  if (!items.length && pager.total === 0) return <p className="px-4 py-3 text-[12.5px] text-ink-3">{empty}</p>;
  return (
    <div
      ref={ref}
      className="h-full overflow-y-auto"
      data-testid="doc-list"
      onScroll={(e) => {
        const el = e.currentTarget;
        setTop(el.scrollTop);
        if (el.scrollTop + el.clientHeight > el.scrollHeight - ROW * 10) pager.more();
      }}
    >
      <div style={{ height: items.length * ROW, position: "relative" }}>
        {items.slice(first, last).map((d, i) => (
          <button
            key={d.id}
            onClick={(e) => onOpen(d, e.ctrlKey || e.metaKey)}
            className="absolute left-0 right-0 border-b border-line px-3 py-2 text-left hover:bg-surface"
            style={{ top: (first + i) * ROW, height: ROW }}
            title="Click to open · Ctrl+click to open in a second pane"
          >
            <div className="flex items-center gap-1.5">
              <FileText className="size-3.5 shrink-0 text-ink-3" />
              <span className="truncate text-[12.5px] text-ink">{d.title}</span>
              {d.source === "obsidian" ? <span className="ml-auto shrink-0 text-[10px] text-ink-3">imported</span> : null}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
              {timeAgo(d.updated_at)}
              {d.tags?.length ? ` · ${d.tags.slice(0, 3).map((t: string) => `#${t}`).join(" ")}` : ""}
              {d.excerpt ? ` · ${d.excerpt}` : ""}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SimpleList({ items, empty }: { items: { key: string; title: string; sub: string; onClick: () => void }[]; empty: string }) {
  if (!items.length) return <p className="px-4 py-3 text-[12.5px] text-ink-3">{empty}</p>;
  return (
    <div className="h-full overflow-y-auto">
      {items.map((i) => (
        <button key={i.key} onClick={i.onClick} className="block w-full border-b border-line px-3 py-2 text-left hover:bg-surface">
          <div className="truncate text-[12.5px] text-ink">{i.title}</div>
          <div className="truncate text-[11.5px] text-ink-3">{i.sub}</div>
        </button>
      ))}
    </div>
  );
}

function ImportHistory({ onResume }: { onResume: (id: string) => void }) {
  const { toast } = useApp();
  const { data, reload } = useLive<any[]>("import.list", {}, { entities: ["import"] });
  const [undo, setUndo] = useState<any | null>(null);
  return (
    <div className="h-full overflow-y-auto p-2" data-testid="import-history">
      {(data ?? []).map((b) => (
        <div key={b.id} className="mb-2 rounded-[10px] border border-line p-2.5 text-[12px]">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-ink">{b.scan?.vault_name ?? b.source_root}</span>
            <Badge tone={b.status === "done" ? "ok" : ["failed", "cancelled"].includes(b.status) ? "warn" : b.status === "undone" ? "neutral" : "accent"}>{b.status}</Badge>
          </div>
          <div className="mt-0.5 text-ink-3">
            {timeAgo(b.created_at)}
            {b.result?.notes !== undefined ? ` · ${b.result.notes.toLocaleString()} notes, ${b.result.attachments.toLocaleString()} files` : b.scan?.notes !== undefined ? ` · ${b.scan.notes.toLocaleString()} notes found` : ""}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            {["scanning", "scanned", "importing", "paused"].includes(b.status) ? <Button size="sm" onClick={() => onResume(b.id)}>Open</Button> : null}
            {["done", "cancelled", "failed", "paused"].includes(b.status) ? (
              <Button size="sm" variant="ghost" onClick={() => void rpc("import.undoPreview", { id: b.id }).then(setUndo).catch((e) => toast({ kind: "error", text: e.message }))}>
                <Undo2 /> Undo…
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {data && !data.length ? <p className="px-2 text-[12.5px] text-ink-3">No imports yet.</p> : null}
      <Dialog
        open={!!undo}
        onClose={() => setUndo(null)}
        title="Undo this import?"
        width={520}
        footer={
          <Button
            variant="danger"
            onClick={() =>
              void rpc<any>("import.undo", { id: undo.batch })
                .then((r) => (toast({ kind: "ok", text: `Removed ${r.removed_notes.toLocaleString()} imported notes${r.kept_notes ? `; kept ${r.kept_notes} you worked on` : ""}.` }), setUndo(null), reload()))
                .catch((e) => toast({ kind: "error", text: e.message }))
            }
          >
            Remove {undo?.will_remove?.toLocaleString()} notes
          </Button>
        }
      >
        {undo ? (
          <div className="grid gap-2 text-[12.5px] text-ink-2">
            <p>This removes the notes, folders and files this import added. Your Obsidian vault isn't affected.</p>
            {undo.kept_edited.length || undo.kept_linked_from_your_notes.length || undo.kept_with_your_links.length ? (
              <p>
                Kept because they contain your later work: {undo.kept_edited.length} edited, {undo.kept_linked_from_your_notes.length} linked from your own notes, {undo.kept_with_your_links.length} with links you added.
              </p>
            ) : null}
            <p className="text-ink-3">{undo.note}</p>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function Attachments() {
  const { data } = useLive<any>("library.attachments", { limit: 200 }, { entities: ["document"] });
  const open = async (id: string) => {
    const ep = await endpoint();
    void openExternal(`http://127.0.0.1:${ep.port}/api/attachments/${id}?token=${encodeURIComponent(ep.token)}`);
  };
  return (
    <div className="h-full overflow-y-auto">
      {(data?.items ?? []).map((a: any) => (
        <button key={a.id} onClick={() => void open(a.id)} className="block w-full border-b border-line px-3 py-2 text-left hover:bg-surface">
          <div className="truncate text-[12.5px] text-ink">{a.original_name}</div>
          <div className="text-[11.5px] text-ink-3">
            {fmtBytes(a.size)} · used by {a.refs} note{a.refs === 1 ? "" : "s"}
          </div>
        </button>
      ))}
      {data && !data.items.length ? <p className="px-4 py-3 text-[12.5px] text-ink-3">Files imported with a vault appear here.</p> : null}
    </div>
  );
}

function Unresolved({ onOpen }: { onOpen: (id: string) => void }) {
  const { data } = useLive<any[]>("library.unresolved", { limit: 500 }, { entities: ["document"] });
  return (
    <div className="h-full overflow-y-auto">
      {(data ?? []).map((l) => (
        <button key={l.id} onClick={() => onOpen(l.source_id)} className="block w-full border-b border-line px-3 py-2 text-left hover:bg-surface">
          <div className="truncate text-[12.5px] text-ink">{l.target_text}</div>
          <div className="truncate text-[11.5px] text-ink-3">
            in {l.source_title} · {l.status === "ambiguous" ? `${l.candidates.length} notes have this name` : "no such note"}
          </div>
        </button>
      ))}
      {data && !data.length ? <p className="px-4 py-3 text-[12.5px] text-ink-3">Every link leads somewhere.</p> : null}
    </div>
  );
}
