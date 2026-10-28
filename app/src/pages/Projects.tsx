import { ArrowLeft, Brain, Check, FolderKanban, FolderPlus, Lightbulb, Lock, Pencil, ThumbsUp, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader, Switch, Textarea } from "../components/ui";
import { GraphCanvas } from "../graph/GraphCanvas";
import { ReviewList } from "../components/ReviewList";
import { HandoffDialog, HandoffsCard, ProgressLine, ProjectItemsCard, ResumePanel } from "../components/ProjectIntel";
import { renderInline } from "../components/MemoryPanel";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { AREA_LABEL, MEMORY_TYPE_LABEL, cn, plural, timeAgo } from "../lib/utils";

const MINI_GRAPH = { centerForce: 0.14, repelForce: 110, linkForce: 0.4, linkDistance: 32, nodeSize: 0.9, linkThickness: 1, textFadeThreshold: 2.4, showLabels: true, animate: true, colorBy: "none" as const, showArrows: false };

export function ProjectsPage() {
  const { params, go } = useApp();
  const [creating, setCreating] = useState(false);
  if (params.id) return <ProjectDashboard id={params.id} onBack={() => go("projects")} />;
  return <ProjectList onOpen={(id) => go("projects", { id })} creating={creating} setCreating={setCreating} />;
}

function ProjectList({ onOpen, creating, setCreating }: { onOpen: (id: string) => void; creating: boolean; setCreating: (v: boolean) => void }) {
  const { data, loading } = useLive<any[]>("projects.list", {}, { entities: ["project", "memory"] });
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Projects"
        description="Each project is a cluster of connected memories. MOTH keeps their state, decisions, problems and open work current as Claude reports progress."
        actions={
          <Button onClick={() => setCreating(true)}>
            <FolderPlus /> New project
          </Button>
        }
      />
      <div className="grid gap-3 px-8 pb-8 md:grid-cols-2 xl:grid-cols-3">
        {(data ?? []).map((p) => (
          <button key={p.id} onClick={() => onOpen(p.id)} className="panel flex flex-col p-4 text-left transition-colors hover:border-line-strong">
            <span className="flex items-center gap-2 text-[15px] text-ink">
              {p.name}
              {p.private ? <Lock className="size-3.5 text-ink-3" aria-label="Private project" /> : null}
            </span>
            <span className="mt-1 line-clamp-2 min-h-[38px] text-[12.5px] leading-snug text-ink-2">{p.status || p.description || "No status yet."}</span>
            <span className="mt-4 flex gap-4 text-[12px] text-ink-3">
              <span>{plural(p.memory_count, "memory", "memories")}</span>
              <span>{plural(p.open_tasks, "open task")}</span>
              <span className="ml-auto">{timeAgo(p.last_activity_at)}</span>
            </span>
          </button>
        ))}
      </div>
      {!loading && data && !data.length ? (
        <Empty icon={<FolderKanban />} title="No projects yet" action={<Button onClick={() => setCreating(true)}>Create a project</Button>}>
          When Claude commits learning for a named project, MOTH creates it here. You can also add one yourself.
        </Empty>
      ) : null}
      <ProjectDialog open={creating} onClose={() => setCreating(false)} onSaved={onOpen} />
    </div>
  );
}

function ProjectDialog({ open, onClose, onSaved, project }: { open: boolean; onClose: () => void; onSaved?: (id: string) => void; project?: any }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: project?.name ?? "", description: project?.description ?? "", goals: project?.goals ?? "", status: project?.status ?? "", aliases: (project?.aliases ?? []).join(", ") });
  const save = async () => {
    try {
      const aliases = f.aliases.split(",").map((a: string) => a.trim()).filter(Boolean);
      const r = project
        ? await rpc<any>("projects.update", { id: project.id, patch: { name: f.name, description: f.description, goals: f.goals, status: f.status, aliases } })
        : await rpc<any>("projects.create", { ...f, aliases });
      toast({ kind: "ok", text: project ? "Project updated" : `Created "${r.name}"` });
      onClose();
      onSaved?.(r.id);
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? "Edit project" : "New project"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!f.name.trim()} onClick={save}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ironbound Arena" autoFocus />
        </Field>
        <Field label="Other names" hint="Comma separated. Helps MOTH recognise the project when you say 'my fighting game'.">
          <Input value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} placeholder="fighting game, ironbound" />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Goals">
          <Textarea rows={2} value={f.goals} onChange={(e) => setF({ ...f, goals: e.target.value })} />
        </Field>
        <Field label="Current state">
          <Input value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function ProjectDashboard({ id, onBack }: { id: string; onBack: () => void }) {
  const { select, go, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const { data, error, reload } = useLive<any>("projects.get", { id });
  const { data: graph } = useLive<any>("graph.get", { projectIds: [id] }, { entities: ["memory", "relationship"] });
  const { data: prefs } = useLive<any[]>("adaptation.preferences", { project_id: id }, { entities: ["memory"] });
  const { data: research } = useLive<any>("memories.list", { project_id: id, memory_type: "research", status: "active", limit: 12 }, { entities: ["memory"] });
  const { data: reviews, reload: reloadReviews } = useLive<any[]>("inbox.list", {}, { entities: ["review" as any] });
  const [suggestions, setSuggestions] = useState<any[] | null>(null);
  const { data: pstate } = useLive<any>("projects.state", { project: id }, { entities: ["memory", "project_item", "handoff", "project"] });
  const [handoff, setHandoff] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const loadTransfer = async (refresh: boolean) => {
    try {
      setSuggestions(await rpc<any[]>("transfer.list", { project_id: id, refresh }));
    } catch {
      setSuggestions([]);
    }
  };
  useEffect(() => void loadTransfer(true), [id]);
  const projectReviews = useMemo(() => (reviews ?? []).filter((r) => r.target?.project_id === id || (r.affected ?? []).some((m: any) => data?.recent?.some((x: any) => x.id === m.id))), [reviews, id, data]);
  const setFlag = async (patch: Record<string, boolean>, ok: string) => {
    try {
      await rpc("projects.update", { id, patch });
      toast({ kind: "ok", text: ok });
      void reload();
      void loadTransfer(true);
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const decide = async (sid: number, decision: "accepted" | "dismissed") => {
    await rpc("transfer.decide", { id: sid, decision });
    void loadTransfer(false);
    toast({ kind: "ok", text: decision === "accepted" ? "Marked useful and connected to this project" : "Dismissed. It won't be suggested here again." });
  };
  if (error) return <Empty title="Project not found">{error}</Empty>;
  if (!data) return <div className="p-8"><div className="skeleton h-8 w-72" /></div>;
  const p = data.project;
  const MemList = ({ items, empty }: { items: any[]; empty: string }) =>
    items.length ? (
      <ul className="space-y-0.5">
        {items.map((m) => (
          <li key={m.id}>
            <button onClick={() => select(m.id)} className="flex w-full items-start gap-2 rounded-[7px] px-2 py-1.5 text-left hover:bg-surface-2">
              {m.task_state === "done" ? <Check className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-node" />}
              <span className="min-w-0">
                <span className={cn("block text-[13px] leading-snug", m.task_state === "done" ? "text-ink-2" : "text-ink")}>{m.title}</span>
                {m.summary && m.summary !== m.title ? <span className="line-clamp-1 block text-[12px] text-ink-3">{m.summary}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="px-2 text-[12.5px] text-ink-3">{empty}</p>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 pt-6">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Projects
        </button>
      </div>
      <PageHeader
        title={p.name}
        description={p.description}
        actions={
          <>
            <Button variant="ghost" onClick={() => go("memories", { project: p.id })}>
              All memories
            </Button>
            <Button variant="ghost" onClick={() => go("mind", { project: p.id })}>
              <Brain /> In the Mind
            </Button>
            <Button onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          </>
        }
      />
      <div className="grid gap-4 px-8 pb-10 xl:grid-cols-3">
        <ResumePanel projectId={id} onOpenHandoff={setHandoff} />
        {p.transfer_enabled && suggestions && suggestions.length ? (
          <section className="panel border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] p-4 xl:col-span-3">
            <div className="flex flex-wrap items-center gap-2">
              <Lightbulb className="size-4 text-accent-soft" />
              <h2 className="text-[13.5px] text-ink">{plural(suggestions.length, "previous insight")} may help this project</h2>
              <span className="text-[12px] text-ink-3">From research, lessons and how-tos in your other work. Suggestions only: this project's own decisions come first.</span>
              <button className="ml-auto text-[12px] text-accent hover:text-accent-soft" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Hide" : "Inspect"}
              </button>
            </div>
            {showAll ? (
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {suggestions.map((sg) => (
                  <li key={sg.id} className="rounded-[10px] border border-line p-3">
                    <div className="flex items-center gap-1.5">
                      <Badge>{MEMORY_TYPE_LABEL[sg.memory_type] ?? sg.memory_type}</Badge>
                      {sg.evidence === "sourced" ? <Badge tone="ok">{sg.sources} source{sg.sources === 1 ? "" : "s"}</Badge> : null}
                      <span className="ml-auto text-[11.5px] text-ink-3">confidence {Math.round(sg.confidence * 100)}%</span>
                    </div>
                    <button className="mt-1.5 block text-left text-[13px] text-ink hover:text-accent-soft" onClick={() => select(sg.memory_id)}>
                      {sg.title}
                    </button>
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-2">{sg.summary}</p>
                    <p className="mt-1 text-[11.5px] text-ink-3">{sg.reason}</p>
                    <div className="mt-2 flex gap-1.5">
                      <Button size="sm" onClick={() => void decide(sg.id, "accepted")}>
                        <ThumbsUp /> Useful
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void decide(sg.id, "dismissed")}>
                        <X /> Not relevant
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        <Card title="Current state" className="xl:col-span-2">
          <p className="text-[14px] text-ink">{p.status || "No status reported yet."}</p>
          {p.goals ? <p className="mt-2 text-[13px] text-ink-2">Goals: {p.goals}</p> : null}
          <p className="mt-3 text-[12px] text-ink-3">
            {plural(data.counts.memories, "memory", "memories")}, {plural(data.counts.tasks_recorded, "Claude session")}, last activity {timeAgo(p.last_activity_at)}
            {pstate?.last_meaningful_activity ? ` (${pstate.last_meaningful_activity.what})` : ""}
          </p>
          <div className="mt-3">
            <ProgressLine progress={pstate?.progress} />
          </div>
        </Card>
        <HandoffsCard projectId={id} />
        <ProjectItemsCard projectId={id} className="xl:col-span-2" />
        <Card title={`Open tasks (${data.open_tasks.length})`}>
          <MemList items={data.open_tasks} empty="Nothing unfinished." />
        </Card>
        <Card title="Important decisions">
          <MemList items={data.decisions} empty="No decisions recorded." />
        </Card>
        <Card title="Known problems">
          <MemList items={data.errors} empty="No errors recorded." />
        </Card>
        <Card title="Solutions">
          <MemList items={data.solutions} empty="No fixes recorded." />
        </Card>
        <Card title="Progress log" className="xl:col-span-2">
          <div className="prose-moth selectable max-h-[340px] overflow-y-auto text-[13px] text-ink-2">{data.progress_log ? renderInline(data.progress_log) : "Nothing logged yet."}</div>
        </Card>
        <Card title="Related files">
          {p.files.length ? (
            <ul className="selectable space-y-1 text-[12.5px] text-ink-2">
              {p.files.slice().reverse().map((f: string) => (
                <li key={f} className="truncate" title={f}>
                  {f}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-3">Files appear when Claude reports what it changed.</p>
          )}
        </Card>
        <Card title="Completed">
          <MemList items={data.completed_tasks} empty="No completed tasks yet." />
        </Card>
        <Card title="Project graph" className="xl:col-span-2">
          <div className="relative h-[260px] overflow-hidden rounded-[10px] border border-line">
            {graph ? <GraphCanvas nodes={graph.nodes} links={graph.links} settings={MINI_GRAPH} compact onSelect={(nid) => nid && select(nid)} /> : <div className="h-full bg-graph" />}
          </div>
        </Card>
        <Card title="Project settings">
          <div className="grid gap-3 text-[12.5px] text-ink-2">
            <label className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-[13px] text-ink">Suggest knowledge from other projects</span>
                Shows relevant research and lessons from your other work here.
              </span>
              <Switch checked={!!p.transfer_enabled} onChange={(v) => void setFlag({ transfer_enabled: v }, v ? "Knowledge transfer on" : "Knowledge transfer off for this project")} label="Knowledge transfer" />
            </label>
            <label className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-[13px] text-ink">Private project</span>
                Its memories never appear in other projects' context or suggestions.
              </span>
              <Switch checked={!!p.private} onChange={(v) => void setFlag({ private: v }, v ? "Project is private" : "Project is no longer private")} label="Private project" />
            </label>
          </div>
        </Card>
        <Card title="Project preferences">
          {(prefs ?? []).length ? (
            <ul className="space-y-1">
              {(prefs ?? []).map((pr) => (
                <li key={pr.id}>
                  <button className="w-full rounded-[7px] px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => select(pr.id)}>
                    <span className="block text-[13px] text-ink">{pr.content}</span>
                    <span className="text-[11.5px] text-ink-3">{AREA_LABEL[pr.area] ?? pr.area} · {pr.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 text-[12.5px] text-ink-3">No preferences only for this project. Add them in "What MOTH knows about me".</p>
          )}
        </Card>
        <Card title="Relevant research">
          {(research?.items ?? []).length ? (
            <ul className="space-y-0.5">
              {research.items.map((m: any) => (
                <li key={m.id}>
                  <button className="w-full truncate rounded-[7px] px-2 py-1.5 text-left text-[13px] text-ink hover:bg-surface-2" onClick={() => select(m.id)}>
                    {m.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 text-[12.5px] text-ink-3">No project-specific research. Reusable research shows up in the suggestions above.</p>
          )}
        </Card>
        <Card title={`Waiting for review (${projectReviews.length})`} className="xl:col-span-3">
          <ReviewList items={projectReviews} onDone={reloadReviews} empty="Nothing from this project is waiting for review." />
        </Card>
        <Card title="Recent activity" className="xl:col-span-2">
          <ul className="space-y-1.5">
            {data.recent_activity.map((e: any, i: number) => (
              <li key={i} className="flex gap-3 text-[12.5px]">
                <span className="w-24 shrink-0 text-ink-3">{timeAgo(e.at)}</span>
                <span className="text-ink-2">{e.description}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {editing ? <ProjectDialog open project={p} onClose={() => setEditing(false)} /> : null}
      {handoff ? <HandoffDialog open handoffId={handoff} onClose={() => setHandoff(null)} /> : null}
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel p-4", className)}>
      <h2 className="mb-2.5 text-[13.5px] text-ink">{title}</h2>
      {children}
    </section>
  );
}
