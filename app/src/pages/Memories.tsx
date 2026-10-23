import { FilePlus2, Library, Pin, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Empty, Input, PageHeader, Select } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { CATEGORY_COLOR, CATEGORY_LABEL, MEMORY_TYPE_LABEL, SOURCE_LABEL, cn, timeAgo } from "../lib/utils";

export function MemoriesPage() {
  const { params, select, selected, edit } = useApp();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [project, setProject] = useState(params.project ?? "");
  const [tag, setTag] = useState(params.tag ?? "");
  const [status, setStatus] = useState("active");
  const [since, setSince] = useState("");
  const [order, setOrder] = useState("updated");
  const [mtype, setMtype] = useState("");
  const [source, setSource] = useState("");
  const [minConf, setMinConf] = useState("");
  const [pinned, setPinned] = useState(params.pinned === "1");
  const [results, setResults] = useState<any[] | null>(null);
  const [limit, setLimit] = useState(100);
  const { data: projects } = useLive<any[]>("projects.list", {}, { entities: ["project"] });
  const { data: tags } = useLive<any[]>("tags", {}, { entities: ["memory"] });
  const filters = { category: category || undefined, project_id: project || undefined, tag: tag || undefined, status, since: since || undefined, order, limit, memory_type: mtype || undefined, source: source || undefined, pinned: pinned || undefined, min_confidence: minConf ? Number(minConf) : undefined };
  const { data: list, loading } = useLive<{ items: any[]; total: number }>("memories.list", filters, { entities: ["memory"] });

  useEffect(() => {
    if (params.tag) setTag(params.tag);
    if (params.project) setProject(params.project);
  }, [params.tag, params.project]);

  useEffect(() => {
    if (!query.trim()) return setResults(null);
    const t = setTimeout(() => {
      void rpc<any[]>("search", { query, filters: { category: category || undefined, project_id: project || undefined, tags: tag ? [tag] : undefined, since: since || undefined, status, memory_type: mtype || undefined, source: source || undefined, pinned, min_confidence: minConf ? Number(minConf) : undefined }, limit: 50 }).then(setResults);
    }, 180);
    return () => clearTimeout(t);
  }, [query, category, project, tag, since, status, mtype, source, pinned, minConf]);

  const rows = results ? results.map((r) => ({ ...r.memory, _score: r.score, _why: r.why })) : list?.items ?? [];
  const projectName = (id: string | null) => projects?.find((p) => p.id === id)?.name;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Memories"
        description="Everything MOTH knows. Search in plain language: it matches words, meaning, projects and connections."
        actions={
          <Button variant="primary" onClick={() => edit("new")}>
            <FilePlus2 /> New memory
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-8 pb-4">
        <div className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What fixed the inventory bug last time?" className="pl-8" aria-label="Search memories" />
        </div>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">All tags</option>
          {(tags ?? []).map((t) => (
            <option key={t.tag} value={t.tag}>
              #{t.tag} ({t.n})
            </option>
          ))}
        </Select>
        <Select value={since} onChange={(e) => setSince(e.target.value)} aria-label="Updated">
          <option value="">Any date</option>
          <option value={new Date(Date.now() - 86400000).toISOString()}>Last 24 hours</option>
          <option value={new Date(Date.now() - 7 * 86400000).toISOString()}>Last 7 days</option>
          <option value={new Date(Date.now() - 30 * 86400000).toISOString()}>Last 30 days</option>
        </Select>
        <Select value={mtype} onChange={(e) => setMtype(e.target.value)} aria-label="Memory type">
          <option value="">All types</option>
          {Object.entries(MEMORY_TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">Any source</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select value={minConf} onChange={(e) => setMinConf(e.target.value)} aria-label="Confidence">
          <option value="">Any confidence</option>
          <option value="0.5">50%+</option>
          <option value="0.7">70%+</option>
          <option value="0.9">90%+</option>
        </Select>
        <button onClick={() => setPinned(!pinned)} aria-pressed={pinned} className={cn("flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-[12.5px] [&_svg]:size-3.5", pinned ? "border-accent/60 text-accent-soft" : "border-line text-ink-2 hover:text-ink")}>
          <Pin /> Pinned
        </button>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="superseded">Superseded</option>
          <option value="merged">Merged</option>
          <option value="all">Everything</option>
        </Select>
        {!results ? (
          <Select value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Sort">
            <option value="updated">Recently updated</option>
            <option value="created">Newest</option>
            <option value="importance">Most important</option>
            <option value="title">A to Z</option>
          </Select>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <div className="mb-2 text-[12px] text-ink-3">{results ? `${results.length} matches, best first` : list ? `${list.total.toLocaleString()} memories` : ""}</div>
        {!loading && rows.length === 0 ? (
          <Empty icon={<Library />} title={query ? "No memories match" : "No memories here"}>
            {query ? "Try other words, or clear a filter." : "Memories appear when Claude learns something, when you import notes, or when you add one."}
          </Empty>
        ) : null}
        <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line">
          {rows.map((m) => (
            <li key={m.id}>
              <button onClick={() => select(m.id)} className={cn("grid w-full grid-cols-[14px_1fr_auto] items-start gap-3 px-4 py-3 text-left hover:bg-surface", selected === m.id && "bg-surface")}>
                <span className="mt-[7px] size-2 rounded-full" style={{ background: CATEGORY_COLOR[m.category] }} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] text-ink">{m.title}</span>
                    {m.status !== "active" ? <Badge tone="warn">{m.status}</Badge> : null}
                    {m.task_state === "open" ? <Badge>Open task</Badge> : null}
                    {m.flags?.includes("possible_conflict") ? <Badge tone="warn">Conflict</Badge> : null}
                    {m.is_demo ? <Badge tone="warn">Demo</Badge> : null}
                    {m.pinned ? <Pin className="size-3.5 shrink-0 text-accent-soft" aria-label="Pinned" /> : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-ink-2">{m.summary || m.content}</span>
                  <span className="mt-1 block text-[11.5px] text-ink-3">
                    {MEMORY_TYPE_LABEL[m.memory_type] ?? CATEGORY_LABEL[m.category]}
                    {projectName(m.project_id) ? `, ${projectName(m.project_id)}` : ""}
                    {`, ${SOURCE_LABEL[m.source] ?? m.source}, ${Math.round(m.confidence * 100)}%`}
                    {m._why?.length ? `, ${m._why.join(", ")}` : ""}
                  </span>
                </span>
                <span className="text-right text-[11.5px] text-ink-3">
                  {timeAgo(m.updated_at)}
                  {m._score ? <span className="mt-0.5 block tabular-nums">{Math.round(m._score * 100)}% match</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!results && list && list.total > rows.length ? (
          <div className="mt-4 text-center">
            <Button size="sm" onClick={() => setLimit(limit + 200)}>
              Show more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
