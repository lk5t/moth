// Quick Capture: a tiny window (Ctrl+Alt+M) to save a thought without opening MOTH.
// The memory is written to the database first; success is only shown after it is stored.
// Cortex analysis (if available) runs afterwards in the background.
import { Check, ExternalLink, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MothMark } from "./MothLogo";
import { Button, Select, Switch, Textarea } from "./ui";
import { rpc } from "../lib/api";
import { hideQuickCapture, onShellEvent, openInMain } from "../lib/tauri";
import { cn } from "../lib/utils";

export function QuickCapture({ embedded, onClose, onOpen }: { embedded?: boolean; onClose?: () => void; onOpen?: (id: string) => void }) {
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<any[]>([]);
  const [analyze, setAnalyze] = useState(true);
  const [ready, setReady] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const reset = () => {
    setSaved(null);
    setErr(null);
    void rpc<any[]>("projects.list").then(setProjects).catch(() => undefined);
    void rpc<any>("cortex.status").then((s) => setReady(s.readiness)).catch(() => setReady(null));
    setTimeout(() => area.current?.focus(), 30);
  };
  useEffect(() => {
    reset();
    return onShellEvent("capture-open", reset);
  }, []);

  const close = () => {
    setText("");
    setSaved(null);
    if (embedded) onClose?.();
    else void hideQuickCapture();
  };
  const save = async () => {
    if (text.trim().length < 2 || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await rpc<any>("capture.save", { text, project: project || undefined, analyze });
      setSaved(r);
      setText("");
      if (!embedded) setTimeout(() => void hideQuickCapture(), 2200);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn("flex flex-col bg-bg", embedded ? "" : "h-full border border-line")}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
      }}
    >
      {!embedded ? (
        <div data-tauri-drag-region className="flex h-9 items-center gap-2 border-b border-line px-3">
          <MothMark size={15} className="text-accent-soft" />
          <span data-tauri-drag-region className="flex-1 text-[12px] tracking-wide text-ink-2">
            Quick Capture
          </span>
          <button onClick={close} className="text-ink-3 hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      <div className={cn("flex flex-1 flex-col gap-2.5", embedded ? "" : "p-3.5")}>
        {saved ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <span className="moth-pop grid size-9 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-ok)_16%,transparent)] text-ok">
              <Check className="size-5" />
            </span>
            <p className="mt-2 text-[13.5px] text-ink">Saved to MOTH</p>
            <p className="mt-0.5 max-w-[46ch] text-[12px] text-ink-3">{saved.analysis}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => (embedded ? onOpen?.(saved.memory.id) : void openInMain(`memory:${saved.memory.id}`))}>
                <ExternalLink /> Open in MOTH
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (setSaved(null), setTimeout(() => area.current?.focus(), 20))}>
                Capture another
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Textarea ref={area} rows={embedded ? 4 : 5} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should MOTH remember?" className="flex-1 resize-none text-[13.5px]" aria-label="Memory text" />
            <div className="flex items-center gap-2">
              <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className="h-7 max-w-[180px] text-[12px]">
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3" title={ready?.ok ? "Cortex compares it with your other memories afterwards" : `Cortex isn't available: ${ready?.reason ?? "unknown"}. It will be saved as is.`}>
                <Switch checked={analyze && !!ready?.ok} disabled={!ready?.ok} onChange={setAnalyze} label="Let Cortex organise it" />
                Organise with Cortex
              </label>
              <Button size="sm" variant="primary" className="ml-auto" loading={saving} disabled={text.trim().length < 2} onClick={() => void save()}>
                <Zap /> Save
              </Button>
            </div>
            <div className="flex items-center justify-between text-[11px] text-ink-3">
              <span>{err ? <span className="text-danger">{err}</span> : "Ctrl+Enter to save · Esc to close"}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
