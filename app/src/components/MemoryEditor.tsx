import { useEffect, useState } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { CATEGORY_LABEL } from "../lib/utils";
import { Button, Dialog, Field, Input, Select, Slider, Textarea } from "./ui";

const EMPTY = { title: "", content: "", summary: "", category: "", tags: "", project_id: "", importance: 0.5 };

export function MemoryEditor() {
  const { editing, edit, select, toast } = useApp();
  const [form, setForm] = useState(EMPTY);
  const [projects, setProjects] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [original, setOriginal] = useState<any | null>(null);
  const isNew = editing === "new";

  useEffect(() => {
    if (!editing) return;
    void rpc<any[]>("projects.list").then(setProjects).catch(() => setProjects([]));
    if (isNew) {
      setForm(EMPTY);
      setOriginal(null);
    } else {
      void rpc<any>("memories.get", { id: editing }).then((m) => {
        setOriginal(m);
        setForm({ title: m.title, content: m.content, summary: m.summary, category: m.category, tags: m.tags.join(", "), project_id: m.project_id ?? "", importance: m.importance });
      });
    }
  }, [editing, isNew]);

  const set = (k: keyof typeof EMPTY, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (isNew) {
        const m = await rpc<any>("memories.create", { title: form.title || undefined, content: form.content, category: form.category || undefined, tags, project_id: form.project_id || null, importance: form.importance });
        toast({ kind: "light", text: `Remembered "${m.title}"` });
        select(m.id);
      } else {
        const patch: Record<string, unknown> = {};
        if (form.title !== original.title) patch.title = form.title;
        if (form.content !== original.content) patch.content = form.content;
        if (form.summary !== original.summary) patch.summary = form.summary;
        if (form.category !== original.category) patch.category = form.category;
        if (tags.join() !== original.tags.join()) patch.tags = tags;
        if ((form.project_id || null) !== original.project_id) patch.project_id = form.project_id || null;
        if (form.importance !== original.importance) patch.importance = form.importance;
        if (Object.keys(patch).length) await rpc("memories.update", { id: original.id, patch, reason: "Corrected by you" });
        toast({ kind: "ok", text: "Saved. Your version now takes priority over automatic updates." });
      }
      edit(null);
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!editing}
      onClose={() => edit(null)}
      title={isNew ? "New memory" : "Edit memory"}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={() => edit(null)}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!form.content.trim()} onClick={save}>
            {isNew ? "Remember" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Title" hint={isNew ? "Leave empty and MOTH writes one from the content." : undefined}>
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Inventory saves on leave" autoFocus={isNew} />
        </Field>
        <Field label="Content" hint="Markdown. Passwords and API keys are removed automatically.">
          <Textarea rows={9} value={form.content} onChange={(e) => set("content", e.target.value)} placeholder="What should MOTH remember?" />
        </Field>
        {!isNew ? (
          <Field label="Summary">
            <Textarea rows={2} value={form.summary} onChange={(e) => set("summary", e.target.value)} />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Kind">
            <Select value={form.category} onChange={(e) => set("category", e.target.value)}>
              {isNew ? <option value="">Let MOTH decide</option> : null}
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project">
            <Select value={form.project_id} onChange={(e) => set("project_id", e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Tags" hint="Comma separated">
          <Input value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="roblox, inventory" />
        </Field>
        <Slider label="Importance" min={0} max={1} step={0.05} value={form.importance} onChange={(v) => set("importance", v)} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
    </Dialog>
  );
}
