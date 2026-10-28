// Overview = MOTH Pulse: a live dashboard. Every number and event comes from MOTH's database.
import { Activity, ArrowUpRight, BookOpenCheck, Bot, Brain, CircleAlert, Cpu, FilePlus2, GitBranch, HeartPulse, Inbox, Link2, Pin, Plug, ShieldOff, Sparkles, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { MothMark } from "../components/MothLogo";
import { JOB_STATUS } from "../components/JobStatus";
import { Badge, Button, SectionTitle } from "../components/ui";
import { rpc } from "../lib/api";
import { GraphCanvas } from "../graph/GraphCanvas";
import { useApp, type Page } from "../lib/app";
import { useLive } from "../lib/hooks";
import { MEMORY_TYPE_LABEL, cn, plural, timeAgo } from "../lib/utils";

const PREVIEW_SETTINGS = { centerForce: 0.14, repelForce: 120, linkForce: 0.35, linkDistance: 34, nodeSize: 0.9, linkThickness: 1, textFadeThreshold: 9, showLabels: false, animate: true, colorBy: "none" as const, showArrows: false };
const STATE_TEXT: Record<string, string> = { unloaded: "Asleep (loads on demand)", starting: "Loading", ready: "Loaded", busy: "Thinking", stopping: "Unloading", error: "Error" };

export function OverviewPage() {
  const { go, select, edit } = useApp();
  const { data: p } = useLive<any>("pulse", {}, { entities: ["memory", "relationship", "project", "learning", "review", "activity", "settings" as any, "cortex" as any] });
  const { data: ov } = useLive<any>("overview");
  const { data: graph } = useLive<any>("graph.get", {}, { entities: ["memory", "relationship"] });
  const { data: intel, reload: reloadIntel } = useLive<any>("pulse.intelligence", {}, { entities: ["finding", "job", "review", "project", "project_item", "handoff"] });
  const t = p?.totals;
  const c = intel?.counts;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1320px] px-8 py-7">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-[22px]">
              MOTH Pulse <span className="relative ml-1 inline-flex size-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" /><span className="relative inline-flex size-2 rounded-full bg-accent" /></span>
            </h1>
            <p className="mt-1 text-[13.5px] text-ink-2">
              {p ? (
                t.memories ? (
                  <>
                    Today: <span className="text-ink">{plural(p.today.created, "new memory", "new memories")}</span>, <span className="text-ink">{plural(p.today.updated, "update")}</span>, <span className="text-ink">{plural(p.today.connections, "new connection")}</span>.
                  </>
                ) : (
                  "Nothing remembered yet. Connect Claude or add a memory and it will show up here live."
                )
              ) : (
                <span className="skeleton inline-block h-4 w-72 align-middle" />
              )}
            </p>
          </div>
          {p ? (
            <div className="flex flex-wrap gap-1.5">
              {p.state.privacy ? <Badge tone="warn"><ShieldOff className="size-3" /> Privacy Mode</Badge> : null}
              {p.state.learning_paused ? <Badge tone="warn">Learning paused</Badge> : null}
              {p.state.defer_reason && !p.state.privacy && !p.state.learning_paused ? <Badge title="Background work waits">{p.state.defer_reason}</Badge> : null}
              <Badge title="Resource profile">{p.state.profile === "eco" ? "Eco" : p.state.profile === "performance" ? "Performance" : "Balanced"}</Badge>
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4" data-testid="pulse-counts">
          <BigTile icon={<GitBranch />} label="Active projects" value={c?.active_projects} hint={c ? `active in the last 7 days · ${c.projects} in total` : undefined} onClick={() => go("projects")} />
          <BigTile icon={<CircleAlert />} label="Unresolved decisions" value={c?.unresolved_decisions} hint={c ? (c.open_blockers ? `${plural(c.open_blockers, "blocker")} open too` : "no open blockers") : undefined} tone={c?.unresolved_decisions ? "warn" : undefined} onClick={() => go("projects")} />
          <BigTile icon={<Inbox />} label="Pending reviews" value={c?.pending_reviews} hint={c ? (c.agent_approvals ? `${c.agent_approvals} from agents` : t?.deferred_reviews ? `${t.deferred_reviews} deferred` : "waiting for you") : undefined} tone={c?.pending_reviews ? "accent" : undefined} onClick={() => go("inbox")} />
          <BigTile icon={<Sparkles />} label="Strong discoveries" value={c?.high_confidence_discoveries} hint={c ? `75%+ confidence · ${c.discoveries} in total` : undefined} tone={c?.high_confidence_discoveries ? "accent" : undefined} onClick={() => go("discoveries")} />
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-2.5 md:grid-cols-6">
          <Tile icon={<Brain />} label="Memories" value={t?.memories} onClick={() => go("memories")} />
          <Tile icon={<Link2 />} label="Connections" value={t?.relationships} onClick={() => go("mind")} />
          <Tile icon={<UserRound />} label="Preferences" value={t?.preferences} onClick={() => go("adaptation")} />
          <Tile icon={<BookOpenCheck />} label="Research" value={t?.research} onClick={() => go("research")} />
          <Tile icon={<Sparkles />} label="Lessons" value={t?.lessons} onClick={() => go("research", { tab: "lessons" })} />
          <Tile icon={<Pin />} label="Pinned" value={t?.pinned} onClick={() => go("memories", { pinned: "1" })} />
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_400px]">
          <section className="min-w-0">
            <button onClick={() => go("mind")} className="group relative block h-[380px] w-full overflow-hidden rounded-[16px] border border-line text-left" aria-label="Open The Mind">
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

            <ContinuityFeed items={intel?.feeds.continuity} />
            <AwarenessFeed items={intel?.feeds.awareness} total={c?.awareness_items} />

            <div className="mt-6 grid gap-6 md:grid-cols-3">
              <MiniList title="Recently created" empty="Nothing yet." items={(p?.recent.created ?? []).map((m: any) => ({ id: m.id, title: m.title, sub: `${MEMORY_TYPE_LABEL[m.memory_type] ?? ""} · ${timeAgo(m.created_at)}` }))} onOpen={select} action={!t?.memories ? <Button size="sm" onClick={() => edit("new")}><FilePlus2 /> Add one</Button> : null} />
              <MiniList title="Recently updated" empty="No updates yet." items={(p?.recent.updated ?? []).map((m: any) => ({ id: m.id, title: m.title, sub: `version ${m.version} · ${timeAgo(m.updated_at)}` }))} onOpen={select} />
              <MiniList title="New connections" empty="No connections yet." items={(p?.recent.connections ?? []).map((r: any) => ({ id: r.a_id, title: `${r.a_title} ↔ ${r.b_title}`, sub: `${r.reason} · ${timeAgo(r.created_at)}` }))} onOpen={select} />
            </div>
          </section>

          <aside className="space-y-5">
            <div className="grid grid-cols-2 gap-2.5">
              <Health
                icon={<Cpu />}
                title="Cortex"
                ok={!!p?.cortex.readiness.ok}
                line={p ? (p.cortex.readiness.ok ? STATE_TEXT[p.cortex.state] ?? p.cortex.state : p.cortex.readiness.reason) : "…"}
                sub={p?.cortex.queue ? `${p.cortex.queue} job(s) queued` : p?.cortex.idle_unload_at ? `unloads ${timeAgo(p.cortex.idle_unload_at).replace(" ago", "")}` : undefined}
                onClick={() => go("cortex")}
              />
              <Health
                icon={<Plug />}
                title="Claude (MCP)"
                ok={!!p?.mcp.last_success}
                line={p ? (p.mcp.claude_connected ? "Connected now" : p.mcp.last_success ? `Last used ${timeAgo(p.mcp.last_success.at)}` : "No calls recorded yet") : "…"}
                sub={p?.mcp.recent_errors ? `${p.mcp.recent_errors} recent error(s)` : p?.mcp.last_success ? p.mcp.last_success.tool.replace("moth_", "").replace(/_/g, " ") : undefined}
                warn={!!p?.mcp.recent_errors}
                onClick={() => go("connections")}
              />
            </div>

            <DiscoveryFeed items={intel?.feeds.discoveries} onChange={() => void reloadIntel()} />
            <AgentFeed items={intel?.feeds.agents} approvals={c?.agent_approvals} />
            <HealthFeed h={intel?.feeds.health} />

            <div>
              <SectionTitle aside={<button onClick={() => go("timeline")} className="hover:text-ink">Timeline</button>}>
                <span className="flex items-center gap-1.5"><Activity className="size-3.5" /> Live activity</span>
              </SectionTitle>
              <ol className="max-h-[520px] space-y-0.5 overflow-y-auto pr-1">
                {(p?.feed ?? []).map((e: any) => (
                  <li key={e.id}>
                    <button disabled={!e.memory_id} onClick={() => e.memory_id && select(e.memory_id)} className="group flex w-full gap-3 rounded-[8px] px-2 py-1.5 text-left enabled:hover:bg-surface">
                      <span className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", e.status === "error" ? "bg-danger" : /conflict|failed/i.test(e.label) ? "bg-warn" : /Connection|connected/i.test(e.label) ? "bg-accent" : "bg-line-strong")} />
                      <span className="min-w-0 flex-1 text-[12.5px] leading-snug">
                        <span className="text-ink">{e.label}</span>
                        {e.description ? <span className="block truncate text-ink-2" title={e.description}>{e.description}</span> : null}
                        <span className="block text-[11.5px] text-ink-3">{timeAgo(e.at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {p && !p.feed.length ? <li className="px-2 text-[12.5px] text-ink-3">No activity yet.</li> : null}
              </ol>
            </div>

            <div>
              <SectionTitle aside={<button onClick={() => go("metamorphosis")} className="hover:text-ink">Sleep Cycle</button>}>Growth, last 14 days</SectionTitle>
              <Sparkline points={(ov?.growth ?? []).map((g: any) => g.memories)} />
              <p className="mt-2 text-[12px] text-ink-3">{p?.state.sleep.last_run ? `Last Sleep Cycle ${timeAgo(p.state.sleep.last_run)}.` : "No Sleep Cycle has run yet."} {p?.state.backup.last_ok ? `Last backup ${timeAgo(p.state.backup.last_ok)}.` : "No backup yet."}</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function BigTile({ icon, label, value, hint, tone, onClick }: { icon: ReactNode; label: string; value: number | undefined; hint?: string; tone?: "accent" | "warn"; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn("panel group px-4 py-3 text-left transition-colors hover:border-line-strong [&_svg]:size-4", tone === "accent" && "border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]", tone === "warn" && "border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)]")}>
      <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
        {icon} {label}
      </div>
      <div className={cn("mt-1 text-[28px] leading-tight tabular-nums", tone === "accent" ? "text-accent-soft" : tone === "warn" ? "text-warn" : "text-ink")}>{value === undefined ? <span className="skeleton inline-block h-7 w-12" /> : value.toLocaleString()}</div>
      {hint ? <div className="text-[11.5px] text-ink-3">{hint}</div> : null}
    </button>
  );
}

/** Pick up where you left off: per project, the stored next step and the latest handoff. */
function ContinuityFeed({ items }: { items: any[] | undefined }) {
  const { go } = useApp();
  return (
    <div className="mt-6" data-testid="feed-continuity">
      <SectionTitle aside={<button onClick={() => go("projects")} className="hover:text-ink">Projects</button>}>Pick up where you left off</SectionTitle>
      {items === undefined ? (
        <div className="skeleton h-20 w-full" />
      ) : items.length ? (
        <div className="grid gap-2.5 md:grid-cols-2">
          {items.map((x) => (
            <button key={x.project_id} onClick={() => go("projects", { id: x.project_id })} className="panel px-3.5 py-3 text-left hover:border-line-strong">
              <div className="flex items-center gap-2 text-[13px] text-ink">
                {x.name}
                <span className="ml-auto text-[11px] text-ink-3">{timeAgo(x.last_activity_at)}</span>
              </div>
              <p className="mt-1 text-[12.5px] text-ink-2">{x.next_step ? <>Next: <span className="text-ink">{x.next_step.text}</span></> : "No next step recorded yet."}</p>
              {x.next_step ? <p className="text-[11px] text-ink-3">{x.next_step.why}</p> : null}
              <p className="mt-1 text-[11.5px] text-ink-3">
                {x.handoff ? `Last handoff ${timeAgo(x.handoff.updated_at)} (${x.handoff.client}): ${x.handoff.summary}` : "No session handoff yet."}
              </p>
              {x.unresolved || x.blockers ? <p className="mt-1 text-[11.5px] text-warn">{[x.unresolved ? plural(x.unresolved, "open decision") : "", x.blockers ? plural(x.blockers, "blocker") : ""].filter(Boolean).join(" · ")}</p> : null}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-3">No projects yet. Projects appear when Claude saves work to one, or when you create one.</p>
      )}
    </div>
  );
}

const SEV_TONE: Record<string, string> = { high: "bg-danger", medium: "bg-warn", low: "bg-accent", info: "bg-line-strong" };
function AwarenessFeed({ items, total }: { items: any[] | undefined; total?: number }) {
  const { go, select } = useApp();
  return (
    <div className="mt-6" data-testid="feed-awareness">
      <SectionTitle aside={total && items && total > items.length ? <span>{total} in total</span> : undefined}>Needs attention</SectionTitle>
      {items === undefined ? (
        <div className="skeleton h-16 w-full" />
      ) : items.length ? (
        <ul className="space-y-0.5">
          {items.map((f) => (
            <li key={f.id}>
              <button
                onClick={() => (f.project_id ? go("projects", { id: f.project_id }) : f.memory_ids?.[0] ? select(f.memory_ids[0]) : undefined)}
                className="flex w-full gap-3 rounded-[8px] px-2 py-1.5 text-left hover:bg-surface"
              >
                <span className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", SEV_TONE[f.severity] ?? "bg-line-strong")} />
                <span className="min-w-0 flex-1 text-[12.5px] leading-snug">
                  <span className="text-ink">{f.title}</span>
                  <span className="block truncate text-ink-2">{f.description}</span>
                  {f.suggested_action ? <span className="block text-[11.5px] text-ink-3">{f.suggested_action}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">Nothing needs attention: no open decisions, blockers or unfinished work were found.</p>
      )}
    </div>
  );
}

function DiscoveryFeed({ items, onChange }: { items: any[] | undefined; onChange: () => void }) {
  const { go, toast } = useApp();
  const act = (p: Promise<unknown>, ok: string) => void p.then(() => (toast({ kind: "ok", text: ok }), onChange())).catch((e) => toast({ kind: "error", text: e.message }));
  return (
    <div data-testid="feed-discoveries">
      <SectionTitle aside={<button onClick={() => go("discoveries")} className="hover:text-ink">All discoveries</button>}>
        <span className="flex items-center gap-1.5"><Sparkles className="size-3.5" /> Strong discoveries</span>
      </SectionTitle>
      {items === undefined ? (
        <div className="skeleton h-14 w-full" />
      ) : items.length ? (
        <ul className="space-y-2">
          {items.map((f) => (
            <li key={f.id} className="rounded-[10px] border border-line px-3 py-2">
              <div className="text-[12.5px] text-ink">{f.title}</div>
              <div className="text-[11.5px] text-ink-3">confidence {Math.round((f.confidence ?? 0) * 100)}%</div>
              <div className="mt-1.5 flex gap-1.5">
                {f.action?.type === "link" || f.action?.type === "link_many" ? (
                  <Button size="sm" onClick={() => act(rpc("discovery.confirm", { id: f.id }), "Connected")}>
                    <Link2 /> Connect
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => go("discoveries")}>Look</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => act(rpc("findings.dismiss", { id: f.id, note: "Not relevant (Overview)" }), "Dismissed")}>
                  Not relevant
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">No strong discoveries right now.</p>
      )}
    </div>
  );
}

function AgentFeed({ items, approvals }: { items: any[] | undefined; approvals?: number }) {
  const { go } = useApp();
  return (
    <div data-testid="feed-agents">
      <SectionTitle aside={<button onClick={() => go("agents")} className="hover:text-ink">Agents</button>}>
        <span className="flex items-center gap-1.5"><Bot className="size-3.5" /> Agent activity</span>
      </SectionTitle>
      {approvals ? (
        <button onClick={() => go("agents")} className="mb-1.5 text-[12px] text-accent hover:text-accent-soft">
          {plural(approvals, "suggestion")} from agents waiting for your approval
        </button>
      ) : null}
      {items === undefined ? (
        <div className="skeleton h-14 w-full" />
      ) : items.length ? (
        <ul className="space-y-1">
          {items.map((j) => (
            <li key={j.id} className="text-[12px] leading-snug">
              <span className="text-ink">{j.title}</span> <span className={JOB_STATUS[j.status]?.tone}>{JOB_STATUS[j.status]?.label ?? j.status}</span>
              <span className="block truncate text-ink-3">{j.error ?? j.summary ?? ""} {timeAgo(j.finished_at ?? j.created_at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">No agent has run yet.</p>
      )}
    </div>
  );
}

function HealthFeed({ h }: { h: any | undefined }) {
  const { go } = useApp();
  return (
    <button onClick={() => go("health")} className="panel w-full px-3 py-2.5 text-left hover:border-line-strong" data-testid="feed-health">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
        <HeartPulse className="size-3.5" /> Knowledge health
        <span className={cn("ml-auto size-1.5 rounded-full", !h ? "bg-ink-3" : h.confirmed ? "bg-warn" : "bg-ok")} />
      </div>
      <div className="mt-1 text-[12.5px] text-ink">
        {!h ? "…" : !h.last_scan ? "Not checked yet" : h.confirmed || h.possible ? `${plural(h.confirmed, "confirmed issue")}, ${h.possible} possible` : "No issues found"}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">
        {h?.last_scan ? `Checked ${timeAgo(h.last_scan.at)}` : "Runs daily in the background"}
        {h?.repairs_7d ? ` · ${plural(h.repairs_7d, "automatic repair")} this week` : ""}
      </div>
    </button>
  );
}

function Tile({ icon, label, value, hint, tone, onClick }: { icon: ReactNode; label: string; value: number | undefined; hint?: string; tone?: "accent"; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn("panel group px-3 py-2.5 text-left transition-colors hover:border-line-strong [&_svg]:size-3.5", tone === "accent" && "border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]")}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
        {icon} {label}
      </div>
      <div className={cn("mt-1 text-[20px] tabular-nums", tone === "accent" ? "text-accent-soft" : "text-ink")}>{value === undefined ? <span className="skeleton inline-block h-5 w-10" /> : value.toLocaleString()}</div>
      {hint ? <div className="text-[11px] text-ink-3">{hint}</div> : null}
    </button>
  );
}

function Health({ icon, title, ok, line, sub, warn, onClick }: { icon: ReactNode; title: string; ok: boolean; line: string; sub?: string; warn?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="panel px-3 py-2.5 text-left hover:border-line-strong [&_svg]:size-3.5">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
        {icon} {title}
        <span className={cn("ml-auto size-1.5 rounded-full", warn ? "bg-warn" : ok ? "bg-ok" : "bg-ink-3")} />
      </div>
      <div className="mt-1 text-[12.5px] leading-snug text-ink">{line}</div>
      {sub ? <div className="mt-0.5 truncate text-[11.5px] text-ink-3">{sub}</div> : null}
    </button>
  );
}

function MiniList({ title, items, empty, onOpen, action }: { title: string; items: { id: string; title: string; sub: string }[]; empty: string; onOpen: (id: string) => void; action?: ReactNode }) {
  return (
    <div className="min-w-0">
      <SectionTitle>{title}</SectionTitle>
      <ul className="space-y-0.5">
        {items.map((m, i) => (
          <li key={`${m.id}-${i}`}>
            <button onClick={() => onOpen(m.id)} className="w-full rounded-[8px] px-2 py-1.5 text-left hover:bg-surface">
              <span className="block truncate text-[12.5px] text-ink">{m.title}</span>
              <span className="block truncate text-[11.5px] text-ink-3">{m.sub}</span>
            </button>
          </li>
        ))}
        {!items.length ? <li className="px-2 py-1 text-[12px] text-ink-3">{empty}{action ? <div className="mt-2">{action}</div> : null}</li> : null}
      </ul>
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

export type { Page };
