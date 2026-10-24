import { JOB_STATUS_LABEL } from "../lib/utils";
import { Pause, Play, Sparkles, Undo2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, PageHeader, SectionTitle } from "../components/ui";
import { actorLabel } from "../components/MemoryPanel";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { clock, cn, dayLabel, timeAgo } from "../lib/utils";

export function MetamorphosisPage() {
  const { toast, select } = useApp();
  const { data: stats } = useLive<any>("meta.stats");
  const { data: growth } = useLive<any[]>("meta.growth", { days: 30 });
  const { data: events, reload } = useLive<any[]>("timeline", { limit: 120 });
  const { data: conflicts, reload: reloadC } = useLive<any[]>("memories.conflicts");
  const { data: dups, reload: reloadD } = useLive<any[]>("memories.duplicates");
  const { data: jobs, reload: reloadJ } = useLive<any>("jobs.list", {}, { entities: ["learning", "memory"] });
  const { data: st } = useLive<any>("status", {}, { entities: ["learning"] });
  const [running, setRunning] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: ok });
      void reload();
      void reloadC();
      void reloadD();
      void reloadJ();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const reflect = async () => {
    setRunning(true);
    try {
      const r = await rpc<any>("meta.reflect");
      const changed = r.merged + r.duplicates_flagged + r.conflicts_flagged + r.links_added + r.attached_to_projects + r.stale_tasks + r.summaries_improved;
      toast({ kind: "light", text: changed ? `Reflection changed ${changed} thing${changed === 1 ? "" : "s"} in ${(r.duration_ms / 1000).toFixed(1)}s` : `Reviewed ${r.scanned} memories. Nothing needed changing.` });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setRunning(false);
    }
  };

  const evolution = (events ?? []).filter((e) => !["context_retrieved", "task_ended"].includes(e.kind));
  let lastDay = "";
  const metrics: [string, unknown][] = stats
    ? [
        ["Memories", stats.total_memories],
        ["Connections", stats.total_relationships],
        ["Active projects", stats.active_projects],
        ["New today", stats.created_today],
        ["Updated today", stats.updated_today],
        ["New concepts today", stats.new_concepts_today],
        ["Duplicates consolidated", stats.duplicates_consolidated],
        ["Contradictions found", stats.contradictions_identified],
      ]
    : [];

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Metamorphosis"
        description="How your brain changes. MOTH reviews its knowledge on a schedule: it merges duplicates, flags contradictions, finds missing connections and files loose notes into projects. Every change has a reason and can be undone."
        actions={
          <>
            <Button variant="ghost" onClick={() => run(() => rpc("automation.pause", { paused: !st?.paused }), st?.paused ? "Automation resumed" : "Automation paused")}>
              {st?.paused ? <Play /> : <Pause />} {st?.paused ? "Resume" : "Pause"}
            </Button>
            <Button variant="primary" onClick={reflect} loading={running}>
              <Sparkles /> Reflect now
            </Button>
          </>
        }
      />
      <div className="px-8 pb-10">
        <div className="grid grid-cols-2 overflow-hidden rounded-[12px] border border-line sm:grid-cols-4">
          {metrics.map(([label, v], i) => (
            <div key={label} className={cn("border-line px-4 py-3", i % 4 !== 3 && "sm:border-r", i < 4 && "border-b", i % 2 === 0 && "border-r sm:border-r")}>
              <div className="text-[20px] tabular-nums text-ink">{Number(v).toLocaleString()}</div>
              <div className="text-[12px] text-ink-3">{label}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-ink-3">
          Last reflection {timeAgo(stats?.last_reflection)}. {st?.paused ? "Automation is paused." : "Automation is on."} Background queue: {jobs?.counts.pending ?? 0} waiting, {jobs?.counts.running ?? 0} running, {jobs?.counts.failed ?? 0} failed.
        </p>

        <div className="mt-8 grid gap-8 xl:grid-cols-[1fr_400px]">
          <div className="min-w-0">
            <SectionTitle aside="Last 30 days">Knowledge growth</SectionTitle>
            <GrowthChart data={growth ?? []} />

            <div className="mt-8">
              <SectionTitle aside={`${evolution.length} recent changes`}>Evolution timeline</SectionTitle>
              <ol className="relative border-l border-line pl-5">
                {evolution.map((e) => {
                  const day = dayLabel(e.created_at);
                  const header = day !== lastDay ? day : null;
                  lastDay = day;
                  return (
                    <li key={e.id} className="relative">
                      {header ? <div className="-ml-5 mb-2 mt-4 pl-5 text-[12px] text-ink-3 first:mt-0">{header}</div> : null}
                      <div className="group relative mb-2.5 flex items-start gap-3">
                        <span className={cn("absolute -left-[23.5px] top-[6px] size-[7px] rounded-full", e.actor === "claude" ? "bg-accent" : e.actor === "moth" ? "bg-accent-soft" : "bg-line-strong")} />
                        <span className="w-[64px] shrink-0 whitespace-nowrap pt-px text-[12px] tabular-nums text-ink-3">{clock(e.created_at)}</span>
                        <div className="min-w-0 flex-1">
                          <button className={cn("text-left text-[13px] leading-snug hover:text-accent", e.reverted ? "text-ink-3 line-through" : "text-ink")} onClick={() => e.memory_id && select(e.memory_id)}>
                            {e.description}
                          </button>
                          <p className="text-[12px] leading-snug text-ink-3">
                            {actorLabel(e.actor)}: {e.reason}
                          </p>
                        </div>
                        {e.undo && !e.reverted ? (
                          <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => run(() => rpc("learning.revert", { id: e.id }), "Change reverted")}>
                            <Undo2 /> Undo
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
                {events && !evolution.length ? <li className="text-[12.5px] text-ink-3">No changes yet. They appear as Claude learns and MOTH reflects.</li> : null}
              </ol>
            </div>
          </div>

          <aside className="space-y-8">
            <div>
              <SectionTitle aside={conflicts?.length ? `${conflicts.length} to review` : undefined}>Possible contradictions</SectionTitle>
              {conflicts?.length ? (
                <ul className="space-y-3">
                  {conflicts.map((c) => (
                    <li key={c.event.id} className="panel p-3.5">
                      <p className="text-[12px] text-ink-3">{c.event.reason}</p>
                      <div className="mt-2 grid gap-2">
                        {[c.a, c.b].map((m: any, i: number) => (
                          <button key={m.id} onClick={() => select(m.id)} className="rounded-[8px] border border-line px-3 py-2 text-left hover:border-line-strong">
                            <span className="block text-[12.5px] text-ink">{m.title}</span>
                            <span className="line-clamp-2 block text-[12px] text-ink-2">{m.content}</span>
                            <span className="text-[11px] text-ink-3">{i === 0 ? "A" : "B"}, updated {timeAgo(m.updated_at)}</span>
                          </button>
                        ))}
                      </div>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        <Button size="sm" onClick={() => run(() => rpc("memories.resolveConflict", { id: c.a.id, other_id: c.b.id, keep: "this" }), "Kept A; B is now marked as superseded")}>
                          Keep A
                        </Button>
                        <Button size="sm" onClick={() => run(() => rpc("memories.resolveConflict", { id: c.a.id, other_id: c.b.id, keep: "other" }), "Kept B; A is now marked as superseded")}>
                          Keep B
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => run(() => rpc("memories.resolveConflict", { id: c.a.id, other_id: c.b.id, keep: "both" }), "Both kept as correct")}>
                          Both are right
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-ink-3">None. When two memories disagree, MOTH keeps both and asks you here.</p>
              )}
            </div>

            <div>
              <SectionTitle>Possible duplicates</SectionTitle>
              {dups?.length ? (
                <ul className="space-y-2">
                  {dups.map((d) => (
                    <li key={d.event.id} className="panel p-3">
                      <p className="text-[12.5px] text-ink">
                        "{d.a.title}" and "{d.b.title}"
                      </p>
                      <p className="text-[12px] text-ink-3">{d.event.reason}</p>
                      <Button size="sm" className="mt-2" onClick={() => run(() => rpc("memories.merge", { target_id: d.a.id, source_ids: [d.b.id] }), "Merged. Undo from the timeline if needed.")}>
                        Merge
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-ink-3">None waiting. Near-identical memories are merged automatically; close calls show up here.</p>
              )}
            </div>

            <div>
              <SectionTitle>Background work</SectionTitle>
              <ul className="space-y-1">
                {(jobs?.jobs ?? []).slice(0, 12).map((j: any) => (
                  <li key={j.id} className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] hover:bg-surface">
                    <span className="flex-1 truncate text-ink-2">{jobLabel(j.kind)}</span>
                    <Badge tone={j.status === "done" ? "ok" : j.status === "failed" || j.status === "interrupted" ? "danger" : j.status === "running" ? "accent" : "neutral"}>{JOB_STATUS_LABEL[j.status] ?? j.status}</Badge>
                    {j.status === "pending" || j.status === "running" ? (
                      <button className="text-[12px] text-ink-3 hover:text-ink" onClick={() => run(() => rpc("jobs.cancel", { id: j.id }), "Cancelled")}>
                        Cancel
                      </button>
                    ) : j.status === "failed" || j.status === "interrupted" ? (
                      <button className="text-[12px] text-ink-3 hover:text-ink" title={j.last_error} onClick={() => run(() => rpc("jobs.retry", { id: j.id }), "Queued again")}>
                        Retry
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

const jobLabel = (k: string) =>
  ({ reflect: "Reflection", discover_links: "Finding connections", embed_remote: "Semantic indexing", backup: "Backup", transcript_learning: "Learning from a Claude Code session", maintenance: "Housekeeping" })[k] ?? k;

function GrowthChart({ data }: { data: { date: string; memories: number; relationships: number; created: number }[] }) {
  if (data.length < 2) return <div className="skeleton h-[180px] w-full" />;
  const W = 760;
  const H = 180;
  const P = { l: 34, r: 12, t: 10, b: 22 };
  const max = Math.max(4, ...data.map((d) => Math.max(d.memories, d.relationships)));
  const x = (i: number) => P.l + (i / (data.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b);
  const line = (k: "memories" | "relationships") => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(" ");
  const ticks = [0, Math.round(max / 2), max];
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Memories and connections over the last 30 days">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#292933" strokeDasharray={t ? "2 4" : undefined} />
            <text x={P.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="#6b6b7a">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) =>
          d.created ? <rect key={d.date} x={x(i) - 2.5} y={y(d.created)} width={5} height={H - P.b - y(d.created)} rx={1.5} fill="rgba(167,139,250,0.22)" /> : null,
        )}
        <path d={line("relationships")} fill="none" stroke="#6b6b7a" strokeWidth="1.4" />
        <path d={line("memories")} fill="none" stroke="#A78BFA" strokeWidth="1.8" />
        {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} fontSize="10.5" fill="#6b6b7a">
            {new Date(data[i].date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 flex gap-4 text-[12px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-accent" /> Memories
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-ink-3" /> Connections
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-[rgba(167,139,250,0.3)]" /> Learned that day
        </span>
      </figcaption>
    </figure>
  );
}
