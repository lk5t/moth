// The unified Memory Inbox list: conflicts, duplicates, uncertain merges, inferred preferences, research without
// sources, unverified lessons and other risky changes. Approve / Edit / Reject / Defer.
import { Check, Clock, ExternalLink, Pencil, X } from "lucide-react";
import { useState } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { openExternal } from "../lib/tauri";
import { timeAgo } from "../lib/utils";
import { Badge, Button, Dialog, Field, Select, Textarea } from "./ui";

export const KIND_LABEL: Record<string, string> = {
  cortex: "Cortex proposal",
  conflict: "Possible conflict",
  duplicate: "Possible duplicate",
  merge: "Uncertain merge",
  preference: "Inferred preference",
  research: "Research without sources",
  lesson: "Unverified lesson",
  correction: "Suggested correction",
  other: "Other change",
};

const OP_LABEL: Record<string, string> = {
  create: "Add as a new memory",
  append: "Add this to an existing memory",
  update: "Replace an existing fact",
  link: "Connect to an existing memory",
  flag_contradiction: "Resolve a contradiction",
  review: "Decide what to do",
  mark_duplicate: "Already known",
  none: "Already known",
  merge: "Merge into the existing memory",
  supersede: "Replace the older memory",
  confirm_preference: "Confirm this preference",
  store_unsourced_research: "Keep as unsourced research",
  store_lesson: "Save as a lesson",
};

export function ReviewList({ items, onDone, empty }: { items: any[]; onDone: () => void; empty?: string }) {
  const { toast, select } = useApp();
  const [editing, setEditing] = useState<any | null>(null);
  const [text, setText] = useState("");
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [verdict, setVerdict] = useState("incorrect");
  const [note, setNote] = useState("");
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "light", text: ok });
      onDone();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  if (!items.length) return <p className="text-[12.5px] text-ink-3">{empty ?? "Nothing to review."}</p>;
  return (
    <>
      <ul className="space-y-3">
        {items.map((r) => {
          const editable = ["update", "flag_contradiction", "append", "create", "review", "confirm_preference", "store_unsourced_research", "store_lesson"].includes(r.operation);
          const others = (r.affected ?? []).filter((m: any) => m.id !== r.target?.id);
          return (
            <li key={r.id} className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                <span className="text-[13.5px] text-ink">{OP_LABEL[r.operation] ?? r.operation.replace(/_/g, " ")}</span>
                <Badge tone={r.risk === "high" ? "danger" : r.risk === "medium" ? "warn" : "neutral"}>{r.risk} risk</Badge>
                {r.confidence != null ? <span className="text-[12px] text-ink-3">confidence {Math.round(r.confidence * 100)}%</span> : null}
                {r.deferred ? <Badge>Deferred until {new Date(r.deferred_until).toLocaleString()}</Badge> : null}
                <span className="ml-auto text-[12px] text-ink-3">
                  {r.source ? `${r.source} · ` : ""}
                  {timeAgo(r.created_at)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">"{r.statement}"</p>
              {r.target ? (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <div className="rounded-[10px] border border-line px-3 py-2">
                    <div className="text-[11.5px] text-ink-3">Now</div>
                    <button className="text-left text-[12.5px] leading-relaxed text-ink-2 hover:text-ink" onClick={() => select(r.target.id)}>
                      <span className="text-ink">{r.target.title}</span>: {r.target.content}
                    </button>
                  </div>
                  {r.proposal?.content && ["update", "flag_contradiction", "append"].includes(r.operation) ? (
                    <div className="rounded-[10px] border border-accent/40 px-3 py-2">
                      <div className="text-[11.5px] text-accent-soft">{r.operation === "append" ? "Would add" : "Would become"}</div>
                      <p className="text-[12.5px] leading-relaxed text-ink">{r.proposal.content}</p>
                    </div>
                  ) : others.length ? (
                    <div className="rounded-[10px] border border-accent/40 px-3 py-2">
                      <div className="text-[11.5px] text-accent-soft">{r.operation === "merge" ? "Would be merged in" : r.operation === "supersede" ? "Newer memory" : "Also affected"}</div>
                      {others.map((m: any) => (
                        <button key={m.id} className="block text-left text-[12.5px] leading-relaxed text-ink-2 hover:text-ink" onClick={() => select(m.id)}>
                          <span className="text-ink">{m.title}</span>: {m.content}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {r.proposal?.values_differ && r.proposal?.existing_value ? (
                <p className="mt-2 text-[12.5px] text-ink-2">
                  Compared <span className="text-ink">"{r.proposal.existing_value}"</span> with <span className="text-ink">"{r.proposal.new_value}"</span>
                  {r.proposal.signals_change ? " and read it as a change." : " but nothing says which is current."}
                </p>
              ) : null}
              {r.sources?.length ? (
                <ul className="mt-2 space-y-0.5">
                  {r.sources.map((s: any, i: number) => (
                    <li key={i}>
                      {s.url ? (
                        <button className="flex items-center gap-1 text-[12px] text-accent hover:text-accent-soft" onClick={() => void openExternal(s.url)}>
                          <ExternalLink className="size-3" /> {s.title || s.url}
                        </button>
                      ) : (
                        <span className="text-[12px] text-ink-2">{s.title}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-[12px] text-ink-3">
                Why it waits: {r.reason}
                {r.proposal?.reason ? ` Model's reason: ${r.proposal.reason}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => run(() => rpc("inbox.approve", { id: r.id }), "Approved. Earlier versions stay in history.")}>
                  <Check /> Approve
                </Button>
                {editable ? (
                  <Button size="sm" onClick={() => (setEditing(r), setText(r.operation === "review" && r.target ? r.target.content : r.proposal?.content || r.statement))}>
                    <Pencil /> Edit and approve
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => (setRejecting(r), setNote(""), setVerdict("incorrect"))}>
                  <X /> Reject
                </Button>
                {!r.deferred ? (
                  <Button size="sm" variant="ghost" title="Hide it for a day" onClick={() => run(() => rpc("inbox.defer", { id: r.id, hours: 24 }), "Deferred until tomorrow")}>
                    <Clock /> Defer
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit before approving"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => run(() => rpc("inbox.approve", { id: editing.id, content: text }), "Saved your version").then(() => setEditing(null))}>
              Approve
            </Button>
          </>
        }
      >
        <Field label="Text to save">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </Dialog>
      <Dialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Reject this proposal"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => run(() => rpc("inbox.reject", { id: rejecting.id, note, verdict }), "Rejected. Nothing was changed, and MOTH will remember this next time.").then(() => setRejecting(null))}>
              Reject
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label="What was wrong?">
            <Select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
              <option value="incorrect">The change is wrong</option>
              <option value="irrelevant">Not worth remembering</option>
              <option value="keep_separate">These should stay separate memories</option>
            </Select>
          </Field>
          <Field label="Note for MOTH (optional)" hint="Shown to the model as an example when a similar decision comes up.">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
