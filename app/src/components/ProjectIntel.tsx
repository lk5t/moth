// Project Intelligence 2.0 + Session Continuity UI: Resume Project, project items (objectives, unresolved
// decisions, blockers, milestones), evidence-based progress and session handoffs. Every line links to its record.
import { ArrowRight, Check, CircleSlash, Flag, History, ListChecks, Milestone, Pencil, Plus, RotateCcw, Save, ShieldAlert, Sparkles, Target } from "lucide-react";
import { useState, type ReactNode } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";
import { Badge, Button, Dialog, Field, Input, Textarea } from "./ui";

const KIND_LABEL: Record<string, string> = { objective: "Objective", unresolved_decision: "Unresolved decision", blocker: "Blocker", milestone: "Milestone" };
const UNRESOLVED_LABEL: Record<string, string> = { blocker: "Blocker", unresolved_decision: "Decision", open_task: "Open task", handoff_unresolved: "From handoff" };

/** Opens whatever a reference points to: memory → side panel, handoff → dialog. */
function useOpenRef(onHandoff: (id: string) => void) {
  const { select } = useApp();
  return (ref: any) => {
    if (!ref) return;
    if (ref.type === "memory") select(ref.id);
    else if (ref.type === "handoff") onHandoff(ref.id);
    else if (ref.type === "item") document.getElementById(`pitem-${ref.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
}

function RefChip({ r, onOpen }: { r: any; onOpen: (r: any) => void }) {
  if (!r) return null;
  const label = r.type === "memory" ? "memory" : r.type === "handoff" ? "handoff" : r.type === "item" ? "project item" : r.type;
  return (
    <button onClick={() => onOpen(r)} className="ml-1.5 shrink-0 rounded-full border border-line px-1.5 text-[10.5px] text-ink-3 hover:border-accent/50 hover:text-accent-soft" title={`Source: ${label}${r.at ? `, ${new Date(r.at).toLocaleString()}` : ""}`}>
      {label}
    </button>
  );
}

export function ProgressLine({ progress }: { progress: any }) {
  if (!progress) return null;
  if (progress.status !== "confirmed") return <p className="text-[12px] text-ink-3">Progress: unknown. {progress.note}</p>;
  return (
    <div>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
        <span>
          {progress.done} of {progress.total} {progress.basis === "milestones" ? "milestones" : "tasks"} done
        </span>
        <Badge tone="ok">confirmed</Badge>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent/70 transition-[width] duration-500" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="mt-1 text-[11.5px] text-ink-3">{progress.note}</p>
    </div>
  );
}

export function ResumePanel({ projectId, onOpenHandoff }: { projectId: string; onOpenHandoff: (id: string) => void }) {
  const { data, error } = useLive<any>("projects.resume", { project: projectId }, { entities: ["memory", "project_item", "handoff", "project"] });
  const open = useOpenRef(onOpenHandoff);
  const [expanded, setExpanded] = useState(false);
  if (error) return <section className="panel p-4 text-[12.5px] text-danger xl:col-span-3">{error}</section>;
  if (!data) return <section className="panel p-4 xl:col-span-3"><div className="skeleton h-5 w-56" /></section>;
  const Line = ({ text, r, kind, why }: { text: string; r: any; kind?: string; why?: string }) => (
    <li className="flex items-start gap-1.5 py-0.5 text-[12.5px] text-ink-2">
      {kind ? <span className="mt-[1px] shrink-0 text-[10.5px] uppercase tracking-wide text-ink-3">{kind}</span> : <span className="mt-[7px] size-1 shrink-0 rounded-full bg-node" />}
      <span className="min-w-0 flex-1">
        <span className="text-ink">{text}</span>
        {why ? <span className="block text-[11.5px] text-ink-3">{why}</span> : null}
      </span>
      <RefChip r={r} onOpen={open} />
    </li>
  );
  const Section = ({ title, children, n }: { title: string; children: ReactNode; n: number }) => (
    <div>
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">
        {title} <span className="text-ink-3/70">{n}</span>
      </h3>
      {n ? <ul>{children}</ul> : <p className="text-[12px] text-ink-3">Nothing recorded.</p>}
    </div>
  );
  return (
    <section className="panel moth-pop relative overflow-hidden border-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] p-4 xl:col-span-3" aria-label="Resume project">
      <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.12),transparent_65%)]" />
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-accent-soft" />
        <h2 className="text-[13.5px] text-ink">Resume this project</h2>
        <span className="text-[11.5px] text-ink-3">Built only from saved records{data.latest_handoff ? ` · latest handoff ${timeAgo(data.latest_handoff.updated_at)}` : ""}</span>
        <button className="ml-auto text-[12px] text-accent hover:text-accent-soft" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Less" : "Full briefing"}
        </button>
      </div>
      <div className="mt-3 rounded-[10px] border border-line bg-surface/60 p-3">
        {data.next_step ? (
          <div className="flex items-start gap-2">
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-accent-soft" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] text-ink">{data.next_step.text}</p>
              <p className="text-[12px] text-ink-3">{data.next_step.why}</p>
            </div>
            <RefChip r={data.next_step.ref} onOpen={open} />
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-3">{data.next_step_note}</p>
        )}
      </div>
      {data.latest_handoff ? (
        <p className="mt-2 text-[12.5px] text-ink-2">
          <span className="text-ink-3">Last session: </span>
          {data.latest_handoff.summary}
          <RefChip r={{ type: "handoff", id: data.latest_handoff.id, at: data.latest_handoff.updated_at }} onOpen={open} />
        </p>
      ) : null}
      {expanded ? (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Section title="Last completed" n={data.last_completed.length}>
            {data.last_completed.map((x: any, i: number) => <Line key={i} text={x.text} r={x.ref} />)}
          </Section>
          <Section title="Decisions" n={data.decisions.length}>
            {data.decisions.map((x: any, i: number) => <Line key={i} text={x.text} r={x.ref} />)}
          </Section>
          <Section title="Unresolved" n={data.unresolved.length}>
            {data.unresolved.map((x: any, i: number) => <Line key={i} text={x.text} r={x.ref} kind={UNRESOLVED_LABEL[x.kind] ?? x.kind} />)}
          </Section>
          <Section title="Stored knowledge that may help" n={data.helpful_research.length}>
            {data.helpful_research.map((x: any) => <Line key={x.memory.id} text={x.memory.title} r={{ type: "memory", id: x.memory.id }} why={x.why} />)}
          </Section>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-ink-3">
          {data.unresolved.length} unresolved · {data.decisions.length} decisions · {data.helpful_research.length} stored notes that may help
        </p>
      )}
    </section>
  );
}

const KIND_ICON: Record<string, ReactNode> = {
  unresolved_decision: <Flag className="size-3.5" />,
  blocker: <ShieldAlert className="size-3.5" />,
  objective: <Target className="size-3.5" />,
  milestone: <Milestone className="size-3.5" />,
};

export function ProjectItemsCard({ projectId, className }: { projectId: string; className?: string }) {
  const { toast } = useApp();
  const { data, reload } = useLive<any[]>("projects.items", { project: projectId, status: "all" }, { entities: ["project_item", "memory"] });
  const [kind, setKind] = useState<string>("unresolved_decision");
  const [title, setTitle] = useState("");
  const [resolving, setResolving] = useState<any>(null);
  const [resolution, setResolution] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const items = data ?? [];
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: ok });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");
  const order = ["blocker", "unresolved_decision", "objective", "milestone"];
  return (
    <section className={cn("panel p-4", className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <ListChecks className="size-4 text-ink-3" />
        <h2 className="text-[13.5px] text-ink">Open questions, blockers and goals</h2>
        <span className="ml-auto text-[11.5px] text-ink-3">{open.length} open</span>
      </div>
      <form
        className="mb-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim().length < 2) return;
          void act(() => rpc("projects.items.add", { project: projectId, kind, title }), `${KIND_LABEL[kind]} added`).then(() => setTitle(""));
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 rounded-[8px] border border-line bg-surface px-2 text-[12.5px] text-ink" aria-label="Kind">
          {order.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "unresolved_decision" ? "A question that isn't decided yet" : kind === "blocker" ? "What is stopping progress?" : kind === "objective" ? "What should this project achieve?" : "A milestone"} className="h-8 min-w-[220px] flex-1 text-[12.5px]" aria-label="Title" />
        <Button size="sm" type="submit" disabled={title.trim().length < 2}>
          <Plus /> Add
        </Button>
      </form>
      {open.length ? (
        <ul className="space-y-1">
          {[...open].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).map((it) => (
            <li key={it.id} id={`pitem-${it.id}`} className="group flex items-start gap-2 rounded-[8px] px-2 py-1.5 hover:bg-surface-2">
              <span className={cn("mt-0.5 shrink-0", it.kind === "blocker" ? "text-warn" : it.kind === "unresolved_decision" ? "text-accent-soft" : "text-ink-3")}>{KIND_ICON[it.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">{it.title}</span>
                <span className="text-[11px] text-ink-3">
                  {KIND_LABEL[it.kind]} · added {timeAgo(it.created_at)} by {it.created_by === "user" ? "you" : it.created_by}
                </span>
              </span>
              <span className="flex shrink-0 gap-1 opacity-70 group-hover:opacity-100">
                <Button size="sm" variant="ghost" onClick={() => (setResolving(it), setResolution(""))} title={it.kind === "unresolved_decision" ? "Record the decision" : "Mark as resolved / done"}>
                  <Check /> {it.kind === "unresolved_decision" ? "Decide" : it.kind === "blocker" ? "Resolved" : "Done"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void act(() => rpc("projects.items.resolve", { id: it.id, status: "dropped" }), "Dropped")} title="No longer relevant">
                  <CircleSlash />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-[12.5px] text-ink-3">Nothing open. Add a blocker or an undecided question so MOTH can keep track of it.</p>
      )}
      {closed.length ? (
        <div className="mt-3">
          <button className="text-[12px] text-ink-3 hover:text-ink" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? "Hide" : "Show"} {closed.length} closed
          </button>
          {showClosed ? (
            <ul className="mt-1 space-y-0.5">
              {closed.map((it) => (
                <li key={it.id} id={`pitem-${it.id}`} className="flex items-start gap-2 px-2 py-1 text-[12.5px]">
                  <span className="mt-0.5 shrink-0 text-ink-3">{KIND_ICON[it.kind]}</span>
                  <span className="min-w-0 flex-1 text-ink-2">
                    <span className="line-through decoration-ink-3/50">{it.title}</span>
                    <span className="block text-[11px] text-ink-3">
                      {it.status} {timeAgo(it.resolved_at)}
                      {it.resolution ? ` · ${it.resolution}` : ""}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void act(() => rpc("projects.items.reopen", { id: it.id }), "Reopened")} title="Reopen">
                    <RotateCcw />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={!!resolving}
        onClose={() => setResolving(null)}
        title={resolving?.kind === "unresolved_decision" ? "Record the decision" : "Resolve"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResolving(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={resolving?.kind === "unresolved_decision" && resolution.trim().length < 2}
              onClick={() => void act(() => rpc("projects.items.resolve", { id: resolving.id, resolution }), resolving.kind === "unresolved_decision" ? "Decision recorded" : "Marked as resolved").then(() => setResolving(null))}
            >
              <Check /> Save
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink">{resolving?.title}</p>
        <Field label={resolving?.kind === "unresolved_decision" ? "What was decided?" : "How was it resolved? (optional)"} className="mt-3">
          <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus />
        </Field>
        {resolving?.kind === "unresolved_decision" ? <p className="mt-2 text-[11.5px] text-ink-3">The decision is also saved as a decision memory in this project.</p> : null}
      </Dialog>
    </section>
  );
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter((x) => x.length > 1);

export function HandoffDialog({ open, onClose, projectId, handoffId }: { open: boolean; onClose: () => void; projectId?: string | null; handoffId?: string | null }) {
  const { toast } = useApp();
  const { data } = useLive<any>("handoffs.get", { id: handoffId }, { enabled: !!handoffId && open, entities: ["handoff"] });
  const [edit, setEdit] = useState(!handoffId);
  const [form, setForm] = useState<{ summary: string; completed: string; decisions: string; unresolved: string; next_steps: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = { summary: data?.summary ?? "", completed: (data?.completed ?? []).join("\n"), decisions: (data?.decisions ?? []).join("\n"), unresolved: (data?.unresolved ?? []).join("\n"), next_steps: (data?.next_steps ?? []).join("\n") };
  // Editing an existing handoff waits for it to load; a new one starts empty.
  const current = form ?? (handoffId && !data ? null : base);
  const set = (k: string, v: string) => setForm({ ...(current as any), [k]: v });
  const save = async () => {
    if (!current || current.summary.trim().length < 3) return;
    setBusy(true);
    try {
      const body = { summary: current.summary, completed: lines(current.completed), decisions: lines(current.decisions), unresolved: lines(current.unresolved), next_steps: lines(current.next_steps) };
      if (handoffId) await rpc("handoffs.edit", { id: handoffId, patch: body });
      else await rpc("handoffs.save", { ...body, project: projectId ?? null });
      toast({ kind: "ok", text: handoffId ? "Handoff updated (previous version kept)" : "Handoff saved" });
      setForm(null);
      onClose();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const viewing = handoffId && !edit && data;
  return (
    <Dialog
      open={open}
      onClose={() => (setForm(null), setEdit(!handoffId), onClose())}
      title={handoffId ? "Session handoff" : "Save a session handoff"}
      width={600}
      footer={
        viewing ? (
          <Button onClick={() => setEdit(true)}>
            <Pencil /> Edit
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => (setForm(null), onClose())}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!current || current.summary.trim().length < 3} onClick={() => void save()}>
              <Save /> Save
            </Button>
          </>
        )
      }
    >
      {viewing ? (
        <div className="grid gap-3 text-[13px]">
          <p className="text-ink">{data.summary}</p>
          <p className="text-[11.5px] text-ink-3">
            From {data.client === "manual" ? "you" : data.client} · {data.source === "hook" ? "written automatically by MOTH's local AI from the session" : data.source === "mcp" ? "sent by the AI client" : "written by hand"} · version {data.version} · {new Date(data.updated_at).toLocaleString()}
          </p>
          {(["completed", "decisions", "unresolved", "next_steps"] as const).map((k) =>
            data[k]?.length ? (
              <div key={k}>
                <h4 className="text-[11px] uppercase tracking-[0.08em] text-ink-3">{k === "next_steps" ? "Next steps" : k[0].toUpperCase() + k.slice(1)}</h4>
                <ul className="mt-1 list-disc pl-5 text-ink-2">
                  {data[k].map((x: string, i: number) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {data.versions?.length ? (
            <p className="flex items-center gap-1 text-[11.5px] text-ink-3">
              <History className="size-3.5" /> {data.versions.length} earlier version{data.versions.length === 1 ? "" : "s"} kept
            </p>
          ) : null}
        </div>
      ) : current ? (
        <div className="grid gap-3">
          <Field label="Summary" hint="What this session was about and where it ended.">
            <Textarea rows={3} value={current.summary} onChange={(e) => set("summary", e.target.value)} autoFocus />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            {(["completed", "decisions", "unresolved", "next_steps"] as const).map((k) => (
              <Field key={k} label={k === "next_steps" ? "Next steps" : k[0].toUpperCase() + k.slice(1)} hint="One per line">
                <Textarea rows={4} value={(current as any)[k]} onChange={(e) => set(k, e.target.value)} />
              </Field>
            ))}
          </div>
        </div>
      ) : (
        <div className="skeleton h-24" />
      )}
    </Dialog>
  );
}

export function HandoffsCard({ projectId, className }: { projectId: string; className?: string }) {
  const { data } = useLive<any[]>("handoffs.list", { project: projectId, limit: 10 }, { entities: ["handoff"] });
  const [open, setOpen] = useState<{ id: string | null } | null>(null);
  return (
    <section className={cn("panel p-4", className)}>
      <div className="mb-2.5 flex items-center gap-2">
        <History className="size-4 text-ink-3" />
        <h2 className="text-[13.5px] text-ink">Session handoffs</h2>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen({ id: null })}>
          <Plus /> Save handoff
        </Button>
      </div>
      {(data ?? []).length ? (
        <ul className="space-y-1">
          {data!.map((h) => (
            <li key={h.id}>
              <button className="w-full rounded-[8px] px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => setOpen({ id: h.id })}>
                <span className="line-clamp-2 block text-[12.5px] text-ink">{h.summary}</span>
                <span className="text-[11px] text-ink-3">
                  {h.client === "manual" ? "You" : h.client} · {timeAgo(h.updated_at)}
                  {h.version > 1 ? ` · v${h.version}` : ""}
                  {h.next_steps?.length ? ` · ${h.next_steps.length} next step${h.next_steps.length === 1 ? "" : "s"}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-[12.5px] text-ink-3">No handoffs yet. Claude can save one with moth_save_handoff, Claude Code can write one when a session ends (Settings → Connections), or save one by hand.</p>
      )}
      {open ? <HandoffDialog open onClose={() => setOpen(null)} projectId={projectId} handoffId={open.id} /> : null}
    </section>
  );
}
