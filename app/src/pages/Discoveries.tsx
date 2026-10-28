// Discoveries (quiet mode): evidence-backed connections between things MOTH already knows. Nothing is linked until
// you press Connect; Dismiss keeps it from coming back unless its evidence changes.
import { Check, Link2, Play, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { JobStatusLine } from "../components/JobStatus";
import { Badge, Button, Empty, PageHeader } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";

const KIND_LABEL: Record<string, string> = {
  cross_project: "Fits another project",
  answers_question: "May answer an open question",
  supporting_evidence: "Supports a decision",
};

export function DiscoveriesPage() {
  const { toast } = useApp();
  const { data, reload } = useLive<any[]>("findings.list", { kind: "discovery", status: "active", limit: 200 }, { entities: ["finding", "memory", "job"] });
  const { data: cfg } = useLive<any>("discovery.settings", {}, { entities: ["finding", "settings"] });
  const [history, setHistory] = useState(false);
  const { data: past } = useLive<any[]>("findings.list", { kind: "discovery", status: "all", limit: 100 }, { entities: ["finding"], enabled: history });
  const [jobId, setJobId] = useState<number | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: ok });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const list = data ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Discoveries"
        description="Connections between things you already saved: a lesson that fits another project, research that may answer an open question, notes that back up a decision. Quiet: only confident suggestions, no pop-ups. Nothing is connected until you say so."
        actions={
          <Button onClick={() => void rpc<any>("discovery.scan").then((r) => setJobId(r.job_id)).catch((e) => toast({ kind: "error", text: e.message }))}>
            <Play /> Look for connections
          </Button>
        }
      />
      <div className="grid gap-3 px-8 pb-10">
        {jobId ? <JobStatusLine id={jobId} onDone={() => void reload()} /> : null}
        <p className="text-[11.5px] text-ink-3">
          Shown when confidence is at least {Math.round((cfg?.min_confidence ?? 0.6) * 100)}%. Confidence comes from word similarity and the meaningful words both memories share (listed on each card); categories you keep dismissing need more. MOTH's similarity is word-based, so related ideas phrased very differently can be missed.
        </p>
        {list.length ? (
          list.map((f) => <DiscoveryCard key={f.id} f={f} act={act} />)
        ) : (
          <Empty icon={<Sparkles />} title="No new discoveries">
            MOTH looks for connections in the background after your knowledge changes (at most every 6 hours), or when you ask.
          </Empty>
        )}
        <button className="justify-self-start text-[12px] text-ink-3 hover:text-ink" onClick={() => setHistory(!history)}>
          {history ? "Hide" : "Show"} earlier discoveries
        </button>
        {history ? (
          <ul className="panel space-y-1 p-3 text-[12.5px]">
            {(past ?? []).filter((f) => !["new", "viewed"].includes(f.status)).map((f) => (
              <li key={f.id} className="flex gap-3">
                <span className={cn("w-20 shrink-0", f.status === "confirmed" ? "text-ok" : "text-ink-3")}>{f.status}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{f.title}</span>
                <span className="shrink-0 text-ink-3">{timeAgo(f.decided_at ?? f.updated_at)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function DiscoveryCard({ f, act, compact }: { f: any; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; compact?: boolean }) {
  const { select } = useApp();
  const canLink = f.action?.type === "link" || f.action?.type === "link_many";
  return (
    <article className="panel p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">{KIND_LABEL[f.category] ?? f.category}</Badge>
        <span className="text-[11.5px] text-ink-3">confidence {Math.round((f.confidence ?? 0) * 100)}%</span>
        {(f.projects ?? []).map((p: any) => (
          <span key={p.id} className="text-[11.5px] text-ink-3">
            · {p.name}
          </span>
        ))}
        <span className="ml-auto text-[11px] text-ink-3">{timeAgo(f.created_at)}</span>
      </div>
      <h3 className="mt-1.5 text-[13.5px] text-ink">{f.title}</h3>
      <p className="mt-0.5 text-[12.5px] text-ink-2">{f.description}</p>
      {!compact ? (
        <div className={cn("mt-2.5 grid gap-2", (f.memories ?? []).length > 1 && "md:grid-cols-2", (f.memories ?? []).length > 2 && "xl:grid-cols-3")}>
          {(f.memories ?? []).map((m: any) => {
            const ev = (f.evidence ?? []).find((e: any) => e.memory_id === m.id);
            return (
              <button key={m.id} onClick={() => select(m.id)} className="rounded-[9px] border border-line p-2.5 text-left hover:border-accent/50">
                <span className="block text-[12.5px] text-ink">{m.title}</span>
                {ev?.quote ? <span className="mt-1 line-clamp-4 block text-[12px] text-ink-2">{ev.quote}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {f.action?.shared?.length ? <p className="mt-2 text-[11.5px] text-ink-3">Shared words: {f.action.shared.join(", ")}</p> : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {canLink ? (
          <Button size="sm" variant="primary" onClick={() => void act(() => rpc("discovery.confirm", { id: f.id }), "Connected. It now shows up as a normal connection.")}>
            <Link2 /> Connect
          </Button>
        ) : (
          <Button size="sm" onClick={() => void act(() => rpc("findings.confirm", { id: f.id, note: "Useful" }), "Marked useful")}>
            <Check /> Useful
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void act(() => rpc("findings.dismiss", { id: f.id, note: "Not relevant" }), "Dismissed. It won't be suggested again unless something changes.")}>
          <X /> Not relevant
        </Button>
      </div>
    </article>
  );
}
