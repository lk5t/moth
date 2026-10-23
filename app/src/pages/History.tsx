import { Fragment, useEffect, useMemo, useState } from "react";
import { Badge, Button, Empty, PageHeader, Select } from "../components/ui";
import { actorLabel } from "../components/MemoryPanel";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { MEMORY_TYPE_LABEL, SOURCE_LABEL, clock, cn, dayLabel, timeAgo } from "../lib/utils";
import { Undo2 } from "lucide-react";

const KIND_GROUPS: Record<string, string[]> = {
  learned: ["created", "learning_committed", "imported", "inbox_import", "project_created", "demo_loaded", "cortex_learned"],
  changed: ["updated", "appended", "merged", "superseded", "restored_version", "summary_improved", "task_completed", "reinforced", "project_updated", "project_attached", "archived", "restored", "removed", "pinned", "unpinned"],
  connected: ["linked", "unlinked"],
  preferences: ["preference_confirmed", "preference_rejected", "preference_outdated", "preference_edited"],
  review: ["conflict_flagged", "duplicate_detected", "stale_flagged", "conflict_cleared"],
  claude: ["context_retrieved", "task_ended", "learning_committed"],
  undo: ["reverted"],
};

const TYPE_OPTIONS: [string, string][] = [
  ["episodic", "Episodes"],
  ["semantic", "Knowledge"],
  ["procedural", "How-to"],
  ["project", "Project"],
  ["preference", "Preferences"],
  ["research", "Research"],
  ["lesson", "Lessons"],
];

export function TimelinePage() {
  const { select, toast } = useApp();
  const [group, setGroup] = useState("");
  const [project, setProject] = useState("");
  const [mtype, setMtype] = useState("");
  const [source, setSource] = useState("");
  const [range, setRange] = useState("");
  const [older, setOlder] = useState<any[]>([]);
  const { data: projects } = useLive<any[]>("projects.list", {}, { entities: ["project"] });
  const since = useMemo(() => (range ? new Date(Date.now() - Number(range) * 86_400_000).toISOString() : undefined), [range]);
  const query = { limit: 150, kinds: group ? KIND_GROUPS[group] : undefined, project_id: project || undefined, memory_type: mtype || undefined, source: source || undefined, since };
  const { data, reload } = useLive<any>("timeline.query", query);
  useEffect(() => setOlder([]), [group, project, mtype, source, range]);
  const items: any[] = data?.items ?? [];
  const all = [...items, ...older];
  const more = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    const r = await rpc<any>("timeline.query", { ...query, before_id: last.id });
    setOlder([...older, ...r.items]);
  };
  const undo = async (id: number) => {
    try {
      await rpc("learning.revert", { id });
      toast({ kind: "ok", text: "Undone. The audit trail keeps both steps." });
      setOlder([]);
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  let lastDay = "";
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Timeline" description="Everything MOTH learned and changed, in order, with who did it and why. Click an entry to open the memory and its versions; undo supported changes here." />
      <div className="mx-auto max-w-[980px] px-8 pb-10">
        <div className="sticky top-0 z-20 -mx-2 mb-2 flex flex-wrap gap-2 bg-bg/95 px-2 py-2 backdrop-blur">
          <Select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Event type">
            <option value="">All events</option>
            <option value="learned">Learned</option>
            <option value="changed">Changed</option>
            <option value="connected">Connections</option>
            <option value="preferences">Preferences</option>
            <option value="review">Needs review</option>
            <option value="claude">Claude sessions</option>
            <option value="undo">Undone</option>
          </Select>
          <Select value={mtype} onChange={(e) => setMtype(e.target.value)} aria-label="Memory type">
            <option value="">All memory types</option>
            {TYPE_OPTIONS.map(([k, v]) => (
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
          <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            <option value="">Any source</option>
            <option value="user">Changed by you</option>
            <option value="claude">Changed by Claude</option>
            <option value="moth">Changed by MOTH</option>
            {(data?.sources ?? []).filter((x: string) => !["user", "claude", "moth"].includes(x)).map((x: string) => (
              <option key={x} value={x}>
                From {SOURCE_LABEL[x] ?? x}
              </option>
            ))}
          </Select>
          <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date">
            <option value="">Any time</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="365">Last year</option>
          </Select>
        </div>
        {data && !all.length ? <Empty title="Nothing matches">Try fewer filters. Changes appear as soon as Claude or you add knowledge.</Empty> : null}
        {all.map((e) => {
          const day = dayLabel(e.created_at);
          const header = day !== lastDay ? day : null;
          lastDay = day;
          return (
            <div key={e.id}>
              {header ? <h2 className="py-2 text-[13px] text-ink-2">{header}</h2> : null}
              <div className="group grid grid-cols-[64px_1fr_auto] gap-3 border-l border-line py-1.5 pl-4">
                <span className="whitespace-nowrap text-[12px] tabular-nums text-ink-3">{clock(e.created_at)}</span>
                <div className="min-w-0">
                  <button onClick={() => e.memory_id && select(e.memory_id)} className={cn("text-left text-[13px] hover:text-accent", e.reverted ? "text-ink-3 line-through" : "text-ink")}>
                    {e.description}
                  </button>
                  <p className="text-[12px] text-ink-3">
                    <span className="text-ink-2">{e.label}</span> · {actorLabel(e.actor)}
                    {e.memory_type ? ` · ${MEMORY_TYPE_LABEL[e.memory_type] ?? e.memory_type}` : ""}
                    {e.project_name ? ` · ${e.project_name}` : ""} · {e.reason}
                  </p>
                </div>
                {e.can_undo ? (
                  <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100" title="Undo this change" onClick={() => void undo(e.id)}>
                    <Undo2 /> Undo
                  </Button>
                ) : (
                  <span />
                )}
              </div>
            </div>
          );
        })}
        {items.length >= 150 ? (
          <div className="mt-4 text-center">
            <Button size="sm" onClick={more}>
              Load older
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ActivityPage() {
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const { data } = useLive<any[]>("activity", { limit: 250, kind: kind || undefined }, { entities: ["activity"] });
  const { data: tasks } = useLive<any[]>("tasks.list", { limit: 30 }, { entities: ["learning"] });
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Activity"
        description="Real requests from Claude, AI calls, hooks and background work. Nothing here is simulated."
        actions={
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
            <option value="">Everything</option>
            <option value="mcp_call">Claude tool calls</option>
            <option value="mcp_connect">Claude connections</option>
            <option value="hook">Claude Code hooks</option>
            <option value="ai">AI processing</option>
            <option value="system">System</option>
            <option value="auth">Account</option>
            <option value="integration">Integrations</option>
            <option value="error">Errors</option>
          </Select>
        }
      />
      <div className="grid gap-8 px-8 pb-10 xl:grid-cols-[1fr_360px]">
        <div className="overflow-hidden rounded-[12px] border border-line">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface text-left text-ink-3">
              <tr>
                <th className="px-3 py-2 font-[500]">When</th>
                <th className="px-3 py-2 font-[500]">From</th>
                <th className="px-3 py-2 font-[500]">What</th>
                <th className="px-3 py-2 text-right font-[500]">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(data ?? []).map((a) => (
                <Fragment key={a.id}>
                  <tr onClick={() => setOpen(open === a.id ? null : a.id)} className="cursor-default hover:bg-surface">
                    <td className="whitespace-nowrap px-3 py-2 text-ink-3">{timeAgo(a.created_at)}</td>
                    <td className="max-w-[160px] truncate px-3 py-2 text-ink-2">{a.source}</td>
                    <td className="px-3 py-2">
                      <span className={a.status === "error" ? "text-danger" : "text-ink"}>{a.action.replace(/^moth_/, "").replace(/_/g, " ")}</span>
                      {a.status === "error" ? <Badge tone="danger" className="ml-2">failed</Badge> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-3">{a.duration_ms != null ? `${a.duration_ms} ms` : ""}</td>
                  </tr>
                  {open === a.id ? (
                    <tr>
                      <td colSpan={4} className="selectable bg-bg px-3 py-2">
                        <pre className="whitespace-pre-wrap break-all text-[11.5px] leading-relaxed text-ink-2">{JSON.stringify(a.detail, null, 2)}</pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          {data && !data.length ? <Empty title="No activity yet">Claude's requests show up here as they happen.</Empty> : null}
        </div>
        <aside>
          <h2 className="mb-3 text-[14px]">Claude sessions</h2>
          <ul className="space-y-2">
            {(tasks ?? []).map((t) => (
              <li key={t.id} className="panel p-3">
                <p className="line-clamp-2 text-[12.5px] text-ink">{t.description}</p>
                <p className="mt-1 text-[11.5px] text-ink-3">
                  {t.project_name ? `${t.project_name}, ` : ""}
                  {t.client ?? "Claude"}, {timeAgo(t.started_at)}
                </p>
                <Badge tone={t.status === "completed" ? "ok" : t.status === "active" ? "accent" : "neutral"} className="mt-1.5">
                  {t.status}
                </Badge>
              </li>
            ))}
            {tasks && !tasks.length ? <li className="text-[12.5px] text-ink-3">When Claude calls moth_begin_task, the session appears here.</li> : null}
          </ul>
        </aside>
      </div>
    </div>
  );
}
