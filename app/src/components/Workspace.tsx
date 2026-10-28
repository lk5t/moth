// Workspace Tabs: notes, memories, projects and The Mind in tabs, in one or two panes. The layout is saved in the
// database and restored after restarting MOTH (tabs whose note/memory/project no longer exists are dropped, with a
// notice). Every tab refers to its record by its stable id.
import { Brain, Columns2, FileText, FolderKanban, Library as LibraryIcon, X } from "lucide-react";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { flushAll, knownTitle, saveDoc, useDoc } from "../lib/docstore";
import { useLive } from "../lib/hooks";
import { cn, debounce, timeAgo } from "../lib/utils";
import { CollectionButton } from "./CollectionButton";
import { NoteEditor, type EditorMode } from "./NoteEditor";
import { Badge, Button, ContextMenu, Empty, Spinner } from "./ui";

const MindPage = lazy(() => import("../pages/Mind").then((m) => ({ default: m.MindPage })));
const ProjectDashboardLazy = lazy(() => import("../pages/Projects").then((m) => ({ default: m.ProjectDashboard })));

export type TabKind = "document" | "memory" | "project" | "mind";
export interface Tab {
  key: string;
  kind: TabKind;
  id?: string;
  title?: string;
  mode?: EditorMode;
}
interface Pane {
  tabs: Tab[];
  active: string | null;
}
export interface WorkspaceState {
  panes: Pane[];
  focus: number;
}

interface Api {
  state: WorkspaceState;
  open: (kind: TabKind, id?: string, opts?: { split?: boolean; title?: string }) => void;
  close: (pane: number, key: string) => void;
  activate: (pane: number, key: string) => void;
  setMode: (pane: number, key: string, mode: EditorMode) => void;
  move: (from: number, key: string, to: number, index?: number) => void;
  closePane: (pane: number) => void;
  focusPane: (pane: number) => void;
  restored: boolean;
}

const Ctx = createContext<Api | null>(null);
export const useWorkspace = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
};

const tabKey = (kind: TabKind, id?: string) => `${kind}:${id ?? "main"}`;
const EMPTY: WorkspaceState = { panes: [{ tabs: [], active: null }], focus: 0 };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { toast } = useApp();
  const [state, setState] = useState<WorkspaceState>(EMPTY);
  const [restored, setRestored] = useState(false);
  const persist = useMemo(() => debounce((s: WorkspaceState) => void rpc("workspace.save", { state: s }).catch(() => undefined), 700), []);

  // Restore the previous session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const w = await rpc<any>("workspace.get");
        const s = w?.state as WorkspaceState | null;
        if (!s || !Array.isArray(s.panes) || !s.panes.length) return;
        const refs = s.panes.flatMap((p) => p.tabs.filter((t) => t.id && t.kind !== "mind").map((t) => ({ kind: t.kind, id: t.id! })));
        const check = refs.length ? await rpc<any[]>("workspace.resolve", { refs }) : [];
        const exists = new Map(check.map((c) => [`${c.kind}:${c.id}`, c]));
        let dropped = 0;
        const panes = s.panes.slice(0, 2).map((p) => {
          const tabs = p.tabs.filter((t) => {
            if (t.kind === "mind") return true;
            const c = exists.get(`${t.kind}:${t.id}`);
            if (!c?.exists) dropped++;
            return !!c?.exists;
          }).map((t) => ({ ...t, title: exists.get(`${t.kind}:${t.id}`)?.title ?? t.title }));
          return { tabs, active: tabs.some((t) => t.key === p.active) ? p.active : tabs[0]?.key ?? null };
        }).filter((p, i) => i === 0 || p.tabs.length);
        if (!cancelled) {
          setState({ panes: panes.length ? panes : EMPTY.panes, focus: Math.min(s.focus ?? 0, panes.length - 1) });
          if (dropped) toast({ kind: "info", text: `${dropped} tab${dropped === 1 ? "" : "s"} from your last session pointed to something that no longer exists, so ${dropped === 1 ? "it was" : "they were"} closed.` });
        }
      } catch {
        /* start empty */
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = useCallback(
    (fn: (s: WorkspaceState) => WorkspaceState) =>
      setState((cur) => {
        const next = fn(cur);
        if (restored) persist(next);
        return next;
      }),
    [persist, restored],
  );

  const api: Api = {
    state,
    restored,
    open: (kind, id, opts = {}) =>
      update((s) => {
        const key = tabKey(kind, id);
        const panes = s.panes.map((p) => ({ ...p, tabs: [...p.tabs] }));
        // Already open: show it there (unless asked for a split).
        if (!opts.split) {
          for (let i = 0; i < panes.length; i++) if (panes[i].tabs.some((t) => t.key === key)) return { panes: panes.map((p, j) => (j === i ? { ...p, active: key } : p)), focus: i };
        }
        let target = s.focus;
        if (opts.split) {
          if (panes.length < 2) panes.push({ tabs: [], active: null });
          target = s.focus === 0 ? 1 : 0;
        }
        const pane = panes[target];
        if (!pane.tabs.some((t) => t.key === key)) {
          const at = pane.active ? pane.tabs.findIndex((t) => t.key === pane.active) + 1 : pane.tabs.length;
          pane.tabs.splice(at, 0, { key, kind, id, title: opts.title, mode: kind === "document" ? "edit" : undefined });
        }
        pane.active = key;
        return { panes, focus: target };
      }),
    close: (pane, key) => {
      const t = state.panes[pane]?.tabs.find((x) => x.key === key);
      if (t?.kind === "document" && t.id) void saveDoc(t.id);
      update((s) => {
        const panes = s.panes.map((p, i) => {
          if (i !== pane) return p;
          const idx = p.tabs.findIndex((x) => x.key === key);
          const tabs = p.tabs.filter((x) => x.key !== key);
          const active = p.active === key ? tabs[Math.min(idx, tabs.length - 1)]?.key ?? null : p.active;
          return { tabs, active };
        });
        const kept = panes.filter((p, i) => i === 0 || p.tabs.length);
        return { panes: kept.length ? kept : EMPTY.panes, focus: Math.min(s.focus, kept.length - 1) };
      });
    },
    activate: (pane, key) => {
      // Switching tabs saves pending edits of the tab being left.
      const cur = state.panes[pane]?.tabs.find((t) => t.key === state.panes[pane].active);
      if (cur?.kind === "document" && cur.id) void saveDoc(cur.id);
      update((s) => ({ panes: s.panes.map((p, i) => (i === pane ? { ...p, active: key } : p)), focus: pane }));
    },
    setMode: (pane, key, mode) => update((s) => ({ ...s, panes: s.panes.map((p, i) => (i === pane ? { ...p, tabs: p.tabs.map((t) => (t.key === key ? { ...t, mode } : t)) } : p)) })),
    move: (from, key, to, index) =>
      update((s) => {
        const panes = s.panes.map((p) => ({ ...p, tabs: [...p.tabs] }));
        if (to >= panes.length) panes.push({ tabs: [], active: null });
        const src = panes[from];
        const i = src.tabs.findIndex((t) => t.key === key);
        if (i < 0) return s;
        const [tab] = src.tabs.splice(i, 1);
        if (src.active === key) src.active = src.tabs[Math.min(i, src.tabs.length - 1)]?.key ?? null;
        const dst = panes[to];
        const existing = dst.tabs.findIndex((t) => t.key === key);
        if (existing >= 0) dst.tabs.splice(existing, 1);
        dst.tabs.splice(index ?? dst.tabs.length, 0, tab);
        dst.active = key;
        const kept = panes.filter((p, j) => j === 0 || p.tabs.length);
        if (!kept[0].tabs.length && kept.length > 1) kept.shift();
        return { panes: kept, focus: Math.min(kept.indexOf(dst) >= 0 ? kept.indexOf(dst) : 0, kept.length - 1) };
      }),
    closePane: (pane) =>
      update((s) => {
        if (s.panes.length < 2) return s;
        void flushAll();
        const panes = s.panes.filter((_, i) => i !== pane);
        return { panes, focus: 0 };
      }),
    focusPane: (pane) => update((s) => (s.focus === pane ? s : { ...s, focus: pane })),
  };
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

const ICON: Record<TabKind, ReactNode> = { document: <FileText />, memory: <Brain />, project: <FolderKanban />, mind: <Brain /> };

function TabTitle({ tab }: { tab: Tab }) {
  const doc = useDoc(tab.kind === "document" && tab.id ? tab.id : "__none__");
  const title = tab.kind === "mind" ? "The Mind" : tab.kind === "document" ? doc?.title || knownTitle(tab.id!) || tab.title || "Note" : tab.title || (tab.kind === "memory" ? "Memory" : "Project");
  const unsaved = tab.kind === "document" && doc && ["dirty", "saving", "error", "conflict"].includes(doc.state);
  return (
    <>
      <span className="truncate">{title}</span>
      {unsaved ? <span className={cn("ml-1 size-1.5 shrink-0 rounded-full", doc!.state === "error" || doc!.state === "conflict" ? "bg-danger" : "bg-accent")} title="Not saved yet" /> : null}
    </>
  );
}

export function WorkspaceView() {
  const ws = useWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number; pane: number; key: string } | null>(null);
  const drag = useRef<{ pane: number; key: string } | null>(null);
  const { state } = ws;
  if (!ws.restored)
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  return (
    <div className={cn("grid h-full min-h-0", state.panes.length === 2 ? "grid-cols-2" : "grid-cols-1")} data-testid="workspace">
      {state.panes.map((pane, pi) => {
        const active = pane.tabs.find((t) => t.key === pane.active);
        return (
          <div key={pi} className={cn("flex min-h-0 min-w-0 flex-col", pi === 1 && "border-l border-line")} onMouseDown={() => ws.focusPane(pi)}>
            <div
              className={cn("flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line px-1.5", state.panes.length === 2 && state.focus === pi && "bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)]")}
              role="tablist"
              aria-label={`Pane ${pi + 1}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (drag.current) ws.move(drag.current.pane, drag.current.key, pi);
                drag.current = null;
              }}
            >
              {pane.tabs.map((t, ti) => (
                <div
                  key={t.key}
                  role="tab"
                  aria-selected={t.key === pane.active}
                  draggable
                  onDragStart={() => (drag.current = { pane: pi, key: t.key })}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (drag.current) ws.move(drag.current.pane, drag.current.key, pi, ti);
                    drag.current = null;
                  }}
                  onClick={() => ws.activate(pi, t.key)}
                  onAuxClick={(e) => e.button === 1 && ws.close(pi, t.key)}
                  onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, pane: pi, key: t.key }))}
                  className={cn(
                    "group flex h-8 max-w-[200px] cursor-default items-center gap-1.5 rounded-t-[8px] border border-b-0 px-2.5 text-[12.5px] [&>svg]:size-3.5 [&>svg]:shrink-0",
                    t.key === pane.active ? "border-line bg-bg text-ink" : "border-transparent text-ink-3 hover:text-ink",
                  )}
                >
                  {ICON[t.kind]}
                  <TabTitle tab={t} />
                  <button aria-label="Close tab" className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-surface-2 group-hover:opacity-100 [&_svg]:size-3" onClick={(e) => (e.stopPropagation(), ws.close(pi, t.key))}>
                    <X />
                  </button>
                </div>
              ))}
              <div className="ml-auto flex shrink-0 items-center gap-1 pb-1">
                {state.panes.length === 1 && active ? (
                  <button title="Open this tab in a second pane" aria-label="Split" className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-surface-2 hover:text-ink [&_svg]:size-3.5" onClick={() => ws.move(pi, active.key, 1)}>
                    <Columns2 />
                  </button>
                ) : null}
                {state.panes.length === 2 ? (
                  <button title="Close this pane" aria-label="Close pane" className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-surface-2 hover:text-ink [&_svg]:size-3.5" onClick={() => ws.closePane(pi)}>
                    <X />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="relative min-h-0 flex-1">
              {active ? <TabContent pane={pi} tab={active} /> : <EmptyPane />}
            </div>
          </div>
        );
      })}
      <ContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                { label: "Close", onSelect: () => ws.close(menu.pane, menu.key) },
                { label: "Close others", onSelect: () => state.panes[menu.pane].tabs.filter((t) => t.key !== menu.key).forEach((t) => ws.close(menu.pane, t.key)) },
                { label: state.panes.length === 2 ? "Move to the other pane" : "Open in a second pane", onSelect: () => ws.move(menu.pane, menu.key, menu.pane === 0 ? 1 : 0) },
              ]
            : []
        }
      />
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="grid h-full place-items-center p-8">
      <Empty icon={<LibraryIcon />} title="Nothing open">
        Pick a note on the left, create one with New note, or open The Mind here. Ctrl+click a link to open it in a second pane.
      </Empty>
    </div>
  );
}

function TabContent({ pane, tab }: { pane: number; tab: Tab }) {
  const ws = useWorkspace();
  const onOpen = (kind: string, id: string, opts?: { split?: boolean }) => ws.open(kind as TabKind, id, opts);
  if (tab.kind === "document" && tab.id) return <NoteEditor key={tab.id} id={tab.id} mode={tab.mode ?? "edit"} onMode={(m) => ws.setMode(pane, tab.key, m)} onOpen={onOpen} />;
  if (tab.kind === "memory" && tab.id) return <MemoryView id={tab.id} onOpen={onOpen} />;
  if (tab.kind === "project" && tab.id)
    return (
      <div className="h-full overflow-y-auto">
        <Suspense fallback={<Spinner />}>
          <ProjectDashboardLazy id={tab.id} onBack={() => ws.close(pane, tab.key)} />
        </Suspense>
      </div>
    );
  if (tab.kind === "mind")
    return (
      <Suspense fallback={<Spinner />}>
        <MindPage />
      </Suspense>
    );
  return null;
}

/** A memory shown in a tab (read view; editing and the full details stay in the memory panel). */
function MemoryView({ id, onOpen }: { id: string; onOpen: (kind: string, id: string) => void }) {
  const { select } = useApp();
  const { data: m, error } = useLive<any>("memories.get", { id }, { entities: ["memory", "relationship"] });
  if (error) return <div className="p-6 text-[13px] text-danger">{error}</div>;
  if (!m) return <div className="grid h-full place-items-center"><Spinner /></div>;
  return (
    <div className="h-full overflow-y-auto px-8 py-6" data-testid="memory-tab">
      <div className="flex items-center gap-2">
        <Badge tone="accent">Memory</Badge>
        <span className="text-[11.5px] text-ink-3">updated {timeAgo(m.updated_at)} · version {m.version}</span>
        <span className="ml-auto" />
        <CollectionButton kind="memory" id={id} />
        <Button size="sm" onClick={() => select(id)}>Details and edit</Button>
      </div>
      <h1 className="mt-2 text-[20px] text-ink">{m.title}</h1>
      <p className="selectable mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">{m.content}</p>
      {m.relationships?.length ? (
        <div className="mt-6">
          <h2 className="mb-1 text-[11px] uppercase tracking-[0.12em] text-ink-3">Connections</h2>
          <ul className="space-y-0.5">
            {m.relationships.slice(0, 40).map((r: any) => (
              <li key={r.id}>
                <button className="text-left text-[12.5px] text-ink hover:text-accent-soft" onClick={() => onOpen("memory", r.other?.id ?? r.target_id)}>
                  {r.other?.title ?? r.target_title ?? r.target_id}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
