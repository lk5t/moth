import { ArrowUpRight, FilePlus2 } from "lucide-react";
import { MothMark } from "../components/MothLogo";
import { Badge, Button, SectionTitle } from "../components/ui";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { CATEGORY_LABEL, plural, timeAgo } from "../lib/utils";
import { actorLabel } from "../components/MemoryPanel";

const PREVIEW_SETTINGS = { centerForce: 0.14, repelForce: 120, linkForce: 0.35, linkDistance: 34, nodeSize: 0.9, linkThickness: 1, textFadeThreshold: 9, showLabels: false, animate: true, colorBy: "none" as const, showArrows: false };

export function OverviewPage() {
  const { go, select, edit } = useApp();
  const { data } = useLive<any>("overview");
  const { data: graph } = useLive<any>("graph.get", {}, { entities: ["memory", "relationship"] });
  const s = data?.stats;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1280px] gap-6 px-8 py-7 xl:grid-cols-[1fr_380px]">
        <section className="min-w-0">
          <div className="mb-4">
            <h1 className="text-[22px]">Your mind</h1>
            <p className="mt-1 max-w-[64ch] text-[14px] leading-relaxed text-ink-2">
              {s ? (
                s.total_memories ? (
                  <>
                    MOTH holds <span className="text-ink">{plural(s.total_memories, "memory", "memories")}</span> across <span className="text-ink">{plural(s.active_projects, "project")}</span>, linked by{" "}
                    <span className="text-ink">{plural(s.total_relationships, "connection")}</span>.{" "}
                    {s.created_today || s.updated_today ? `Today it learned ${plural(s.created_today, "new thing")}${s.updated_today ? ` and refined ${plural(s.updated_today, "memory", "memories")}` : ""}.` : "Nothing new today yet."}
                  </>
                ) : (
                  "Nothing remembered yet. Connect Claude and the first things it learns will appear here."
                )
              ) : (
                <span className="skeleton inline-block h-4 w-80 align-middle" />
              )}
            </p>
          </div>
          <button onClick={() => go("mind")} className="group relative block h-[420px] w-full overflow-hidden rounded-[16px] border border-line text-left" aria-label="Open The Mind">
            {graph ? <GraphCanvas nodes={graph.nodes} links={graph.links} settings={PREVIEW_SETTINGS} compact /> : <div className="h-full bg-graph" />}
            <span className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-line bg-[#161616]/90 px-3 py-1 text-[12px] text-ink-2 transition-colors group-hover:text-ink">
              Open The Mind <ArrowUpRight className="size-3.5" />
            </span>
            {graph && graph.nodes.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center text-center">
                <div>
                  <MothMark size={42} glow className="mx-auto text-accent-soft" />
                  <p className="mt-3 text-[13px] text-ink-2">Follow the light. Remember the journey.</p>
                </div>
              </div>
            ) : null}
          </button>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <SectionTitle aside={<button onClick={() => go("memories")} className="hover:text-ink">All memories</button>}>Recently learned</SectionTitle>
              <ul className="divide-y divide-line rounded-[12px] border border-line">
                {(data?.recent_memories ?? []).map((m: any) => (
                  <li key={m.id}>
                    <button onClick={() => select(m.id)} className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left hover:bg-surface">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-node" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{m.title}</span>
                        <span className="block text-[12px] text-ink-3">
                          {CATEGORY_LABEL[m.category]}, {timeAgo(m.created_at)} from {actorLabel(m.source)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {data && !data.recent_memories.length ? (
                  <li className="px-4 py-6 text-center text-[12.5px] text-ink-3">
                    <Button size="sm" onClick={() => edit("new")}>
                      <FilePlus2 /> Add the first memory
                    </Button>
                  </li>
                ) : null}
              </ul>
            </div>
            <div>
              <SectionTitle aside={<button onClick={() => go("timeline")} className="hover:text-ink">Timeline</button>}>Recent activity</SectionTitle>
              <ol className="space-y-2.5 border-l border-line pl-4">
                {(data?.recent_events ?? []).slice(0, 8).map((e: any) => (
                  <li key={e.id} className="relative text-[12.5px] leading-snug">
                    <span className="absolute -left-[19.5px] top-1.5 size-1.5 rounded-full bg-line-strong" />
                    <span className="text-ink">{e.description}</span>
                    <span className="block text-ink-3">
                      {actorLabel(e.actor)}, {timeAgo(e.created_at)}
                    </span>
                  </li>
                ))}
                {data && !data.recent_events.length ? <li className="text-[12.5px] text-ink-3">No activity yet.</li> : null}
              </ol>
            </div>
          </div>
        </section>

        <aside className="space-y-6">
          <div className="panel p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px]">Claude</h2>
              {data ? <Badge tone={data.connection.claude_connected ? "ok" : "neutral"}>{data.connection.claude_connected ? "Connected now" : "Not connected now"}</Badge> : null}
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
              {data?.connection.last_success
                ? `Last memory request: ${data.connection.last_success.action.replace("moth_", "").replace(/_/g, " ")}, ${timeAgo(data.connection.last_success.created_at)}.`
                : data?.connection.desktop || data?.connection.code
                  ? "Set up. Claude hasn't used MOTH yet; open Claude and start a task."
                  : "Claude can't use MOTH until you connect it."}
            </p>
            <Button size="sm" className="mt-3" onClick={() => go("connections")}>
              {data?.connection.desktop || data?.connection.code ? "Manage connection" : "Connect Claude"}
            </Button>
          </div>

          <div>
            <SectionTitle aside={<button onClick={() => go("metamorphosis")} className="hover:text-ink">Details</button>}>Growth, last 14 days</SectionTitle>
            <Sparkline points={(data?.growth ?? []).map((g: any) => g.memories)} />
            {s ? (
              <p className="mt-2 text-[12.5px] text-ink-2">
                {s.duplicates_consolidated ? `${plural(s.duplicates_consolidated, "duplicate")} consolidated. ` : ""}
                {s.open_conflicts ? `${plural(s.open_conflicts, "possible contradiction")} to review.` : "No contradictions waiting."}
              </p>
            ) : null}
          </div>

          <div>
            <SectionTitle aside={<button onClick={() => go("projects")} className="hover:text-ink">All projects</button>}>Projects</SectionTitle>
            <ul className="space-y-1">
              {(data?.projects ?? []).map((p: any) => (
                <li key={p.id}>
                  <button onClick={() => go("projects", { id: p.id })} className="flex w-full items-center justify-between rounded-[8px] px-2.5 py-2 text-left hover:bg-surface">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">{p.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{p.status || p.description || "No status yet"}</span>
                    </span>
                    <span className="ml-3 shrink-0 text-[12px] tabular-nums text-ink-3">{p.memory_count}</span>
                  </button>
                </li>
              ))}
              {data && !data.projects.length ? <li className="px-2.5 text-[12.5px] text-ink-3">Projects appear when Claude reports work on one.</li> : null}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function Sparkline({ points, height = 56 }: { points: number[]; height?: number }) {
  if (points.length < 2) return <div className="skeleton w-full" style={{ height }} />;
  const max = Math.max(1, ...points);
  const min = Math.min(...points);
  const w = 300;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, height - 4 - ((p - min) / Math.max(1, max - min)) * (height - 10)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} role="img" aria-label={`Memories grew from ${points[0]} to ${points[points.length - 1]}`}>
      <path d={`${d} L${w},${height} L0,${height} Z`} fill="rgba(167,139,250,0.08)" />
      <path d={d} fill="none" stroke="#A78BFA" strokeWidth="1.5" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="2.5" fill="#C4B5FD" />
    </svg>
  );
}
