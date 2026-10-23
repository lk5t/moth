// Cortex activity: a small moth that beats its wings only while the local AI is really working.
// Text comes from the real runtime state, job queue and install progress. No invented percentages.
import { Check, CircleAlert } from "lucide-react";
import { cn } from "../lib/utils";

const PHASE: Record<string, string> = {
  downloading_runtime: "Downloading the llama.cpp runtime",
  extracting: "Unpacking the runtime",
  downloading_model: "Downloading the model",
  verifying: "Checking the files (SHA-256)",
};

export function cortexActivity(st: any): { kind: "busy" | "idle" | "error" | "done" | "off"; text: string; progress: number | null } {
  if (!st) return { kind: "off", text: "", progress: null };
  const ins = st.install;
  if (ins && PHASE[ins.phase]) return { kind: "busy", text: `${PHASE[ins.phase]}…`, progress: ins.total ? ins.received / ins.total : null };
  if (st.paused) return { kind: "off", text: "Paused", progress: null };
  if (!st.readiness?.ok) return { kind: "off", text: st.readiness?.reason ?? "Not available", progress: null };
  const rt = st.runtime?.state;
  if (rt === "error") return { kind: "error", text: st.errors?.[0]?.message ?? "The local model stopped with an error", progress: null };
  if (rt === "starting") return { kind: "busy", text: "Loading the model into memory…", progress: null };
  if (rt === "busy" || st.current_task) {
    const label = String(st.current_task?.label ?? "");
    const what = /extract/.test(label) ? "Reading new information" : /compare/.test(label) ? "Comparing with what MOTH knows" : /context/.test(label) ? "Preparing context for Claude" : /organi/.test(label) ? "Organising a captured memory" : "Thinking";
    return { kind: "busy", text: `${what}…${st.queue?.pending_jobs > 1 ? ` (${st.queue.pending_jobs - 1} more waiting)` : ""}`, progress: null };
  }
  if (st.queue?.pending_jobs) return { kind: "busy", text: `${st.queue.pending_jobs} task${st.queue.pending_jobs === 1 ? "" : "s"} waiting to be analysed`, progress: null };
  const last = st.recent?.[0];
  if (last && Date.now() - Date.parse(last.created_at) < 15_000 && (last.action === "learn" || last.action === "analyze")) {
    const d = last.detail ?? {};
    return last.status === "error" ? { kind: "error", text: "The last analysis failed", progress: null } : { kind: "done", text: `Done: ${d.applied ?? 0} applied, ${d.queued ?? 0} waiting for review`, progress: null };
  }
  return { kind: "idle", text: rt === "ready" ? "Ready (model loaded)" : "Ready (loads on demand)", progress: null };
}

export function MothWings({ active, size = 18, className }: { active: boolean; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn("text-accent-soft", className)} aria-hidden>
      <g fill="currentColor" fillRule="evenodd">
        <g className={active ? "moth-flap" : undefined} style={{ transformOrigin: "32px 30px", transformBox: "view-box" }}>
          <path d="M30.6 25.5 9 13.5l4.6 19.8 17-1.6Z" />
          <path d="M30.4 34.2 14.8 36.6l9 13.4 6.6-8.8Z" opacity=".72" />
        </g>
        <g className={active ? "moth-flap" : undefined} style={{ transformOrigin: "32px 30px", transformBox: "view-box" }}>
          <path d="M33.4 25.5 55 13.5l-4.6 19.8-17-1.6Z" />
          <path d="M33.6 34.2l15.6 2.4-9 13.4-6.6-8.8Z" opacity=".72" />
        </g>
        <path d="M32 18.5 34.4 31 32 51.5 29.6 31Z" />
      </g>
    </svg>
  );
}

export function CortexPulse({ st, className }: { st: any; className?: string }) {
  const a = cortexActivity(st);
  if (a.kind === "off" && !a.text) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[12px] border px-3.5 py-2.5 text-[12.5px] transition-colors duration-300",
        a.kind === "busy" ? "border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)] text-ink" : a.kind === "error" ? "border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] text-danger" : "border-line text-ink-2",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {a.kind === "done" ? <Check className="size-4 text-ok" /> : a.kind === "error" ? <CircleAlert className="size-4" /> : <MothWings active={a.kind === "busy"} className={a.kind === "busy" ? "" : "opacity-60"} />}
      <span className="min-w-0 flex-1 truncate">{a.text}</span>
      {a.progress != null ? (
        <span className="flex items-center gap-2">
          <span className="h-1 w-28 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(a.progress * 100)}%` }} />
          </span>
          <span className="tabular-nums text-ink-3">{Math.round(a.progress * 100)}%</span>
        </span>
      ) : a.kind === "busy" ? (
        <span className="moth-shimmer h-1 w-20 rounded-full" />
      ) : null}
    </div>
  );
}
