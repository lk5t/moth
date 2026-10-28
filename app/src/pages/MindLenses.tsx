// The Mind 3.0 lenses: neural pathways, knowledge evolution, suggested connections and attention.
// Everything shown here comes from stored records: real relationships, version history, discovery findings and
// awareness findings. Nothing is drawn as a connection unless it's stored, and suggestions are always dashed.
import { Link2, Pause, Play, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { RELATION_LABEL, cn } from "../lib/utils";

const card = "rounded-[14px] border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[#161616]/95 p-3.5 shadow-[0_16px_50px_rgba(0,0,0,0.5)] backdrop-blur";

export interface PathState {
  from?: { id: string; title: string };
  to?: { id: string; title: string };
  result?: any;
  loading?: boolean;
  error?: string;
}

/** Shows the chosen pair, then the chain of real connections between them (or that there is none). */
export function PathPanel({ state, inView, onGo, onReset, onClose }: { state: PathState; inView: (id: string) => boolean; onGo: (id: string) => void; onReset: () => void; onClose: () => void }) {
  const r = state.result;
  const outside = r?.found ? (r.node_ids as string[]).filter((id) => !inView(id)).length : 0;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cn(card, "absolute bottom-4 left-4 w-[360px]")} data-testid="path-panel">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.14em] text-accent-soft">Path between memories</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close path">
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-1.5 grid gap-0.5 text-[12.5px]">
        <span className="text-ink-2">
          From: <b className="font-normal text-ink">{state.from?.title ?? "click a memory"}</b>
        </span>
        <span className="text-ink-2">
          To: <b className="font-normal text-ink">{state.to?.title ?? (state.from ? "click a second memory" : "…")}</b>
        </span>
      </div>
      {state.loading ? <p className="mt-2 text-[12px] text-ink-3">Following stored connections…</p> : null}
      {state.error ? <p className="mt-2 text-[12px] text-danger">{state.error}</p> : null}
      {r && !r.found ? <p className="mt-2 text-[12.5px] text-ink-2">{r.message}</p> : null}
      {r?.found ? (
        <>
          <p className="mt-2 text-[11.5px] text-ink-3">
            {r.hops} step{r.hops === 1 ? "" : "s"}, the shortest chain of saved connections{outside ? ` · ${outside} memor${outside === 1 ? "y is" : "ies are"} outside this view` : ""}
          </p>
          <ol className="mt-1 max-h-[220px] space-y-1 overflow-y-auto">
            {r.steps.map((s: any, i: number) => (
              <li key={s.relationship.id} className="rounded-[8px] px-1.5 py-1 text-[12px] hover:bg-surface-2">
                {i === 0 ? (
                  <button className="text-left text-ink hover:text-accent-soft" onClick={() => onGo(s.from.id)}>
                    {s.from.title}
                  </button>
                ) : null}
                <div className="text-ink-3">
                  ↓ {RELATION_LABEL[s.relationship.type] ?? s.relationship.type}
                  {s.direction === "backward" ? " (pointing back)" : ""}
                  {s.relationship.reason ? <span className="text-ink-2"> · “{s.relationship.reason}”</span> : null}
                </div>
                <button className="text-left text-ink hover:text-accent-soft" onClick={() => onGo(s.to.id)}>
                  {s.to.title}
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {state.from ? (
        <button className="mt-2 text-[12px] text-accent hover:text-accent-soft" onClick={onReset}>
          Pick two other memories
        </button>
      ) : null}
    </motion.div>
  );
}

/** A slider over the real days on which the knowledge changed. Picking a day rebuilds the graph as it was then. */
export function HistoryBar({ projectIds, onGraph, onClose }: { projectIds?: string[]; onGraph: (g: any | null) => void; onClose: () => void }) {
  const { toast } = useApp();
  const [days, setDays] = useState<{ day: string; n: number }[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const seq = useRef(0);
  useEffect(() => {
    void rpc<any>("graph.moments").then((m) => {
      setDays(m.days);
      setIdx(m.days.length); // "now"
    });
    return () => onGraph(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const key = JSON.stringify(projectIds ?? []);
  useEffect(() => {
    if (!days) return;
    if (idx >= days.length) {
      setInfo(null);
      onGraph(null);
      return;
    }
    const n = ++seq.current;
    void rpc<any>("graph.at", { at: `${days[idx].day}T23:59:59.999Z`, projectIds })
      .then((g) => {
        if (n !== seq.current) return;
        setInfo(g);
        onGraph(g);
      })
      .catch((e) => toast({ kind: "error", text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, days, key]);
  useEffect(() => {
    if (!playing || !days) return;
    if (idx >= days.length) return setPlaying(false);
    const t = setTimeout(() => setIdx((i) => i + 1), 1300);
    return () => clearTimeout(t);
  }, [playing, idx, days]);
  if (!days) return null;
  const label = idx >= days.length ? "Now" : new Date(`${days[idx].day}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cn(card, "absolute bottom-4 left-1/2 w-[min(640px,calc(100%-32px))] -translate-x-1/2")} data-testid="history-bar">
      <div className="flex items-center gap-3">
        <button
          aria-label={playing ? "Pause" : "Play from the start"}
          className="grid size-8 shrink-0 place-items-center rounded-full border border-line text-ink-2 hover:text-ink [&_svg]:size-4"
          onClick={() => {
            if (!playing && idx >= days.length) setIdx(0);
            setPlaying(!playing);
          }}
          disabled={!days.length}
        >
          {playing ? <Pause /> : <Play />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="text-ink" data-testid="history-label">{label}</span>
            <span className="text-[11.5px] text-ink-3">{info ? `${info.nodes.length.toLocaleString()} memories · ${info.links.length.toLocaleString()} connections` : `${days.length} day${days.length === 1 ? "" : "s"} with changes`}</span>
          </div>
          <input type="range" min={0} max={days.length} step={1} value={idx} onChange={(e) => (setPlaying(false), setIdx(Number(e.target.value)))} className="mt-1 w-full accent-[var(--color-accent)]" aria-label="Moment in time" />
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close history">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-3">
        {idx < days.length
          ? `Each step is a day on which something actually changed (${days[idx].n} change${Number(days[idx].n) === 1 ? "" : "s"}). Titles are shown as they were then; removed connections are restored. Permanently deleted memories can't be shown.`
          : "Move the slider back to see how your knowledge grew. Only days with real changes are steps."}
      </p>
    </motion.div>
  );
}

/** Suggested connections (from Discoveries), listed beside the dashed lines, with Connect / Not relevant. */
export function SuggestionsPanel({ edges, titleOf, onClose }: { edges: any[]; titleOf: (id: string) => string | undefined; onClose: () => void }) {
  const { toast } = useApp();
  const byFinding = new Map<number, any[]>();
  for (const e of edges) (byFinding.get(e.finding_id) ?? byFinding.set(e.finding_id, []).get(e.finding_id)!).push(e);
  const act = (p: Promise<unknown>, ok: string) => void p.then(() => toast({ kind: "ok", text: ok })).catch((e) => toast({ kind: "error", text: e.message }));
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className={cn(card, "w-[300px] p-3")} data-testid="suggestions-panel">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink">Suggested connections</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Hide suggestions">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-0.5 text-[11.5px] text-ink-3">Dashed lines are suggestions from Discoveries, not connections. Nothing is linked until you press Connect.</p>
      {byFinding.size ? (
        <ul className="mt-2 max-h-[320px] space-y-2 overflow-y-auto">
          {[...byFinding].map(([fid, es]) => (
            <li key={fid} className="rounded-[9px] border border-line p-2">
              <div className="text-[12px] text-ink">{es[0].title}</div>
              <div className="mt-0.5 text-[11px] text-ink-3">
                {es.map((e) => `${titleOf(e.source_id) ?? "?"} ↔ ${titleOf(e.target_id) ?? "?"}`).join(" · ")} · confidence {Math.round((es[0].confidence ?? 0) * 100)}%
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <Button size="sm" variant="primary" onClick={() => act(rpc("discovery.confirm", { id: fid }), "Connected")}>
                  <Link2 /> Connect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act(rpc("findings.dismiss", { id: fid, note: "Not relevant (from The Mind)" }), "Dismissed")}>
                  Not relevant
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-ink-2">No suggestions right now. Discoveries looks for them after your knowledge changes.</p>
      )}
    </motion.div>
  );
}
