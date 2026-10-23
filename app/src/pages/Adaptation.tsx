// What MOTH Knows About Me: the transparent, correctable personalisation profile.
import { Check, CircleSlash, Clock4, Pencil, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader, Select, SectionTitle, Switch, Textarea } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { AREA_LABEL, SOURCE_LABEL, cn, timeAgo } from "../lib/utils";

const STATUS: Record<string, { label: string; tone: "ok" | "accent" | "neutral" | "warn" }> = {
  confirmed: { label: "Confirmed", tone: "ok" },
  tentative: { label: "Tentative", tone: "accent" },
  outdated: { label: "Outdated", tone: "warn" },
  rejected: { label: "Rejected", tone: "neutral" },
};

export function AdaptationPage() {
  const { toast, select } = useApp();
  const { data: profile, reload } = useLive<any>("adaptation.profile", {}, { entities: ["memory", "review" as any] });
  const { data: projects } = useLive<any[]>("projects.list");
  const { data: settings, reload: reloadSettings } = useLive<any>("settings.get", {}, { entities: ["settings" as any] });
  const [area, setArea] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<any | null>(null);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: ok });
      void reload();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const prefs: any[] = (profile?.preferences ?? []).filter((p: any) => (!area || p.area === area) && (!status || p.status === status));
  const s = settings?.settings;

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="What MOTH knows about me"
        description="How you like to work, as MOTH understands it. Claude gets only the preferences that matter for the task at hand. Things you said are confirmed; things MOTH noticed stay tentative until it has seen them several times and you confirm them. MOTH personalises by storing these notes, not by retraining any AI model."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus /> Add preference
          </Button>
        }
      />
      <div className="mx-auto grid max-w-[1180px] gap-8 px-8 pb-10 xl:grid-cols-[1fr_320px]">
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="tentative">Tentative</option>
              <option value="outdated">Outdated</option>
            </Select>
            <Select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Filter by area">
              <option value="">All areas</option>
              {Object.entries(AREA_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            {profile ? (
              <span className="ml-auto text-[12px] text-ink-3">
                {profile.counts.confirmed} confirmed · {profile.counts.tentative} tentative · {profile.counts.outdated} outdated
              </span>
            ) : null}
          </div>
          {!profile ? (
            <div className="skeleton h-40" />
          ) : !prefs.length ? (
            <Empty title={profile.preferences.length ? "No preferences match these filters" : "Nothing learned about you yet"}>
              {profile.preferences.length ? null : "When you tell Claude how you like things done (\"always test after each feature\"), Claude can save it here. You can also add one yourself."}
            </Empty>
          ) : (
            <ul className="space-y-2">
              {prefs.map((p) => (
                <li key={p.id} className={cn("panel p-4", p.status === "outdated" && "opacity-70")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>
                    <Badge>{AREA_LABEL[p.area] ?? p.area}</Badge>
                    <Badge title="Where it applies">{p.project ? `Only ${p.project.name}` : "All projects"}</Badge>
                    {p.pinned ? (
                      <Badge tone="accent">
                        <Pin className="size-3" /> Pinned
                      </Badge>
                    ) : null}
                    <span className="ml-auto text-[11.5px] text-ink-3">v{p.version}</span>
                  </div>
                  <button className="mt-2 block text-left text-[14px] leading-relaxed text-ink hover:text-accent-soft" onClick={() => select(p.id)}>
                    {p.content}
                  </button>
                  <p className="mt-1 text-[12px] text-ink-3">
                    {p.explicit ? "You said this" : `Inferred from ${p.evidence_count} observation${p.evidence_count === 1 ? "" : "s"}`} · source {SOURCE_LABEL[p.source] ?? p.source} · confidence {Math.round(p.confidence * 100)}% · added {timeAgo(p.created_at)}
                    {p.last_confirmed_at ? ` · last confirmed ${timeAgo(p.last_confirmed_at)}` : ""}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {p.status !== "confirmed" ? (
                      <Button size="sm" variant="primary" onClick={() => act(() => rpc("adaptation.confirm", { id: p.id }), "Confirmed")}>
                        <Check /> Confirm
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => setEditing({ ...p, project: p.project?.name ?? "" })}>
                      <Pencil /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => act(() => rpc("adaptation.edit", { id: p.id, pinned: !p.pinned }), p.pinned ? "Unpinned" : "Pinned")}>
                      {p.pinned ? <PinOff /> : <Pin />} {p.pinned ? "Unpin" : "Pin"}
                    </Button>
                    {p.status !== "outdated" ? (
                      <Button size="sm" variant="ghost" onClick={() => act(() => rpc("adaptation.outdated", { id: p.id }), "Marked outdated; Claude won't get it anymore")}>
                        <Clock4 /> Outdated
                      </Button>
                    ) : null}
                    {!p.explicit ? (
                      <Button size="sm" variant="ghost" onClick={() => act(() => rpc("adaptation.reject", { id: p.id }), "Rejected. MOTH won't use it.")}>
                        <CircleSlash /> Not me
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" className="ml-auto text-ink-3 hover:text-danger" aria-label="Delete" onClick={() => setDeleting(p)}>
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-6">
          <div className="panel p-4">
            <h2 className="text-[14px]">How personalisation works</h2>
            <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-2">
              <li>One remark is never a rule: inferred preferences need {s?.["adaptation.inferAfter"] ?? 3} observations, then MOTH asks you in the Review Queue.</li>
              <li>Project preferences stay in their project. Global ones apply everywhere.</li>
              <li>Claude receives at most {s?.["adaptation.maxInContext"] ?? 6} relevant preferences per task, with where each came from.</li>
            </ul>
          </div>
          {s ? (
            <div className="panel space-y-3 p-4">
              <div className="flex items-center justify-between gap-3 text-[13px]">
                Use preferences in Claude's context
                <Switch checked={s["adaptation.enabled"]} onChange={(v) => void rpc("settings.set", { key: "adaptation.enabled", value: v }).then(reloadSettings)} label="Use preferences" />
              </div>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                Suggest knowledge from other projects
                <Switch checked={s["transfer.enabled"]} onChange={(v) => void rpc("settings.set", { key: "transfer.enabled", value: v }).then(reloadSettings)} label="Knowledge transfer" />
              </div>
            </div>
          ) : null}
          <div>
            <SectionTitle>Lessons learned</SectionTitle>
            <ul className="space-y-1">
              {(profile?.lessons ?? []).slice(0, 12).map((l: any) => (
                <li key={l.id}>
                  <button className="w-full rounded-[8px] px-2 py-1.5 text-left hover:bg-surface" onClick={() => select(l.id)}>
                    <span className="block truncate text-[12.5px] text-ink">{l.title}</span>
                    <span className="text-[11.5px] text-ink-3">{l.scope === "global" ? "Reusable" : "One project"} · {l.verified ? "verified" : "unverified"}</span>
                  </button>
                </li>
              ))}
              {profile && !profile.lessons.length ? <li className="px-2 text-[12px] text-ink-3">No lessons yet. Claude records them after a verified fix.</li> : null}
            </ul>
          </div>
        </aside>
      </div>

      <PrefDialog
        open={adding || !!editing}
        initial={editing}
        projects={projects ?? []}
        onClose={() => (setAdding(false), setEditing(null))}
        onSave={async (v) => {
          if (editing) await act(() => rpc("adaptation.edit", { id: editing.id, content: v.content !== editing.content ? v.content : undefined, area: v.area || undefined, scope: v.project ? "project" : "global", project: v.project || undefined }), "Saved");
          else await act(() => rpc("adaptation.add", { content: v.content, area: v.area || undefined, project: v.project || undefined }), "Added as a confirmed preference");
          setAdding(false);
          setEditing(null);
        }}
      />
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this preference?"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => act(() => rpc("adaptation.delete", { id: deleting.id, confirm: true }), "Deleted").then(() => setDeleting(null))}>
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">"{deleting?.content}" and its history will be removed. "Outdated" or "Not me" keep a record instead.</p>
      </Dialog>
    </div>
  );
}

function PrefDialog({ open, initial, projects, onClose, onSave }: { open: boolean; initial: any | null; projects: any[]; onClose: () => void; onSave: (v: { content: string; area: string; project: string }) => Promise<void> }) {
  const [content, setContent] = useState("");
  const [area, setArea] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const key = initial?.id ?? (open ? "new" : "");
  const [seen, setSeen] = useState("");
  if (open && seen !== key) {
    setSeen(key);
    setContent(initial?.content ?? "");
    setArea(initial?.area ?? "");
    setProject(initial?.project ?? "");
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "Edit preference" : "Add a preference"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            <X /> Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={content.trim().length < 4} onClick={async () => (setBusy(true), await onSave({ content, area, project }).finally(() => setBusy(false)))}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Preference" hint="One sentence, e.g. “Keep Roblox scripts modular: one ModuleScript per system.”">
          <Textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Area">
            <Select value={area} onChange={(e) => setArea(e.target.value)}>
              {!initial ? <option value="">Let MOTH decide</option> : null}
              {Object.entries(AREA_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Applies to">
            <Select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.name}>
                  Only {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {!initial ? <Input type="hidden" /> : null}
      </div>
    </Dialog>
  );
}
