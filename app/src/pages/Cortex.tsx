import { Check, Cloud, Cpu, Download, Pause, Pencil, Play, Power, PowerOff, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Dialog, Empty, Field, PageHeader, SectionTitle, Select, Slider, Switch, Textarea } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";
import { ReviewList } from "../components/ReviewList";
import { CortexPulse } from "../components/CortexPulse";

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b > 1024 ** 3 ? 1 : 2)} GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(0)} MB`;

const STATE_LABEL: Record<string, { text: string; hint: string; tone: "ok" | "accent" | "neutral" | "warn" | "danger" }> = {
  unloaded: { text: "Asleep", hint: "Model not in memory; loads when work arrives", tone: "neutral" },
  starting: { text: "Loading", hint: "Reading the model into memory", tone: "accent" },
  ready: { text: "Ready", hint: "Model loaded", tone: "ok" },
  busy: { text: "Thinking", hint: "Working on a request", tone: "accent" },
  stopping: { text: "Unloading", hint: "Freeing memory", tone: "neutral" },
  error: { text: "Error", hint: "See Problems below", tone: "danger" },
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
};

export function CortexPage() {
  const { toast, select, go } = useApp();
  const { data: st, reload } = useLive<any>("cortex.status", {}, { entities: ["cortex" as any, "review", "activity", "memory"] as any });
  const { data: reviews, reload: reloadReviews } = useLive<any[]>("cortex.reviews", {}, { entities: ["review" as any] });
  const [busy, setBusy] = useState<string | null>(null);

  // Poll while something is moving (install / loading / thinking).
  useEffect(() => {
    const moving = st && (["downloading_runtime", "extracting", "downloading_model", "verifying"].includes(st.install.phase) || ["starting", "busy", "stopping"].includes(st.runtime.state) || st.queue.pending_jobs > 0);
    if (!moving) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  }, [st, reload]);

  const act = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await fn();
      if (ok) toast({ kind: "ok", text: ok });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
      void reload();
      void reloadReviews();
    }
  };

  if (!st) return <div className="p-8"><div className="skeleton h-8 w-60" /></div>;
  const installed = st.runtime.installed && st.selected_model.installed;
  const state = STATE_LABEL[st.paused ? "unloaded" : st.runtime.state] ?? STATE_LABEL.unloaded;

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Cortex"
        description="MOTH's own AI. A small language model runs on this computer, reads what Claude reports, compares it with what MOTH already knows and proposes changes. Safe changes are applied; anything that replaces knowledge waits for you."
        actions={
          installed ? (
            <>
              <Button variant="ghost" loading={busy === "pause"} onClick={() => act("pause", () => rpc("cortex.pause", { paused: !st.paused }), st.paused ? "Intelligence resumed" : "Intelligence paused")}>
                {st.paused ? <Play /> : <Pause />} {st.paused ? "Resume" : "Pause"}
              </Button>
              {st.runtime.state === "ready" || st.runtime.state === "busy" ? (
                <Button loading={busy === "unload"} onClick={() => act("unload", () => rpc("cortex.unload"), "Model unloaded; memory freed")}>
                  <PowerOff /> Unload model
                </Button>
              ) : (
                <Button variant="primary" disabled={st.paused} loading={busy === "load" || st.runtime.state === "starting"} onClick={() => act("load", () => rpc("cortex.load"), "Model loaded")}>
                  <Power /> Load model
                </Button>
              )}
            </>
          ) : null
        }
      />
      <div className="grid gap-6 px-8 pb-10 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <CortexPulse st={st} />
          {/* status */}
          <section className="panel grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Local AI">
              <Badge tone={st.paused ? "warn" : state.tone}>{st.paused ? "Paused" : state.text}</Badge>
              <span className="mt-1 block text-[11.5px] text-ink-3">{st.paused ? "Nothing is analysed until you resume" : state.hint}</span>
            </Stat>
            <Stat label="Model">{!st.selected_model.installed ? "None installed" : st.selected_model.entry ? `${st.selected_model.entry.name} (${st.selected_model.entry.quantization})` : st.selected_model.id}</Stat>
            <Stat label="Current task">{st.current_task ? `${labelTask(st.current_task.label)}, ${timeAgo(new Date(st.current_task.startedAt).toISOString())}` : "Nothing"}</Stat>
            <Stat label="Waiting">
              {st.queue.pending_jobs} to analyse, {st.queue.pending_reviews} for you to review
            </Stat>
            {st.runtime.state === "ready" && st.runtime.idleUnloadAt ? (
              <p className="text-[12px] text-ink-3 sm:col-span-2 lg:col-span-4">Unloads automatically in about {Math.max(1, Math.round((Date.parse(st.runtime.idleUnloadAt) - Date.now()) / 60000))} min if nothing else arrives (after {st.settings.idleTimeoutMin} idle minutes).</p>
            ) : null}
            {!st.readiness.ok && installed ? <p className="text-[12px] text-warn sm:col-span-2 lg:col-span-4">{st.readiness.reason}</p> : null}
          </section>

          {!installed || ["downloading_runtime", "extracting", "downloading_model", "verifying", "error", "cancelled"].includes(st.install.phase) ? <Setup st={st} onChange={reload} /> : null}

          <section>
            <SectionTitle aside={reviews?.length ? <button className="hover:text-ink" onClick={() => go("inbox")}>Open Review Queue</button> : undefined}>Waiting for your approval</SectionTitle>
            <ReviewList items={(reviews ?? []).slice(0, 3)} onDone={() => (void reloadReviews(), void reload())} empty="Nothing to review. Proposals that would replace knowledge, contradict it or that the model wasn't sure about wait in the Review Queue." />
            {reviews && reviews.length > 3 ? (
              <button className="mt-2 text-[12.5px] text-accent hover:text-accent-soft" onClick={() => go("inbox")}>
                {reviews.length - 3} more in the Review Queue
              </button>
            ) : null}
          </section>

          {installed ? <Teach ready={st.readiness.ok} /> : null}

          <section>
            <SectionTitle>Recent intelligence activity</SectionTitle>
            {st.recent.length ? (
              <ul className="divide-y divide-line rounded-[12px] border border-line">
                {st.recent.map((a: any) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                    <span className={cn("size-1.5 rounded-full", a.status === "ok" ? "bg-ok" : "bg-danger")} />
                    <span className="text-ink">{a.action === "learn" ? "Learned from new information" : a.action === "analyze" ? "Analysed information (no changes)" : a.action === "install" ? "Installed local AI" : a.action}</span>
                    <span className="text-ink-3">
                      {a.detail?.statements != null ? `${a.detail.statements} statements, ${a.detail.applied} applied, ${a.detail.queued} for review` : a.detail?.error ?? ""}
                    </span>
                    <span className="ml-auto shrink-0 text-ink-3">
                      {a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)} s, ` : ""}
                      {timeAgo(a.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ink-3">Nothing yet. When Claude sends discoveries with moth_learn, or you teach MOTH below, the results appear here.</p>
            )}
          </section>

          {st.errors.length ? (
            <section>
              <SectionTitle>Problems</SectionTitle>
              <ul className="space-y-1.5">
                {st.errors.map((e: any, i: number) => (
                  <li key={i} className="rounded-[10px] border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] px-3 py-2 text-[12.5px] text-danger">
                    {e.message} {e.at ? <span className="text-ink-3">({timeAgo(e.at)})</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="space-y-6">
          <Providers st={st} onChange={reload} />
          <Controls st={st} onChange={reload} />
          <Installed st={st} onChange={reload} onSelect={select} />
          <section className="panel p-4">
            <h2 className="mb-1 text-[14px]">What MOTH has learned from you</h2>
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              Your approvals, rejections and undos are saved and shown to the model as examples next time a similar decision comes up. The model's own weights never change.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {st.feedback.decisions.length ? (
                st.feedback.decisions.map((d: any) => (
                  <Badge key={d.verdict} tone={d.verdict === "correct" || d.verdict === "useful" ? "ok" : "warn"}>
                    {d.n} {d.verdict.replace("_", " ")}
                  </Badge>
                ))
              ) : (
                <span className="text-[12.5px] text-ink-3">No feedback yet.</span>
              )}
              {st.feedback.retrieval?.useful || st.feedback.retrieval?.not_useful ? (
                <Badge>
                  {st.feedback.retrieval.useful ?? 0} useful / {st.feedback.retrieval.not_useful ?? 0} unhelpful retrievals
                </Badge>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

const labelTask = (l: string) => ({ extract: "Understanding new information", compare: "Comparing with memories", context: "Preparing a briefing", cortex_learn: "Learning", cortex_context: "Preparing a briefing" })[l] ?? l;

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[13px] text-ink">{children}</div>
    </div>
  );
}

function Setup({ st, onChange }: { st: any; onChange: () => void }) {
  const { toast } = useApp();
  const [plan, setPlan] = useState<any>(null);
  const [modelId, setModelId] = useState<string>("");
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    void rpc<any>("cortex.plan", modelId ? { modelId } : {}).then((p) => {
      setPlan(p);
      if (!modelId) setModelId(p.model.id);
    });
  }, [modelId]);
  const ins = st.install;
  const running = ["downloading_runtime", "extracting", "downloading_model", "verifying"].includes(ins.phase);
  if (running)
    return (
      <section className="panel light-bloom p-5">
        <h2 className="text-[15px]">Installing local AI</h2>
        <p className="mt-1 text-[12.5px] text-ink-2">
          {ins.phase === "downloading_runtime" ? "Downloading the llama.cpp runtime" : ins.phase === "extracting" ? "Unpacking the runtime" : ins.phase === "downloading_model" ? "Downloading the model" : "Checking the files"}
          {ins.total ? ` — ${mb(ins.received)} of ${mb(ins.total)}${ins.bytesPerSec ? `, ${(ins.bytesPerSec / 1024 ** 2).toFixed(1)} MB/s` : ""}` : ""}
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={ins.total ? Math.round((ins.received / ins.total) * 100) : 0}>
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${ins.total ? (ins.received / ins.total) * 100 : 5}%` }} />
        </div>
        <p className="mt-2 text-[12px] text-ink-3">Every file is checked against its published SHA-256 fingerprint before MOTH uses it. You can close this page; the download continues.</p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => rpc("cortex.cancelInstall").then(onChange)}>
          Cancel
        </Button>
      </section>
    );
  if (!plan) return <div className="skeleton h-40" />;
  return (
    <section className="panel p-5">
      <h2 className="text-[15px]">Set up MOTH's local AI</h2>
      <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-2">
        This computer: {plan.hardware.cpuModel}, {plan.hardware.logicalCpus} threads, {plan.hardware.totalRamGb} GB memory
        {plan.hardware.gpus.length ? `, ${plan.hardware.gpus.map((g: any) => g.name).join(", ")}` : ""}. {plan.recommended.reason}
      </p>
      {ins.phase === "error" || ins.phase === "cancelled" ? <p className="mt-2 text-[12.5px] text-danger">Last attempt: {ins.error}</p> : null}
      <div className="mt-4 grid gap-2" role="radiogroup" aria-label="Model">
        {plan.models.map((m: any) => (
          <label key={m.id} className={cn("flex cursor-default items-start gap-3 rounded-[12px] border px-4 py-3", modelId === m.id ? "border-accent/60 bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]" : "border-line hover:border-line-strong")}>
            <input type="radio" name="model" className="mt-1 accent-[#A78BFA]" checked={modelId === m.id} onChange={() => setModelId(m.id)} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink">
                {m.name} <span className="text-ink-3">{gb(m.size)}</span>
                {m.id === plan.recommended.id ? <Badge tone="accent">Recommended</Badge> : null}
                {m.installed ? <Badge tone="ok">Installed</Badge> : null}
                {!m.fits ? <Badge tone="warn">Needs {m.minRamGb} GB memory</Badge> : null}
              </span>
              <span className="mt-0.5 block text-[12.5px] text-ink-2">{m.notes}</span>
              <span className="block text-[11.5px] text-ink-3">
                Licence: {m.license}. Source: {m.source.replace("https://", "")}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 rounded-[10px] border border-line bg-bg px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
        {plan.downloadBytes ? (
          <>
            Download: <span className="text-ink">{gb(plan.downloadBytes)}</span>
            {plan.needs.runtime && plan.runtime ? ` (llama.cpp ${plan.runtime.version} runtime ${mb(plan.runtime.size)} from github.com` : ""}
            {plan.needs.runtime && plan.needs.model ? `, model ${gb(plan.model.size)} from huggingface.co)` : plan.needs.runtime ? ")" : ` (model from huggingface.co)`}. Space needed while installing: {gb(plan.diskNeededBytes)}
            {plan.hardware.freeDiskGb != null ? `, free: ${plan.hardware.freeDiskGb} GB` : ""}.
            {plan.enoughDisk === false ? <span className="text-danger"> Not enough free disk space.</span> : null}
          </>
        ) : (
          "Everything for this model is already installed."
        )}
      </div>
      {!plan.runtimeSupported ? <p className="mt-2 text-[12.5px] text-danger">No local AI runtime is available for this operating system yet.</p> : null}
      <label className="mt-4 flex items-start gap-2 text-[12.5px] leading-snug text-ink-2">
        <input type="checkbox" className="mt-0.5 accent-[#A78BFA]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        Download these files now. Nothing is sent about you or your memories; the model then runs entirely on this computer.
      </label>
      <Button
        variant="primary"
        className="mt-3"
        disabled={!consent || plan.enoughDisk === false || !plan.runtimeSupported}
        onClick={async () => {
          try {
            await rpc("cortex.install", { modelId, consent: true });
            onChange();
          } catch (e) {
            toast({ kind: "error", text: (e as Error).message });
          }
        }}
      >
        <Download /> {plan.downloadBytes ? `Download and install (${gb(plan.downloadBytes)})` : "Use this model"}
      </Button>
    </section>
  );
}

function Teach({ ready }: { ready: boolean }) {
  const { toast, select } = useApp();
  const [text, setText] = useState("");
  const [analyzeOnly, setAnalyzeOnly] = useState(false);
  const [report, setReport] = useState<any | null>(null);
  const [running, setRunning] = useState(false);
  const go = async () => {
    setRunning(true);
    setReport(null);
    try {
      const { job_id } = await rpc<any>("cortex.learn", { text, analyze_only: analyzeOnly });
      for (let i = 0; i < 60; i++) {
        const j = await rpc<any>("cortex.job", { id: job_id, wait: 20 });
        if (j.status === "done") {
          setReport(j.result);
          if (!analyzeOnly) setText("");
          break;
        }
        if (j.status === "failed" || j.status === "cancelled") throw new Error(j.last_error ?? "Cortex could not process this");
      }
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setRunning(false);
    }
  };
  return (
    <section className="panel p-4">
      <h2 className="text-[14px]">Teach MOTH directly</h2>
      <p className="mt-1 text-[12.5px] text-ink-2">Write anything worth remembering. The local model decides how it fits with what MOTH knows.</p>
      <Textarea className="mt-3" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="The inventory system has been upgraded to ten slots." />
      <div className="mt-2 flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={!text.trim() || !ready} loading={running} onClick={go}>
          {analyzeOnly ? "Analyse" : "Learn this"}
        </Button>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <Switch checked={analyzeOnly} onChange={setAnalyzeOnly} label="Analyse only" /> Only show what it would do
        </label>
        {running ? <span className="text-[12px] text-ink-3">The model is thinking on this computer; this can take a minute on CPU.</span> : null}
      </div>
      {report ? (
        <div className="mt-3 space-y-2">
          {report.note ? <p className="text-[12.5px] text-ink-3">{report.note}</p> : null}
          {report.statements.map((s: any, i: number) => (
            <div key={i} className="rounded-[10px] border border-line px-3 py-2 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink">"{s.statement}"</span>
                <Badge tone={s.action === "applied" ? "ok" : s.action === "queued_for_review" ? "warn" : s.action === "failed" ? "danger" : "neutral"}>{s.action.replace(/_/g, " ")}</Badge>
              </div>
              <p className="mt-1 text-ink-2">
                {s.relation ? `Seen as ${s.relation.replace("_", " ")}` : ""}
                {s.target ? (
                  <>
                    {" "}of{" "}
                    <button className="text-accent hover:text-accent-soft" onClick={() => select(s.target.id)}>
                      {s.target.title}
                    </button>
                  </>
                ) : null}
                {s.proposed_operation ? `; proposed: ${OP_LABEL[s.proposed_operation] ?? s.proposed_operation}.` : ""} {s.reason}
              </p>
              <p className="text-[11.5px] text-ink-3">
                {s.model ?? ""}
                {s.confidence != null ? `, confidence ${Math.round(s.confidence * 100)}%` : ""}
                {s.error ? `, error: ${s.error}` : ""}
              </p>
            </div>
          ))}
          <p className="text-[11.5px] text-ink-3">
            {report.ms ? `${(report.ms / 1000).toFixed(1)} s` : ""} using {report.providers.join(", ")}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Providers({ st, onChange }: { st: any; onChange: () => void }) {
  const { go } = useApp();
  const p = st.providers;
  return (
    <section className="panel p-4">
      <h2 className="text-[14px]">Where thinking happens</h2>
      <div className="mt-3 space-y-3 text-[12.5px]">
        <div className="flex items-start gap-3">
          <Cpu className="mt-0.5 size-4 text-accent-soft" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-ink">
              Local model <Badge tone={p.local.ok ? "ok" : "neutral"}>{p.local.ok ? "Primary" : "Unavailable"}</Badge>
            </div>
            <p className="text-ink-3">{p.local.ok ? "Runs on this computer. Nothing leaves your PC." : p.local.reason}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Cloud className="mt-0.5 size-4 text-ink-3" />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-ink">
              {p.cloud.provider} fallback <Badge tone={p.cloud.ok ? "accent" : "neutral"}>{p.cloud.ok ? "Allowed" : "Off"}</Badge>
            </div>
            <p className="text-ink-3">{p.cloud.ok ? "Used only when the local model fails or can't decide. Every call is logged in Activity." : p.cloud.reason}</p>
            <div className="mt-2 flex items-center gap-2">
              <Switch checked={st.settings.cloudFallback} onChange={(v) => rpc("settings.set", { key: "cortex.cloudFallback", value: v }).then(onChange)} label="Allow cloud fallback" />
              <span className="text-ink-2">Allow cloud fallback</span>
            </div>
            <button className="mt-1 text-accent hover:text-accent-soft" onClick={() => go("settings", { section: "ai" })}>
              API key and consent settings
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Controls({ st, onChange }: { st: any; onChange: () => void }) {
  const set = (key: string, value: unknown) => rpc("settings.set", { key, value }).then(onChange);
  const [hw, setHw] = useState<any>(null);
  useEffect(() => void rpc("cortex.hardware").then(setHw), []);
  return (
    <section className="panel space-y-4 p-4">
      <h2 className="text-[14px]">Behaviour</h2>
      <Field
        label="How much MOTH may change on its own"
        hint={st.settings.autonomy === "cautious" ? "Only connections and confirmations happen alone; everything else waits for you." : st.settings.autonomy === "autonomous" ? "Also applies very confident corrections. Things you wrote yourself still wait for you." : "Adds and extends knowledge alone. Replacing facts, contradictions and doubtful cases wait for you."}
      >
        <Select className="w-full" value={st.settings.autonomy} onChange={(e) => set("cortex.autonomy", e.target.value)}>
          <option value="cautious">Cautious</option>
          <option value="balanced">Balanced (recommended)</option>
          <option value="autonomous">Autonomous</option>
        </Select>
      </Field>
      <Slider label="Unload the model after being idle" min={1} max={60} step={1} value={st.settings.idleTimeoutMin} onChange={(v) => set("cortex.idleTimeoutMin", v)} format={(v) => `${v} min`} />
      <Field label="Hardware" hint={hw ? (hw.gpus.length ? `Detected: ${hw.gpus.map((g: any) => g.name + (g.vramGb ? ` (${g.vramGb} GB)` : "")).join(", ")}.` : hw.gpuDetection === "ok" ? "No graphics card detected." : "Graphics card detection unavailable.") : undefined}>
        <Select className="w-full" value={st.runtime.variant} onChange={(e) => set("cortex.runtimeVariant", e.target.value)}>
          <option value="cpu">Processor (works everywhere)</option>
          <option value="vulkan">Graphics card via Vulkan (faster; downloads another runtime)</option>
        </Select>
      </Field>
      <p className="text-[12px] text-ink-3">
        Uses {st.settings.threads} processor threads, {st.settings.contextSize.toLocaleString()} tokens of context. Runtime: llama.cpp {st.runtime.build?.version ?? "?"} ({st.runtime.variant}){st.runtime.installed ? "" : ", not installed"}.
      </p>
    </section>
  );
}

function Installed({ st, onChange, onSelect }: { st: any; onChange: () => void; onSelect: (id: string | null) => void }) {
  const { toast } = useApp();
  const models = st.installed.filter((c: any) => c.kind === "model");
  const run = (fn: () => Promise<unknown>, ok: string) => fn().then(() => (toast({ kind: "ok", text: ok }), onChange())).catch((e) => toast({ kind: "error", text: e.message }));
  void onSelect;
  return (
    <section className="panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[14px]">Installed models</h2>
        {models.length ? (
          <Button size="sm" variant="ghost" title="Re-check file fingerprints" onClick={() => run(() => rpc("cortex.verify"), "Files checked")}>
            <RefreshCw />
          </Button>
        ) : null}
      </div>
      {models.length ? (
        <ul className="space-y-1.5">
          {models.map((m: any) => (
            <li key={m.id} className="flex items-center gap-2 text-[12.5px]">
              <span className={cn("size-1.5 rounded-full", m.verified ? "bg-ok" : "bg-warn")} title={m.verified ? "Fingerprint verified" : "Not verified"} />
              <span className="min-w-0 flex-1 truncate text-ink">{m.version}</span>
              {st.selected_model.id === m.id ? (
                <Badge tone="accent">In use</Badge>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => run(() => rpc("cortex.selectModel", { id: m.id }), "Model changed")}>
                  Use
                </Button>
              )}
              <Button size="sm" variant="ghost" aria-label="Remove model" onClick={() => run(() => rpc("cortex.removeModel", { id: m.id }), "Model removed")}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No model yet">Install one with the setup on this page.</Empty>
      )}
      {models.length && models.length < 3 ? <p className="mt-2 text-[12px] text-ink-3">To add another model, choose it in the setup panel that appears after removing, or from the list when no model is selected.</p> : null}
    </section>
  );
}
