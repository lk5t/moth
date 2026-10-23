import { Archive, ArchiveRestore, Brain, ExternalLink, Link2, Pencil, Pin, PinOff, RotateCcw, ShieldAlert, Trash2, Undo2, X } from "lucide-react";
import { useState } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { openExternal } from "../lib/tauri";
import { CATEGORY_LABEL, MEMORY_TYPE_LABEL, RELATION_LABEL, SOURCE_LABEL, cn, timeAgo } from "../lib/utils";
import { Badge, Button, Dialog, Field, Input, Select, Tabs, Textarea } from "./ui";

export function MemoryPanel() {
  const { selected, select, edit, go, toast } = useApp();
  const [tab, setTab] = useState<"details" | "history" | "versions">("details");
  const [linking, setLinking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: m, error, reload } = useLive<any>("memories.get", { id: selected }, { enabled: !!selected });
  if (!selected) return null;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: ok });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-sidebar" aria-label="Memory details">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "details", label: "Memory" },
            { value: "history", label: "History" },
            { value: "versions", label: `Versions${m ? ` ${m.version}` : ""}` },
          ]}
        />
        <Button variant="ghost" size="iconSm" onClick={() => select(null)} aria-label="Close panel">
          <X />
        </Button>
      </div>
      {error ? <div className="p-5 text-[13px] text-danger">{error}</div> : null}
      {!m ? (
        <div className="space-y-3 p-5">
          <div className="skeleton h-6 w-3/4" />
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-28 w-full" />
        </div>
      ) : (
        <div className="selectable min-h-0 flex-1 overflow-y-auto">
          {tab === "details" ? (
            <div className="space-y-5 p-5">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={m.category === "error" ? "danger" : m.category === "solution" ? "ok" : m.category === "decision" ? "accent" : "neutral"}>{CATEGORY_LABEL[m.category]}</Badge>
                  {m.memory_type ? <Badge title="Memory type">{MEMORY_TYPE_LABEL[m.memory_type] ?? m.memory_type}</Badge> : null}
                  {m.scope === "global" && m.project_id ? null : m.scope ? <Badge title={m.scope === "global" ? "Can be used in any project" : m.scope === "project" ? "Only used for its project" : "Private"}>{m.scope === "global" ? "Reusable" : m.scope === "project" ? "Project only" : "Private"}</Badge> : null}
                  {m.pinned ? (
                    <Badge tone="accent" title="Pinned memories get a little extra retrieval priority">
                      <Pin className="size-3" /> Pinned
                    </Badge>
                  ) : null}
                  {m.evidence === "speculative" ? <Badge tone="warn">Speculation</Badge> : m.evidence === "unsourced" ? <Badge tone="warn">No source</Badge> : m.evidence === "sourced" ? <Badge tone="ok">Sourced</Badge> : null}
                  {m.status !== "active" ? <Badge tone="warn">{m.status === "merged" ? "Merged" : m.status === "superseded" ? "Superseded" : "Archived"}</Badge> : null}
                  {m.task_state ? <Badge tone={m.task_state === "done" ? "ok" : "neutral"}>{m.task_state === "done" ? "Done" : "Open"}</Badge> : null}
                  {m.manual_lock ? <Badge title="You wrote or corrected this; automatic updates can only add to it">Your words</Badge> : null}
                  {m.is_demo ? <Badge tone="warn">Demo</Badge> : null}
                </div>
                <h2 className="text-[17px] leading-snug">{m.title}</h2>
                {m.project ? (
                  <button className="mt-1 text-[12.5px] text-ink-2 hover:text-accent" onClick={() => go("projects", { id: m.project.id })}>
                    {m.project.name}
                  </button>
                ) : null}
              </div>

              {m.flags?.includes("possible_conflict") ? <Notice tone="warn">This may contradict another memory. Both are kept until you decide in the Review Queue.</Notice> : null}
              {m.flags?.includes("possible_prompt_injection") ? (
                <Notice tone="danger">
                  <ShieldAlert className="mr-1 inline size-3.5" />
                  This text contains instruction-like phrases. Claude is told to treat it as data only.
                </Notice>
              ) : null}
              {m.flags?.includes("secrets_redacted") ? <Notice tone="neutral">A password or key was removed from this memory before saving.</Notice> : null}

              {m.summary && m.summary !== m.content ? <p className="text-[13px] leading-relaxed text-ink-2">{m.summary}</p> : null}
              <div className="prose-moth rounded-[10px] border border-line bg-bg px-3.5 py-3 text-[13px]">{renderInline(m.content)}</div>

              {m.tags?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {m.tags.map((t: string) => (
                    <button key={t} onClick={() => go("memories", { tag: t })} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2 hover:text-ink">
                      #{t}
                    </button>
                  ))}
                </div>
              ) : null}

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px]">Connections</h3>
                  <Button size="sm" variant="ghost" onClick={() => setLinking(true)}>
                    <Link2 /> Connect
                  </Button>
                </div>
                {m.relationships.length === 0 ? <p className="text-[12.5px] text-ink-3">Not connected yet. MOTH links memories when it finds a real shared subject.</p> : null}
                <ul className="space-y-1">
                  {m.relationships.map((r: any) => (
                    <li key={r.id} className="group rounded-[8px] px-2 py-1.5 hover:bg-surface">
                      <div className="flex items-center gap-2 text-[12.5px]">
                        <span className="shrink-0 text-ink-3">{r.direction === "out" ? RELATION_LABEL[r.type] : `${RELATION_LABEL[r.type]} ←`}</span>
                        <button className="truncate text-left text-ink hover:text-accent" onClick={() => select(r.other.id)}>
                          {r.other.title ?? r.other.id}
                        </button>
                        <button className="ml-auto hidden shrink-0 text-ink-3 hover:text-danger group-hover:block" aria-label="Remove connection" onClick={() => act(() => rpc("memories.unlink", { id: r.id }), "Connection removed")}>
                          <X className="size-3.5" />
                        </button>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{r.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>

              {m.sources?.length ? (
                <div>
                  <h3 className="mb-2 text-[13px]">Sources</h3>
                  <ul className="space-y-1.5">
                    {m.sources.map((s: any) => (
                      <li key={s.id} className="rounded-[8px] border border-line px-2.5 py-2 text-[12px]">
                        {s.url ? (
                          <button className="flex max-w-full items-center gap-1 truncate text-left text-accent hover:text-accent-soft" onClick={() => void openExternal(s.url)} title={s.url}>
                            <ExternalLink className="size-3 shrink-0" />
                            <span className="truncate">{s.title || s.url}</span>
                          </button>
                        ) : (
                          <span className="text-ink-2">{s.title || "Imported file"}</span>
                        )}
                        <p className="mt-0.5 text-[11.5px] text-ink-3">
                          {[s.publisher, s.published_at ? `published ${s.published_at}` : null, s.retrieved_at ? `retrieved ${s.retrieved_at}` : null].filter(Boolean).join(" · ") || (s.kind === "import" ? "Imported" : "Citation")}
                        </p>
                        {s.excerpt ? <p className="mt-1 text-[11.5px] leading-snug text-ink-2">“{s.excerpt}”</p> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12.5px]">
                <dt className="text-ink-3">Source</dt>
                <dd className="truncate text-ink-2" title={m.source_ref ?? ""}>
                  {SOURCE_LABEL[m.source] ?? m.source}
                  {m.source_ref ? ` · ${m.source_ref}` : ""}
                </dd>
                <dt className="text-ink-3">Created</dt>
                <dd className="text-ink-2">{new Date(m.created_at).toLocaleString()}</dd>
                <dt className="text-ink-3">Updated</dt>
                <dd className="text-ink-2">{timeAgo(m.updated_at)}</dd>
                <dt className="text-ink-3">Importance</dt>
                <dd className="text-ink-2">{Math.round(m.importance * 100)}%</dd>
                <dt className="text-ink-3">Confidence</dt>
                <dd className="text-ink-2">
                  {Math.round(m.confidence * 100)}% · {m.verification.replace("_", " ")}
                </dd>
                <dt className="text-ink-3">Used by Claude</dt>
                <dd className="text-ink-2">{m.access_count} times</dd>
              </dl>
            </div>
          ) : null}

          {tab === "history" ? (
            <ul className="space-y-1 p-4">
              {m.history.length === 0 ? <p className="p-2 text-[12.5px] text-ink-3">No recorded changes.</p> : null}
              {m.history.map((e: any) => (
                <li key={e.id} className="rounded-[8px] px-2.5 py-2 hover:bg-surface">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-[12.5px] leading-snug", e.reverted ? "text-ink-3 line-through" : "text-ink")}>{e.description}</p>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
                        {actorLabel(e.actor)} · {timeAgo(e.created_at)} · {e.reason}
                      </p>
                    </div>
                    {e.undo && !e.reverted ? (
                      <Button size="sm" variant="ghost" title="Undo this change" onClick={() => act(() => rpc("learning.revert", { id: e.id }), "Change reverted")}>
                        <Undo2 />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {tab === "versions" ? (
            <ul className="space-y-2 p-4">
              {m.versions.map((v: any) => (
                <li key={v.id} className="rounded-[10px] border border-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12.5px]">
                      <span className="text-ink">Version {v.version}</span>
                      <span className="text-ink-3"> · {v.change_type.replace(/_/g, " ")} by {actorLabel(v.changed_by)} · {timeAgo(v.created_at)}</span>
                    </div>
                    {v.version !== m.version ? (
                      <Button size="sm" variant="ghost" onClick={() => act(() => rpc("memories.restoreVersion", { id: m.id, version: v.version }), `Restored version ${v.version}`)}>
                        <RotateCcw /> Restore
                      </Button>
                    ) : (
                      <Badge tone="accent">Current</Badge>
                    )}
                  </div>
                  {v.reason ? <p className="mt-1 text-[11.5px] text-ink-3">{v.reason}</p> : null}
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{v.content}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {m ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line p-3">
          <Button size="sm" onClick={() => edit(m.id)}>
            <Pencil /> Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => go("mind", { focus: m.id })}>
            <Brain /> Show in Mind
          </Button>
          <Button size="sm" variant="ghost" title={m.pinned ? "Unpin" : "Pin: give it a little extra priority when relevant"} onClick={() => act(() => rpc("memories.pin", { id: m.id, pinned: !m.pinned }), m.pinned ? "Unpinned" : "Pinned")}>
            {m.pinned ? <PinOff /> : <Pin />} {m.pinned ? "Unpin" : "Pin"}
          </Button>
          {m.status === "active" ? (
            <Button size="sm" variant="ghost" onClick={() => act(() => rpc("memories.archive", { id: m.id }), "Archived. It stays restorable.")}>
              <Archive /> Archive
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => act(() => rpc("memories.restore", { id: m.id }), "Restored")}>
              <ArchiveRestore /> Restore
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto text-ink-3 hover:text-danger" onClick={() => setConfirmDelete(true)} aria-label="Delete permanently">
            <Trash2 />
          </Button>
        </div>
      ) : null}
      {m ? <LinkDialog open={linking} onClose={() => setLinking(false)} from={m} onDone={reload} /> : null}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete permanently?"
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                act(async () => {
                  await rpc("memories.delete", { id: m.id, confirm: true });
                  setConfirmDelete(false);
                  select(null);
                }, "Deleted permanently")
              }
            >
              Delete forever
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">
          "{m?.title}" and its version history will be removed for good. Archiving keeps it restorable instead.
        </p>
      </Dialog>
    </aside>
  );
}

function Notice({ tone, children }: { tone: "warn" | "danger" | "neutral"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-[10px] border px-3 py-2 text-[12.5px] leading-snug",
        tone === "warn" && "border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] text-warn",
        tone === "danger" && "border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] text-danger",
        tone === "neutral" && "border-line text-ink-2",
      )}
    >
      {children}
    </div>
  );
}

export function renderInline(text: string) {
  // Minimal, safe markdown: **bold** and `code`; everything else stays plain text.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded bg-surface-2 px-1 py-px text-[12px] text-accent-soft">
        {p.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export const actorLabel = (a: string) => ({ claude: "Claude", moth: "MOTH", user: "You", system: "System" })[a] ?? a;

function LinkDialog({ open, onClose, from, onDone }: { open: boolean; onClose: () => void; from: any; onDone: () => void }) {
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [target, setTarget] = useState<any | null>(null);
  const [type, setType] = useState("RELATED_TO");
  const [reason, setReason] = useState("");
  const search = async (v: string) => {
    setQ(v);
    if (v.trim().length < 2) return setResults([]);
    setResults((await rpc<any[]>("search", { query: v, limit: 8 })).filter((r) => r.memory.id !== from.id));
  };
  const save = async () => {
    try {
      await rpc("memories.link", { source_id: from.id, target_id: target.id, type, reason });
      toast({ kind: "light", text: `Connected to "${target.title}"` });
      onDone();
      onClose();
      setTarget(null);
      setReason("");
      setQ("");
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect to another memory"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!target || reason.trim().length < 3} onClick={save}>
            Connect
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Find a memory">
          <Input value={q} onChange={(e) => void search(e.target.value)} placeholder="Type a few words" autoFocus />
        </Field>
        {results.length && !target ? (
          <ul className="max-h-48 overflow-y-auto rounded-[10px] border border-line">
            {results.map((r) => (
              <li key={r.memory.id}>
                <button className="w-full px-3 py-2 text-left text-[13px] hover:bg-surface-2" onClick={() => setTarget(r.memory)}>
                  {r.memory.title} <span className="text-ink-3">· {CATEGORY_LABEL[r.memory.category]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {target ? (
          <div className="flex items-center justify-between rounded-[10px] border border-accent/40 px-3 py-2 text-[13px]">
            {target.title}
            <button className="text-ink-3 hover:text-ink" onClick={() => setTarget(null)}>
              Change
            </button>
          </div>
        ) : null}
        <Field label="Relationship">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(RELATION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                "{from.title.slice(0, 30)}" {v} …
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Why are they connected?" hint="Every connection in MOTH has a reason, so the graph stays meaningful.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The UI renders data from this service" />
        </Field>
      </div>
    </Dialog>
  );
}
