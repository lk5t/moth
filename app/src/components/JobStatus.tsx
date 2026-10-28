// Real job state from the durable job system: queued / running (indeterminate, no fake percentages) / done / failed /
// cancelled / interrupted / awaiting approval, with the real error text and a cancel button.
import { CircleX, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { rpc } from "../lib/api";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";
import { Button, Spinner } from "./ui";

export const JOB_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Queued", tone: "text-ink-3" },
  running: { label: "Running", tone: "text-accent-soft" },
  done: { label: "Completed", tone: "text-ok" },
  failed: { label: "Failed", tone: "text-danger" },
  cancelled: { label: "Cancelled", tone: "text-ink-3" },
  interrupted: { label: "Interrupted", tone: "text-warn" },
  awaiting_approval: { label: "Awaiting approval", tone: "text-accent-soft" },
};

export function jobDuration(j: any): string {
  if (!j?.started_at) return "";
  const end = j.finished_at ? Date.parse(j.finished_at) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(j.started_at)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function JobStatusLine({ id, onDone, className }: { id: number; onDone?: (job: any) => void; className?: string }) {
  const { data: job, reload } = useLive<any>("jobs.get", { id }, { entities: ["job"] });
  const st = job?.status as string | undefined;
  const final = st && !["pending", "running"].includes(st);
  useEffect(() => {
    if (final) onDone?.(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [final]);
  // Running jobs change state without always emitting a change event in between: poll gently while active.
  useEffect(() => {
    if (final) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [final, reload]);
  if (!job) return null;
  const s = JOB_STATUS[st!] ?? { label: st, tone: "text-ink-3" };
  return (
    <div className={cn("panel flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]", className)} role="status" aria-live="polite">
      {st === "running" || st === "pending" ? <Spinner className="size-3.5 text-accent-soft" /> : null}
      <span className="text-ink">{job.title || job.kind}</span>
      <span className={s.tone}>{s.label}</span>
      {job.started_at ? <span className="text-ink-3">{st === "running" ? `for ${jobDuration(job)}` : jobDuration(job)}</span> : <span className="text-ink-3">queued {timeAgo(job.created_at)}</span>}
      {job.last_error && st !== "done" ? <span className="basis-full text-[12px] text-danger">{job.last_error}</span> : null}
      <span className="ml-auto flex gap-1">
        {st === "pending" || st === "running" ? (
          <Button size="sm" variant="ghost" onClick={() => void rpc("jobs.cancel", { id }).then(reload)}>
            <CircleX /> Cancel
          </Button>
        ) : null}
        {st === "failed" || st === "interrupted" || st === "cancelled" ? (
          <Button size="sm" variant="ghost" onClick={() => void rpc("jobs.retry", { id }).then(reload)}>
            <RotateCcw /> Retry
          </Button>
        ) : null}
      </span>
    </div>
  );
}
