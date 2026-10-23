// Review Queue (Memory Inbox): every risky change MOTH or Claude proposed, in one place.
import { useState } from "react";
import { ReviewList, KIND_LABEL } from "../components/ReviewList";
import { PageHeader, Tabs } from "../components/ui";
import { useLive } from "../lib/hooks";
import { cn } from "../lib/utils";

export function InboxPage() {
  const [kind, setKind] = useState<string>("");
  const [view, setView] = useState<"pending" | "deferred" | "decided">("pending");
  const { data: counts } = useLive<any>("inbox.counts", {}, { entities: ["review" as any] });
  const params = view === "pending" ? { status: "pending", kind: kind || undefined } : view === "deferred" ? { status: "pending", include_deferred: true, kind: kind || undefined } : { status: "all", kind: kind || undefined };
  const { data: items, reload } = useLive<any[]>("inbox.list", params, { entities: ["review" as any, "memory"] });
  const shown = (items ?? []).filter((i) => (view === "deferred" ? i.deferred : view === "decided" ? i.status !== "pending" : true));
  const byKind = new Map<string, number>((counts?.by_kind ?? []).map((k: any) => [k.kind, Number(k.n)]));

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Review Queue"
        description="Changes that need your decision: conflicting or replaced facts, possible duplicates, uncertain merges, preferences MOTH inferred, research without sources and unverified lessons. Nothing here is applied until you approve it, and approved changes keep the old version in history."
      />
      <div className="mx-auto max-w-[980px] px-8 pb-10">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { value: "pending", label: `Waiting${counts ? ` ${counts.pending}` : ""}` },
              { value: "deferred", label: `Deferred${counts ? ` ${counts.deferred}` : ""}` },
              { value: "decided", label: "Decided" },
            ]}
          />
          <div className="flex flex-wrap gap-1">
            <Chip on={!kind} onClick={() => setKind("")}>All kinds</Chip>
            {Object.entries(KIND_LABEL).map(([k, v]) =>
              byKind.get(k) || kind === k ? (
                <Chip key={k} on={kind === k} onClick={() => setKind(kind === k ? "" : k)}>
                  {v} {byKind.get(k) ? <span className="text-ink-3">{byKind.get(k)}</span> : null}
                </Chip>
              ) : null,
            )}
          </div>
        </div>
        {view === "decided" ? (
          <ul className="space-y-1.5">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-[10px] border border-line px-3.5 py-2.5 text-[12.5px]">
                <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", r.status === "applied" ? "bg-[color-mix(in_srgb,var(--color-ok)_14%,transparent)] text-ok" : r.status === "rejected" ? "bg-surface-2 text-ink-2" : "bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-danger")}>{r.status}</span>
                <span className="text-ink-3">{KIND_LABEL[r.kind] ?? r.kind}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{r.statement}</span>
                <span className="shrink-0 text-ink-3">{r.decided_at ? new Date(r.decided_at).toLocaleDateString() : ""}</span>
              </li>
            ))}
            {!shown.length ? <p className="text-[12.5px] text-ink-3">No decisions yet.</p> : null}
          </ul>
        ) : (
          <ReviewList items={shown} onDone={reload} empty={view === "deferred" ? "Nothing deferred." : "All clear. Nothing is waiting for your decision."} />
        )}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={cn("flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px]", on ? "border-accent/60 bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-ink" : "border-line text-ink-2 hover:text-ink")}>
      {children}
    </button>
  );
}
