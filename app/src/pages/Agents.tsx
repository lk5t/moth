// MOTH Agents: four workers on the shared job system and Cortex. Real job states only (no simulated progress), real
// results with their evidence, approval queue for consequential changes, per-agent controls and permissions.
import { Bot, ChevronDown, FlaskConical, FolderKanban, Play, ShieldCheck, Sparkles, Wand } from "lucide-react";
import { useState, type ReactNode } from "react";
import { JOB_STATUS, JobStatusLine, jobDuration } from "../components/JobStatus";
import { ReviewList } from "../components/ReviewList";
import { Badge, Button, Empty, PageHeader, Switch } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";

const ICON: Record<string, ReactNode> = {
  research_analyst: <FlaskConical />,
  memory_curator: <Wand />,
  project_analyst: <FolderKanban />,
  knowledge_connector: <Sparkles />,
};

export function AgentsPage() {
  const { toast, go } = useApp();
  const { data: agents, reload } = useLive<any[]>("agents.overview", {}, { entities: ["job", "review", "finding", "settings"] });
  const { data: approvals, reload: reloadApprovals } = useLive<any[]>("agents.approvals", {}, { entities: ["review", "job"] });
  const { data: jobs } = useLive<any[]>("agents.jobs", { limit: 40 }, { entities: ["job"] });
  const { data: results } = useLive<any[]>("findings.list", { kind: "agent", status: "active", limit: 100 }, { entities: ["finding", "job"] });
  const [running, setRunning] = useState<Record<string, number>>({});
  const set = async (id: string, patch: Record<string, unknown>) => {
    try {
      await rpc("agents.config", { id, patch });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const run = async (id: string) => {
    try {
      const r = await rpc<any>("agents.run", { id });
      if (r.job_id) setRunning((m) => ({ ...m, [id]: r.job_id }));
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Agents"
        description="Four specialised workers that share MOTH's job system and its local AI (one model, one job at a time). They analyse and suggest on their own; merging, moving, creating or deleting knowledge always waits for your approval. They never run programs, browse the web or read your files."
      />
      <div className="grid gap-4 px-8 pb-10">
        <div className="grid gap-3 lg:grid-cols-2">
          {(agents ?? []).map((a) => (
            <section key={a.id} className={cn("panel p-4", !a.config.enabled && "opacity-70")}>
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line bg-surface-2 text-accent-soft [&_svg]:size-4">{ICON[a.id] ?? <Bot />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] text-ink">{a.name}</h2>
                    {a.pending_approvals ? <Badge tone="accent">{a.pending_approvals} to approve</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">{a.description}</p>
                  {a.ai ? <p className="mt-1 text-[11.5px] text-ink-3">{a.ai.ok ? "Local AI available: written results are on." : `Local AI not available (${a.ai.reason}): runs its plain checks only.`}</p> : null}
                </div>
                <Switch checked={!!a.config.enabled} onChange={(v) => void set(a.id, { enabled: v })} label={`${a.name} on`} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-2">
                <label className="flex items-center gap-2">
                  <Switch checked={!!a.config.background} disabled={!a.config.enabled} onChange={(v) => void set(a.id, { background: v })} label="Run in the background" />
                  In the background
                </label>
                <label className="flex items-center gap-1.5">
                  every
                  <select className="h-7 rounded-[7px] border border-line bg-surface px-1.5 text-[12px] text-ink" value={a.config.everyHours} onChange={(e) => void set(a.id, { everyHours: Number(e.target.value) })} aria-label="How often">
                    {[6, 12, 24, 72, 168].map((h) => (
                      <option key={h} value={h}>
                        {h < 24 ? `${h} h` : h === 24 ? "day" : h === 72 ? "3 days" : "week"}
                      </option>
                    ))}
                  </select>
                </label>
                {a.config.maxItems ? (
                  <label className="flex items-center gap-1.5" title="Upper bound on the work done in one run (keeps background runs short)">
                    at most
                    <select className="h-7 rounded-[7px] border border-line bg-surface px-1.5 text-[12px] text-ink" value={a.config.maxItems} onChange={(e) => void set(a.id, { maxItems: Number(e.target.value) })} aria-label="Items per run">
                      {[5, 10, 15, 25, 50, 100].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    per run
                  </label>
                ) : null}
                <Button size="sm" className="ml-auto" disabled={!a.config.enabled} onClick={() => void run(a.id)}>
                  <Play /> Run now
                </Button>
              </div>
              {running[a.id] ? (
                <JobStatusLine id={running[a.id]} className="mt-3" />
              ) : a.last_job ? (
                <p className="mt-3 text-[11.5px] text-ink-3">
                  Last run {timeAgo(a.last_job.created_at)}: <span className={JOB_STATUS[a.last_job.status]?.tone}>{JOB_STATUS[a.last_job.status]?.label}</span>
                  {a.last_job.result?.summary ? ` · ${a.last_job.result.summary}` : ""}
                  {a.last_job.last_error && a.last_job.status !== "done" ? ` · ${a.last_job.last_error}` : ""}
                </p>
              ) : (
                <p className="mt-3 text-[11.5px] text-ink-3">Hasn't run yet.</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {(a.permissions ?? []).map((p: any) => (
                  <span key={p.permission} title={p.hint} className={cn("rounded-full border px-1.5 text-[10.5px]", p.allowed ? "border-[color-mix(in_srgb,var(--color-ok)_40%,transparent)] text-ok" : "border-line text-ink-3 line-through decoration-ink-3/40")}>
                    {p.label}
                  </span>
                ))}
                <button className="ml-1 text-[10.5px] text-accent hover:text-accent-soft" onClick={() => go("connections", { tab: "permissions" })}>
                  <ShieldCheck className="mr-0.5 inline size-3" /> Permissions
                </button>
              </div>
            </section>
          ))}
        </div>

        <section className="panel p-4">
          <h2 className="mb-2 text-[13.5px] text-ink">Waiting for your approval ({(approvals ?? []).length})</h2>
          <ReviewList items={approvals ?? []} onDone={() => (void reloadApprovals(), void reload())} empty="Nothing from the agents is waiting for you." />
        </section>

        <section className="panel p-4">
          <h2 className="mb-2 text-[13.5px] text-ink">Results</h2>
          {(results ?? []).length ? (
            <div className="grid gap-2">
              {results!.map((f) => (
                <ResultCard key={f.id} f={f} />
              ))}
            </div>
          ) : (
            <Empty icon={<Bot />} title="No results yet">Run an agent, or let them run in the background.</Empty>
          )}
        </section>

        <section className="panel p-4">
          <h2 className="mb-2 text-[13.5px] text-ink">Job history</h2>
          {(jobs ?? []).length ? (
            <table className="w-full text-left text-[12px]">
              <thead className="text-ink-3">
                <tr>
                  <th className="py-1 font-normal">Agent</th>
                  <th className="font-normal">Status</th>
                  <th className="font-normal">Started</th>
                  <th className="font-normal">Took</th>
                  <th className="font-normal">Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs!.map((j) => (
                  <tr key={j.id} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3 text-ink">{j.title || j.kind}</td>
                    <td className={cn("pr-3", JOB_STATUS[j.status]?.tone)}>{JOB_STATUS[j.status]?.label ?? j.status}</td>
                    <td className="pr-3 text-ink-3">{j.started_at ? timeAgo(j.started_at) : `queued ${timeAgo(j.created_at)}`}</td>
                    <td className="pr-3 text-ink-3">{jobDuration(j)}</td>
                    <td className="text-ink-2">{j.status === "failed" || j.status === "interrupted" ? <span className="text-danger">{j.last_error}</span> : j.result?.summary ?? j.result?.skipped ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[12.5px] text-ink-3">No agent runs yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ResultCard({ f }: { f: any }) {
  const { select, go } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <article className="rounded-[10px] border border-line p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <span>{String(f.agent ?? "").replace("agent:", "").replace("_", " ")}</span>·<span>{timeAgo(f.updated_at)}</span>
            {f.model ? <span>· written with {f.model}</span> : null}
          </div>
          <button className="mt-0.5 text-left text-[13px] text-ink hover:text-accent-soft" onClick={() => setOpen(!open)}>
            {f.title}
          </button>
          <p className="mt-0.5 whitespace-pre-line text-[12px] text-ink-2">{f.description}</p>
        </div>
        <button onClick={() => setOpen(!open)} className="text-ink-3 hover:text-ink" aria-label="Evidence">
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open ? (
        <div className="mt-2 border-t border-line pt-2">
          <p className="mb-1 text-[11px] uppercase tracking-[0.08em] text-ink-3">Evidence</p>
          <ul className="space-y-0.5">
            {(f.evidence ?? []).map((e: any, i: number) => (
              <li key={i} className="text-[12px] text-ink-2">
                {e.memory_id ? (
                  <button className="text-accent hover:text-accent-soft" onClick={() => select(e.memory_id)}>
                    open
                  </button>
                ) : null}{" "}
                {e.note}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            {f.action?.type === "resume_project" ? (
              <Button size="sm" onClick={() => go("projects", { id: f.action.project_id })}>
                Open project
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void rpc("findings.dismiss", { id: f.id, note: "Dismissed on the Agents page" })}>
              Dismiss
            </Button>
          </div>
          {f.action?.ai_note ? <p className="mt-1 text-[11px] text-ink-3">{f.action.ai_note}</p> : null}
        </div>
      ) : null}
    </article>
  );
}
