import { Archive, Crosshair, Eye, Focus, Maximize2, Minus, Pencil, Pin, Plus, Search, SlidersHorizontal, Share2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMenu, Input, Select, Slider, Switch, Tabs } from "../components/ui";
import { GraphCanvas, type GraphHandle, type GraphNodeData, type GraphSettings } from "../graph/GraphCanvas";
import { onChanges, rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { CATEGORY_COLOR, CATEGORY_LABEL, cn, debounce } from "../lib/utils";

export type FullGraphSettings = GraphSettings & { showOrphans: boolean; showArchived: boolean; recentDays: number; categories: string[]; projects: string[]; tags: string[]; localDepth: number };

const PROJECT_PALETTE = ["#c4b5fd", "#8fb8de", "#7dd3a8", "#e8c37a", "#e3a7c9", "#9ad0d3", "#c9b48f", "#b9c98f", "#f0a88a"];

export function useGraphSettings() {
  const [s, setS] = useState<FullGraphSettings | null>(null);
  useEffect(() => {
    void rpc<any>("settings.get").then((r) => setS(r.settings.graph));
  }, []);
  const persist = useMemo(() => debounce((v: FullGraphSettings) => void rpc("settings.set", { key: "graph", value: v }), 500), []);
  const update = (patch: Partial<FullGraphSettings>) =>
    setS((cur) => {
      const next = { ...(cur as FullGraphSettings), ...patch };
      persist(next);
      return next;
    });
  return [s, update] as const;
}

export function MindPage() {
  const { params, select, selected, edit, toast } = useApp();
  const [settings, update] = useGraphSettings();
  const [mode, setMode] = useState<"global" | "local">(params.focus ? "local" : "global");
  const [center, setCenter] = useState<string | null>(params.focus ?? null);
  const [data, setData] = useState<{ nodes: GraphNodeData[]; links: any[]; projects: any[] } | null>(null);
  const [panel, setPanel] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<Set<string> | null>(null);
  const [hover, setHover] = useState<GraphNodeData | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [bloom, setBloom] = useState<Map<string, number>>(new Map());
  const [allTags, setAllTags] = useState<{ tag: string; n: number }[]>([]);
  const graph = useRef<GraphHandle>(null);

  useEffect(() => {
    if (params.focus) {
      setCenter(params.focus);
      setMode("local");
      select(params.focus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.focus]);

  const filters = settings
    ? { includeArchived: settings.showArchived, projectIds: settings.projects, categories: settings.categories, tags: settings.tags, recentDays: settings.recentDays, orphans: settings.showOrphans }
    : null;
  const filterKey = JSON.stringify([filters, mode, center, settings?.localDepth]);

  const load = useMemo(
    () => async () => {
      if (!filters) return;
      try {
        const r = mode === "local" && center ? await rpc<any>("graph.local", { id: center, depth: settings!.localDepth }) : await rpc<any>("graph.get", filters);
        setData(r);
      } catch (e) {
        toast({ kind: "error", text: (e as Error).message });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );
  useEffect(() => void load(), [load]);

  // Live evolution: real database changes (from Claude via MCP, or the background engine) update the graph.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return onChanges((changes) => {
      const created = changes.filter((c) => c.entity === "memory" && c.op === "insert").map((c) => c.id);
      const linked = changes.filter((c) => c.entity === "relationship" && c.op === "insert").length;
      if (created.length) setBloom((b) => new Map([...b, ...created.map((id) => [id, performance.now() + 250] as [string, number])]));
      if (changes.some((c) => c.entity === "memory" || c.entity === "relationship")) {
        if (t) clearTimeout(t);
        t = setTimeout(() => void load(), 200);
      }
      if (created.length && linked) toast({ kind: "light", text: created.length === 1 ? "A new memory joined the Mind" : `${created.length} new memories joined the Mind` });
    });
  }, [load, toast]);

  useEffect(() => {
    void rpc<any[]>("tags").then(setAllTags).catch(() => undefined);
  }, [data?.nodes.length]);

  useEffect(() => {
    if (!query.trim()) return setHighlight(null);
    const t = setTimeout(() => {
      void rpc<any[]>("search", { query, limit: 40 }).then((r) => setHighlight(new Set(r.map((x) => x.memory.id))));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const projectColors = useMemo(() => new Map((data?.projects ?? []).map((p, i) => [p.id, PROJECT_PALETTE[i % PROJECT_PALETTE.length]])), [data?.projects]);
  const savePositions = useMemo(() => debounce((items: any[]) => void rpc("graph.positions", { items }), 800), []);
  const onPositions = (items: { id: string; x: number; y: number; pinned?: boolean }[]) => {
    if (items.length === 1 && items[0].pinned !== undefined) void rpc("graph.positions", { items });
    else if (mode === "global") savePositions(items);
  };

  if (!settings) return <div className="h-full bg-graph" />;
  const node = (id: string) => data?.nodes.find((n) => n.id === id);
  const counts = data ? `${data.nodes.length.toLocaleString()} memories, ${data.links.length.toLocaleString()} connections` : "";

  return (
    <div className="relative h-full overflow-hidden bg-graph">
      {data ? (
        <GraphCanvas
          ref={graph}
          nodes={data.nodes}
          links={data.links}
          settings={settings}
          selectedId={selected}
          highlight={highlight}
          bloom={bloom}
          projectColors={projectColors}
          onSelect={(id) => select(id)}
          onFocus={(id) => {
            graph.current?.focus(id);
            select(id);
          }}
          onContext={(id, x, y) => setMenu({ id, x, y })}
          onHover={setHover}
          onPositions={onPositions}
        />
      ) : null}

      {data && data.nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="max-w-[380px] text-center">
            <p className="text-[15px] text-ink">The Mind is empty</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
              {mode === "local" ? "This memory has no connections yet." : "Connect Claude in Connections, import an Obsidian vault in Settings, or add a memory. Each one appears here as a point of light."}
            </p>
          </div>
        </div>
      ) : null}

      {/* toolbar */}
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <Tabs
          value={mode}
          onChange={(v) => {
            if (v === "local" && !(center ?? selected)) return toast({ kind: "info", text: "Select a memory first, then open its local graph." });
            if (v === "local") setCenter(center ?? selected);
            setMode(v);
          }}
          items={[
            { value: "global", label: "Global" },
            { value: "local", label: "Local" },
          ]}
          className="bg-[#161616]/90 backdrop-blur"
        />
        {mode === "local" ? (
          <div className="flex h-8 items-center gap-2 rounded-[var(--radius-md)] border border-line bg-[#161616]/90 px-3 text-[12.5px] text-ink-2">
            Depth
            {[1, 2, 3].map((d) => (
              <button key={d} onClick={() => update({ localDepth: d })} className={cn("size-6 rounded-md", settings.localDepth === d ? "bg-surface-2 text-ink" : "hover:text-ink")}>
                {d}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Highlight in graph" className="h-8 w-[220px] bg-[#161616]/90 pl-8" aria-label="Highlight memories" />
          {query ? (
            <button className="absolute right-2 top-2 text-ink-3 hover:text-ink" onClick={() => setQuery("")} aria-label="Clear">
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="absolute right-4 top-4 flex flex-col items-end gap-2">
        <div className="flex gap-1 rounded-[var(--radius-md)] border border-line bg-[#161616]/90 p-0.5">
          <ToolBtn label="Zoom in" onClick={() => graph.current?.zoomBy(1.4)}>
            <Plus />
          </ToolBtn>
          <ToolBtn label="Zoom out" onClick={() => graph.current?.zoomBy(1 / 1.4)}>
            <Minus />
          </ToolBtn>
          <ToolBtn label="Fit to screen" onClick={() => graph.current?.fit()}>
            <Maximize2 />
          </ToolBtn>
          <ToolBtn label="Graph settings" active={panel} onClick={() => setPanel(!panel)}>
            <SlidersHorizontal />
          </ToolBtn>
        </div>
        <AnimatePresence>{panel ? <SettingsPanel s={settings} update={update} projects={data?.projects ?? []} tags={allTags} onClose={() => setPanel(false)} /> : null}</AnimatePresence>
      </div>

      <div className="pointer-events-none absolute bottom-4 left-4 text-[12px] text-ink-3">
        {hover ? (
          <span className="text-ink-2">
            {hover.title} <span className="text-ink-3">· {CATEGORY_LABEL[hover.category]} · {hover.degree} connections</span>
          </span>
        ) : (
          counts
        )}
      </div>

      <ContextMenu
        at={menu}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                { label: "Open memory", icon: <Eye />, onSelect: () => select(menu.id) },
                { label: "Edit memory", icon: <Pencil />, onSelect: () => edit(menu.id) },
                { label: "View connections", icon: <Share2 />, onSelect: () => (select(menu.id), setHighlight(new Set([menu.id, ...(data?.links ?? []).filter((l) => l.source_id === menu.id || l.target_id === menu.id).map((l) => (l.source_id === menu.id ? l.target_id : l.source_id))]))) },
                { label: "Focus local graph", icon: <Focus />, onSelect: () => (setCenter(menu.id), setMode("local"), select(menu.id)) },
                { label: "Center here", icon: <Crosshair />, onSelect: () => graph.current?.focus(menu.id) },
                { label: "View history", icon: <Archive className="rotate-180" />, onSelect: () => select(menu.id) },
                ...(node(menu.id)?.pinned ? [{ label: "Unpin position", icon: <Pin />, onSelect: () => graph.current?.unpin(menu.id) }] : []),
                {
                  label: "Archive memory",
                  icon: <Archive />,
                  danger: true,
                  onSelect: () =>
                    void rpc("memories.archive", { id: menu.id })
                      .then(() => toast({ kind: "ok", text: "Archived. Restore it any time from Memories." }))
                      .catch((e) => toast({ kind: "error", text: e.message })),
                },
              ]
            : []
        }
      />
    </div>
  );
}

function ToolBtn({ children, label, onClick, active }: { children: ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cn("grid size-7 place-items-center rounded-[7px] text-ink-2 hover:bg-surface-2 hover:text-ink [&_svg]:size-4", active && "bg-surface-2 text-accent-soft")}>
      {children}
    </button>
  );
}

function Group({ title, children, open: initial = true }: { title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="border-b border-line last:border-0">
      <button className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        {title}
        <span className={cn("text-ink-3 transition-transform", open ? "rotate-90" : "")}>›</span>
      </button>
      {open ? <div className="grid gap-3.5 px-4 pb-4">{children}</div> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px] text-ink-2">
      {label}
      {children}
    </div>
  );
}

function SettingsPanel({ s, update, projects, tags, onClose }: { s: FullGraphSettings; update: (p: Partial<FullGraphSettings>) => void; projects: any[]; tags: { tag: string; n: number }[]; onClose: () => void }) {
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
      className="w-[280px] overflow-hidden rounded-[12px] border border-line bg-[#171717]/95 shadow-[0_16px_50px_rgba(0,0,0,0.5)] backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-[13px] text-ink">Graph settings</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close settings">
          <X className="size-4" />
        </button>
      </div>
      <div className="max-h-[calc(100vh-170px)] overflow-y-auto">
        <Group title="Filters">
          <Row label="Orphans">
            <Switch checked={s.showOrphans} onChange={(v) => update({ showOrphans: v })} label="Show unconnected memories" />
          </Row>
          <Row label="Archived">
            <Switch checked={s.showArchived} onChange={(v) => update({ showArchived: v })} label="Show archived memories" />
          </Row>
          <Row label="Recently updated">
            <Select value={String(s.recentDays)} onChange={(e) => update({ recentDays: Number(e.target.value) })} className="h-7">
              <option value="0">Any time</option>
              <option value="1">Last day</option>
              <option value="7">Last week</option>
              <option value="30">Last month</option>
            </Select>
          </Row>
          <div className="grid gap-1.5">
            <span className="text-[12.5px] text-ink-2">Kinds</span>
            <div className="flex flex-wrap gap-1">
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <Chip key={k} on={s.categories.includes(k)} onClick={() => update({ categories: toggle(s.categories, k) })} dot={CATEGORY_COLOR[k]}>
                  {v}
                </Chip>
              ))}
            </div>
          </div>
          {projects.length ? (
            <div className="grid gap-1.5">
              <span className="text-[12.5px] text-ink-2">Projects</span>
              <div className="flex flex-wrap gap-1">
                {projects.map((p) => (
                  <Chip key={p.id} on={s.projects.includes(p.id)} onClick={() => update({ projects: toggle(s.projects, p.id) })}>
                    {p.name}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
          {tags.length ? (
            <div className="grid gap-1.5">
              <span className="text-[12.5px] text-ink-2">Tags</span>
              <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                {tags.slice(0, 40).map((t) => (
                  <Chip key={t.tag} on={s.tags.includes(t.tag)} onClick={() => update({ tags: toggle(s.tags, t.tag) })}>
                    #{t.tag}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
        </Group>
        <Group title="Display">
          <Row label="Labels">
            <Switch checked={s.showLabels} onChange={(v) => update({ showLabels: v })} label="Show labels" />
          </Row>
          <Row label="Arrows">
            <Switch checked={s.showArrows} onChange={(v) => update({ showArrows: v })} label="Show arrows" />
          </Row>
          <Row label="Animation">
            <Switch checked={s.animate} onChange={(v) => update({ animate: v })} label="Animate" />
          </Row>
          <Row label="Colours">
            <Select value={s.colorBy} onChange={(e) => update({ colorBy: e.target.value as FullGraphSettings["colorBy"] })} className="h-7">
              <option value="none">Grey</option>
              <option value="category">By kind</option>
              <option value="project">By project</option>
            </Select>
          </Row>
          <Slider label="Text fade threshold" min={0.3} max={4} step={0.1} value={s.textFadeThreshold} onChange={(v) => update({ textFadeThreshold: v })} format={(v) => v.toFixed(1)} />
          <Slider label="Node size" min={0.4} max={2.5} step={0.05} value={s.nodeSize} onChange={(v) => update({ nodeSize: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Link thickness" min={0.2} max={3} step={0.1} value={s.linkThickness} onChange={(v) => update({ linkThickness: v })} format={(v) => v.toFixed(1)} />
        </Group>
        <Group title="Forces">
          <Slider label="Center force" min={0} max={0.6} step={0.01} value={s.centerForce} onChange={(v) => update({ centerForce: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Repel force" min={10} max={600} step={5} value={s.repelForce} onChange={(v) => update({ repelForce: v })} />
          <Slider label="Link force" min={0} max={1} step={0.01} value={s.linkForce} onChange={(v) => update({ linkForce: v })} format={(v) => v.toFixed(2)} />
          <Slider label="Link distance" min={10} max={250} step={1} value={s.linkDistance} onChange={(v) => update({ linkDistance: v })} />
        </Group>
      </div>
    </motion.div>
  );
}

function Chip({ on, onClick, children, dot }: { on: boolean; onClick: () => void; children: ReactNode; dot?: string }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={cn("flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px]", on ? "border-accent/60 bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-ink" : "border-line text-ink-2 hover:text-ink")}>
      {dot ? <span className="size-1.5 rounded-full" style={{ background: dot }} /> : null}
      {children}
    </button>
  );
}
