// Knowledge Health dashboard: findings per check (confirmed vs possible), evidence, compare, propose → approve/reject,
// dismiss false positives, repair history. No overall "health score" (see each check's "how it works").
import { Check, ChevronDown, CircleSlash, GitMerge, HeartPulse, Play, Wrench, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Empty, PageHeader } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";
import { JobStatusLine } from "../components/JobStatus";

export function HealthPage() {
  const { toast } = useApp();
  const { data: summary } = useLive<any>("health.summary", {}, { entities: ["finding", "memory", "job"] });
  const { data: findings, reload } = useLive<any[]>("findings.list", { kind: "health", status: "active", limit: 300 }, { entities: ["finding", "memory", "review", "job"] });
  const { data: repairs } = useLive<any[]>("health.repairs", { limit: 30 }, { entities: ["finding", "activity", "job"] });
  const { data: reviews, reload: reloadReviews } = useLive<any[]>("inbox.list", { limit: 300 }, { entities: ["review"] });
  const [jobId, setJobId] = useState<number | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { data: done } = useLive<any[]>("findings.list", { kind: "health", status: "all", limit: 100 }, { entities: ["finding"], enabled: showDone });
  const reviewFor = useMemo(() => {
    const m = new Map<number, any>();
    for (const r of reviews ?? []) if (r.proposal?.finding_id) m.set(Number(r.proposal.finding_id), r);
    return m;
  }, [reviews]);

  const run = async () => {
    try {
      const r = await rpc<any>("health.scan");
      setJobId(r.job_id);
      if (!r.job_id) toast({ kind: "info", text: "A health check is already queued" });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: ok });
      void reload();
      void reloadReviews();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const list = (findings ?? []).filter((f) => !filter || f.category === filter);
  const checks = summary?.checks ?? [];
  const total = (findings ?? []).length;

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Knowledge Health"
        description="Quality checks on what MOTH knows. Confirmed problems are told apart from possible ones; nothing is merged, replaced or deleted without your approval. Search indexes and similarity data are repaired automatically because they're rebuilt from your memories."
        actions={
          <Button onClick={() => void run()}>
            <Play /> Run checks now
          </Button>
        }
      />
      <div className="grid gap-4 px-8 pb-10">
        {jobId ? <JobStatusLine id={jobId} onDone={() => void reload()} /> : null}
        <section className="panel p-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <h2 className="text-[13.5px] text-ink">Checks</h2>
            <span className="text-[12px] text-ink-3">{summary?.last_scan ? `Last run ${timeAgo(summary.last_scan.at)}` : "Not run yet"} · {total} open finding{total === 1 ? "" : "s"} · no overall score: each check measures something different</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {checks.map((c: any) => (
              <button
                key={c.check}
                onClick={() => setFilter(filter === c.check ? null : c.check)}
                className={cn("rounded-[10px] border p-3 text-left transition-colors", filter === c.check ? "border-accent/60 bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]" : "border-line hover:border-line-strong")}
                title={c.how}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] text-ink">
                  {c.label}
                  {c.confirmed + c.possible === 0 ? <Check className="ml-auto size-3.5 text-ok" /> : null}
                </span>
                <span className="mt-1 flex gap-1.5 text-[11.5px]">
                  {c.confirmed ? <Badge tone="warn">{c.confirmed} confirmed</Badge> : null}
                  {c.possible ? <Badge>{c.possible} possible</Badge> : null}
                  {c.confirmed + c.possible === 0 ? <span className="text-ink-3">Nothing found</span> : null}
                </span>
                <span className="mt-1.5 line-clamp-2 block text-[11px] text-ink-3">{c.how}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="grid gap-2">
          {list.length ? (
            list.map((f) => <FindingCard key={f.id} f={f} review={reviewFor.get(Number(f.id))} act={act} />)
          ) : (
            <Empty icon={<HeartPulse />} title={filter ? "Nothing open for this check" : "No open health findings"}>
              {summary?.last_scan ? "MOTH checks once a day in the background, or when you run the checks." : "Run the checks to see how your knowledge is doing."}
            </Empty>
          )}
        </section>

        <section className="panel p-4">
          <div className="mb-2 flex items-center gap-2">
            <Wrench className="size-4 text-ink-3" />
            <h2 className="text-[13.5px] text-ink">Repair history</h2>
            <span className="text-[11.5px] text-ink-3">Automatic repairs of derived data only</span>
            <button className="ml-auto text-[12px] text-ink-3 hover:text-ink" onClick={() => setShowDone(!showDone)}>
              {showDone ? "Hide" : "Show"} closed findings
            </button>
          </div>
          {(repairs ?? []).length ? (
            <ul className="space-y-1 text-[12.5px]">
              {repairs!.map((r) => (
                <li key={r.id} className="flex gap-3">
                  <span className="w-28 shrink-0 text-ink-3">{timeAgo(r.created_at)}</span>
                  <span className="text-ink-2">{r.detail?.action ?? r.action}</span>
                  {r.detail?.problem ? <span className="truncate text-ink-3">({r.detail.problem})</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-3">No automatic repairs so far.</p>
          )}
          {showDone ? (
            <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[12.5px]">
              {(done ?? []).filter((f) => !["new", "viewed"].includes(f.status)).map((f) => (
                <li key={f.id} className="flex gap-3">
                  <span className="w-20 shrink-0 text-ink-3">{f.status}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{f.title}</span>
                  <span className="shrink-0 text-ink-3">{f.resolution}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function FindingCard({ f, review, act }: { f: any; review?: any; act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const { select, go } = useApp();
  const [open, setOpen] = useState(false);
  const canPropose = f.action?.type === "merge" || f.action?.type === "relink";
  const two = (f.memories ?? []).length === 2;
  return (
    <article className={cn("panel p-3.5", f.status === "new" && "border-[color-mix(in_srgb,var(--color-accent)_25%,transparent)]")}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", f.evidence_status === "confirmed" ? "bg-warn" : "bg-ink-3")} />
        <div className="min-w-0 flex-1">
          <button className="text-left text-[13px] text-ink hover:text-accent-soft" onClick={() => (setOpen(!open), f.status === "new" && void rpc("findings.view", { id: f.id }))}>
            {f.title}
          </button>
          <p className="mt-0.5 text-[12px] text-ink-2">{f.description}</p>
          <p className="mt-1 text-[11px] text-ink-3">
            {f.evidence_status === "confirmed" ? "Confirmed problem" : "Possible problem"} · severity {f.severity}
            {f.confidence != null ? ` · confidence ${Math.round(f.confidence * 100)}%` : ""} · found {timeAgo(f.created_at)} by {f.algorithm}
          </p>
        </div>
        <button onClick={() => setOpen(!open)} className="text-ink-3 hover:text-ink" aria-label="Details">
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open ? (
        <div className="mt-3 border-t border-line pt-3">
          {two ? (
            <div className="grid gap-2 md:grid-cols-2">
              {f.memories.map((m: any) => {
                const ev = (f.evidence ?? []).find((e: any) => e.memory_id === m.id);
                return (
                  <button key={m.id} onClick={() => select(m.id)} className="rounded-[9px] border border-line p-2.5 text-left hover:border-accent/50">
                    <span className="block text-[12.5px] text-ink">{m.title}</span>
                    {ev?.quote ? <span className="mt-1 block whitespace-pre-wrap text-[12px] text-ink-2">{ev.quote}</span> : null}
                    <span className="mt-1 block text-[11px] text-ink-3">
                      {m.status} · v{m.version} · updated {timeAgo(m.updated_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <ul className="space-y-1">
              {(f.evidence ?? []).map((e: any, i: number) => (
                <li key={i} className="text-[12px] text-ink-2">
                  {e.memory_id ? (
                    <button className="text-accent hover:text-accent-soft" onClick={() => select(e.memory_id)}>
                      {f.memories.find((m: any) => m.id === e.memory_id)?.title ?? e.memory_id}
                    </button>
                  ) : null}
                  {e.memory_id ? " · " : ""}
                  {e.note}
                  {e.quote ? <span className="block text-ink-3">“{e.quote}”</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12px] text-ink-2">
            <span className="text-ink-3">Recommended: </span>
            {f.suggested_action}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {review ? (
              <>
                <span className="self-center text-[12px] text-ink-3">Proposed change waiting for you:</span>
                <Button size="sm" variant="primary" onClick={() => void act(() => rpc("inbox.approve", { id: review.id }), "Applied")}>
                  <Check /> Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void act(() => rpc("inbox.reject", { id: review.id, note: "Rejected on the Knowledge Health page" }), "Rejected: nothing was changed")}>
                  <X /> Reject
                </Button>
              </>
            ) : canPropose ? (
              <Button size="sm" onClick={() => void act(() => rpc("health.propose", { id: f.id }), "Proposed. Approve it to apply, or reject to keep things as they are.")}>
                <GitMerge /> {f.action.type === "merge" ? "Propose merge" : "Propose repair"}
              </Button>
            ) : f.action?.type === "open_reviews" ? (
              <Button size="sm" onClick={() => go("inbox")}>
                Open review queue
              </Button>
            ) : f.action?.type === "open_project" ? (
              <Button size="sm" onClick={() => go("projects", { id: f.action.project_id })}>
                Open project
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void act(() => rpc("findings.resolve", { id: f.id, note: "Fixed by you" }), "Marked as fixed")}>
              <Check /> Fixed
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void act(() => rpc("findings.dismiss", { id: f.id, note: "Not a problem" }), "Dismissed. It won't be raised again unless something changes.")}>
              <CircleSlash /> Not a problem
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
