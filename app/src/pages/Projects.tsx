import { ArrowLeft, Brain, Check, FolderKanban, FolderPlus, Pencil } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Dialog, Empty, Field, Input, PageHeader, Textarea } from "../components/ui";
import { renderInline } from "../components/MemoryPanel";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, plural, timeAgo } from "../lib/utils";

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
            <span className="text-[15px] text-ink">{p.name}</span>
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
  const { select, go } = useApp();
  const [editing, setEditing] = useState(false);
  const { data, error } = useLive<any>("projects.get", { id });
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
            <Button variant="ghost" onClick={() => go("mind", { focus: data.recent?.[0]?.id ?? "" })} disabled={!data.recent?.length}>
              <Brain /> In the Mind
            </Button>
            <Button onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          </>
        }
      />
      <div className="grid gap-4 px-8 pb-10 xl:grid-cols-3">
        <Card title="Current state" className="xl:col-span-2">
          <p className="text-[14px] text-ink">{p.status || "No status reported yet."}</p>
          {p.goals ? <p className="mt-2 text-[13px] text-ink-2">Goals: {p.goals}</p> : null}
          <p className="mt-3 text-[12px] text-ink-3">
            {plural(data.counts.memories, "memory", "memories")}, {plural(data.counts.tasks_recorded, "Claude session")}, last activity {timeAgo(p.last_activity_at)}
          </p>
        </Card>
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
