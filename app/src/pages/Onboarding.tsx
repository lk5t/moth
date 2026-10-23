// First Flight: MOTH's first-run experience. Five short screens, resumable after a restart, every optional step
// skippable, and available again from Settings → "Restart First Flight".
import { AlertTriangle, Check, Cpu, FolderInput, HardDrive, MemoryStick, MonitorCog, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MothMark } from "../components/MothLogo";
import { Badge, Button, Field, Input, Switch, Textarea } from "../components/ui";
import { GraphCanvas, type GraphHandle } from "../graph/GraphCanvas";
import { isTauri, rpc } from "../lib/api";
import { useLive } from "../lib/hooks";
import { getAutostart, pickFolder, setAutostart, setKeepInTray } from "../lib/tauri";
import { cn } from "../lib/utils";

const STEPS = ["Welcome", "MOTH's brain", "Connect Claude", "How MOTH learns", "First memory"] as const;
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(0)} MB`;

export function Onboarding({ onDone }: { onDone: (memoryId?: string) => void }) {
  const [step, setStepState] = useState<number | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  // Resume where the user left off (progress is stored in MOTH's database, so it survives restarts).
  useEffect(() => {
    void rpc<any>("firstFlight.get")
      .then((ff) => {
        setStepState(Math.min(Number(ff?.step ?? 0), STEPS.length - 1));
        setSkipped(ff?.skipped ?? []);
      })
      .catch(() => setStepState(0));
  }, []);

  const setStep = (n: number, skip?: string) => {
    setStepState(n);
    if (skip) setSkipped((s) => [...new Set([...s, skip])]);
    void rpc("firstFlight.save", { step: n, ...(skip ? { skipped: [skip] } : {}) }).catch(() => undefined);
  };
  const finish = async (memoryId?: string) => {
    await rpc("firstFlight.save", { step: STEPS.length - 1, completed: true, ...(memoryId ? { firstMemoryId: memoryId } : {}) }).catch(() => undefined);
    onDone(memoryId);
  };

  if (step === null) return <div className="h-full bg-bg" />;
  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-bg">
      <Lightfield />
      <div className="relative z-10 w-[600px] max-w-[92vw]">
        {step > 0 ? (
          <div className="mb-6">
            <ol className="flex items-center gap-2" aria-label="First Flight progress">
              {STEPS.map((s, i) => (
                <li key={s} className={cn("h-[3px] flex-1 rounded-full transition-colors duration-500", i < step ? "bg-accent" : i === step ? "bg-accent-soft" : "bg-line")} aria-current={i === step ? "step" : undefined} title={s} />
              ))}
            </ol>
            <div className="mt-2 flex items-center justify-between text-[11.5px] text-ink-3">
              <span>
                Step {step + 1} of {STEPS.length} · {STEPS[step]}
              </span>
              <button className="hover:text-ink" onClick={() => void finish()}>
                Skip setup
              </button>
            </div>
          </div>
        ) : null}
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}>
            {step === 0 ? <Welcome onBegin={() => setStep(1)} onSkip={() => void finish()} /> : null}
            {step === 1 ? <BrainStep onNext={() => setStep(2)} onSkip={() => setStep(2, "model")} onBack={() => setStep(0)} /> : null}
            {step === 2 ? <ClaudeStep onNext={() => setStep(3)} onSkip={() => setStep(3, "claude")} onBack={() => setStep(1)} /> : null}
            {step === 3 ? <PreferencesStep onNext={() => setStep(4)} onBack={() => setStep(2)} /> : null}
            {step === 4 ? <FirstMemoryStep onDone={(id) => void finish(id)} onBack={() => setStep(3)} skipped={skipped} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 1. Welcome
function Welcome({ onBegin, onSkip }: { onBegin: () => void; onSkip: () => void }) {
  return (
    <div className="text-center">
      <FlutteringMoth />
      <h1 className="mt-6 text-[30px] font-[600] tracking-[0.22em]">MOTH</h1>
      <p className="mt-1 text-[13px] tracking-wide text-ink-3">Follow the light. Remember the journey.</p>
      <p className="mt-7 text-[19px] text-ink">Your second brain starts here.</p>
      <p className="mx-auto mt-3 max-w-[48ch] text-[13.5px] leading-relaxed text-ink-2">
        MOTH remembers what you and Claude learn, connects related knowledge, and hands Claude the right pieces next time, so earlier discoveries aren't lost. Everything stays on this computer. No account needed.
      </p>
      <Button variant="primary" size="lg" className="mt-8" onClick={onBegin}>
        Begin First Flight
      </Button>
      <div className="mt-3">
        <button className="text-[12.5px] text-ink-3 hover:text-ink" onClick={onSkip}>
          Skip, I'll set things up later
        </button>
      </div>
      <p className="mt-6 text-[11.5px] text-ink-3">About 2–3 minutes. You can stop at any point and pick up where you left off.</p>
    </div>
  );
}

function FlutteringMoth() {
  return (
    <motion.div className="mx-auto w-fit text-accent-soft" animate={{ y: [0, -4, 0] }} transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}>
      <motion.div animate={{ scaleX: [1, 0.86, 1] }} transition={{ duration: 2.1, repeat: Infinity, ease: "easeInOut" }}>
        <MothMark size={88} glow />
      </motion.div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ 2. Install MOTH's brain
function BrainStep({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const [plan, setPlan] = useState<any>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data: st, reload } = useLive<any>("cortex.status", {}, { entities: ["cortex" as any] });
  useEffect(() => void rpc("cortex.plan").then(setPlan).catch((e) => setPlanErr((e as Error).message)), []);
  const ins = st?.install;
  const running = ins && ["downloading_runtime", "extracting", "downloading_model", "verifying"].includes(ins.phase);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  }, [running, reload]);
  const installed = !!(st?.runtime?.installed && st?.selected_model?.installed);
  const hw = plan?.hardware;
  const backends = (plan?.runtimes ?? []).map((r: any) => (r.variant === "vulkan" ? "Vulkan (graphics card)" : "CPU")) as string[];

  return (
    <Card
      title="Install MOTH's brain"
      onBack={onBack}
      footer={
        installed || running ? (
          <Button variant="primary" onClick={onNext}>
            {running ? "Continue while it installs" : "Continue"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onSkip}>
              Skip for now
            </Button>
            <Button
              variant="primary"
              disabled={!consent || !plan || plan.enoughDisk === false || !plan.runtimeSupported}
              onClick={async () => {
                setErr(null);
                try {
                  await rpc("cortex.install", { modelId: plan.model.id, consent: true });
                  void reload();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Install
            </Button>
          </>
        )
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        MOTH can run a small language model <span className="text-ink">on this computer</span> to understand what Claude tells it and keep its knowledge tidy. Nothing is sent anywhere to do this. It loads only when there's work and unloads after a few idle minutes. MOTH also works without it.
      </p>

      {planErr ? (
        <Notice icon={<AlertTriangle />} tone="warn">
          MOTH couldn't read this computer's hardware ({planErr}), so it won't guess a recommendation. You can choose a model later in Cortex.
        </Notice>
      ) : !plan ? (
        <div className="skeleton mt-4 h-28" />
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
            <Spec icon={<MemoryStick />} label="Memory (RAM)" value={hw.totalRamGb ? `${hw.totalRamGb} GB` : "Unknown"} />
            <Spec icon={<HardDrive />} label="Free disk" value={hw.freeDiskGb != null ? `${hw.freeDiskGb} GB` : "Unknown"} />
            <Spec icon={<MonitorCog />} label="Graphics" value={hw.gpuDetection === "ok" ? (hw.gpus.length ? hw.gpus.map((g: any) => g.name).join(", ") : "None found") : "Not detected"} />
          </div>
          <div className="mt-3 rounded-[12px] border border-line px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] text-ink">{plan.model.name}</span>
              <Badge tone="accent">Recommended</Badge>
            </div>
            <div className="mt-1">{plan.recommended.reason}</div>
            <div className="mt-1">
              Download {gb(plan.downloadBytes)} · needs about {gb(plan.diskNeededBytes)} free while installing · licence {plan.model.license}
            </div>
            <div className="text-ink-3">Supported here: {backends.length ? backends.join(", ") : "no local runtime for this system"}. Files are checked with SHA-256 before use.</div>
            {plan.enoughRam === false ? <div className="mt-1 text-warn">This computer has less memory than this model recommends.</div> : null}
            {plan.enoughDisk === false ? <div className="mt-1 text-danger">Not enough free disk space.</div> : null}
          </div>
        </>
      )}

      {installed && !running ? (
        <Notice icon={<Check />} tone="ok">
          Installed and verified. MOTH's brain is ready.
        </Notice>
      ) : running ? (
        <div className="mt-4 rounded-[12px] border border-line px-4 py-3">
          <div className="text-[12.5px] text-ink-2">
            {ins.phase === "downloading_runtime" ? "Downloading the llama.cpp runtime" : ins.phase === "extracting" ? "Unpacking the runtime" : ins.phase === "downloading_model" ? "Downloading the model" : "Verifying files"}
            {ins.total ? ` — ${mb(ins.received)} of ${mb(ins.total)}${ins.bytesPerSec ? ` · ${(ins.bytesPerSec / 1024 ** 2).toFixed(1)} MB/s` : ""}` : ""}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={ins.total ? Math.round((ins.received / ins.total) * 100) : 0}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${ins.total ? (ins.received / ins.total) * 100 : 4}%` }} />
          </div>
          <button className="mt-2 text-[12px] text-ink-3 hover:text-ink" onClick={() => void rpc("cortex.cancelInstall").then(reload)}>
            Cancel download
          </button>
        </div>
      ) : plan ? (
        <label className="mt-4 flex items-start gap-2 text-[12.5px] leading-snug text-ink-2">
          <input type="checkbox" className="mt-0.5 accent-[#A78BFA]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          Yes, download {gb(plan.downloadBytes)} from huggingface.co and github.com and install it.
        </label>
      ) : null}
      {ins?.phase === "error" ? <p className="mt-2 text-[12.5px] text-danger">Install failed: {ins.error}. You can retry here or later in Cortex.</p> : null}
      {err ? <p className="mt-2 text-[12.5px] text-danger">{err}</p> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ 3. Connect Claude
const STATE_TEXT: Record<string, { label: string; tone: "ok" | "neutral" | "warn" | "danger" | "accent" }> = {
  connected: { label: "Connected", tone: "ok" },
  not_configured: { label: "Not configured", tone: "neutral" },
  configured: { label: "Configuration detected", tone: "accent" },
  restart_required: { label: "Restart required", tone: "warn" },
  test_failed: { label: "Connection test failed", tone: "danger" },
};

function ClaudeStep({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const { data: conn, reload } = useLive<any>("connections.status", {}, { entities: ["activity"] });
  const { data: inbox, reload: reloadInbox } = useLive<any>("folders.status", {}, { entities: ["settings" as any] });
  const [test, setTest] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hooks, setHooks] = useState(true);
  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      void reload();
      void reloadInbox();
    }
  };
  const clients = conn?.clients;
  const anyConfigured = clients && (clients.claude_desktop.configured || clients.claude_code.configured);
  const state = (s: string) => (test && !test.ok && s !== "not_configured" ? "test_failed" : s);

  return (
    <Card
      title="Connect Claude"
      onBack={onBack}
      footer={
        <>
          {!anyConfigured ? (
            <Button variant="ghost" onClick={onSkip}>
              Skip for now
            </Button>
          ) : null}
          <Button variant="primary" onClick={onNext}>
            Continue
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        Claude talks to MOTH through MCP, a standard way for Claude apps to use tools. MOTH adds one entry for itself to your Claude settings, keeps a backup of the old file, and never touches your other tools.
      </p>
      {!clients ? (
        <div className="skeleton mt-4 h-24" />
      ) : (
        <div className="mt-4 grid gap-2">
          <ClientRow
            title="Claude Desktop"
            detail={clients.claude_desktop.installed ? "Found on this computer" : "Not found (you can still prepare it)"}
            state={state(clients.claude_desktop.state)}
            action={
              <Button size="sm" loading={busy === "desktop"} onClick={() => run("desktop", () => rpc("connections.configureDesktop"))}>
                {clients.claude_desktop.configured ? "Reconnect" : "Connect"}
              </Button>
            }
          />
          <ClientRow
            title="Claude Code"
            detail={clients.claude_code.hooks ? "With memory hooks" : clients.claude_code.configured ? "Without hooks" : "Command-line Claude"}
            state={state(clients.claude_code.state)}
            action={
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3" title="Hooks let Claude Code ask MOTH for context at the start of each prompt">
                  <input type="checkbox" className="accent-[#A78BFA]" checked={hooks} onChange={(e) => setHooks(e.target.checked)} /> hooks
                </label>
                <Button size="sm" loading={busy === "code"} onClick={() => run("code", () => rpc("connections.configureCode", { hooks }))}>
                  {clients.claude_code.configured ? "Reconnect" : "Connect"}
                </Button>
              </div>
            }
          />
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" loading={busy === "test"} onClick={() => run("test", async () => setTest(await rpc("connections.selfTest")))}>
          <Plug /> Test MOTH's MCP server
        </Button>
        {test ? (
          <span className={cn("text-[12.5px]", test.ok ? "text-ok" : "text-danger")}>
            {test.ok ? `Started, listed ${test.tools.length} tools and ran one in ${test.ms} ms` : `Failed: ${test.error}`}
          </span>
        ) : null}
      </div>
      {clients && (clients.claude_desktop.state === "restart_required" || clients.claude_code.state === "restart_required") ? (
        <p className="mt-2 text-[12px] text-warn">Restart Claude (fully quit it from its tray icon) so it loads MOTH. "Connected" appears once Claude actually talks to MOTH.</p>
      ) : null}

      <div className="mt-4 rounded-[12px] border border-line px-4 py-3">
        <div className="flex items-start gap-3">
          <FolderInput className="mt-0.5 size-4 shrink-0 text-accent-soft" />
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
            <div className="text-[13.5px] text-ink">Claude Inbox folder (optional)</div>
            Any Claude, including chats in the browser or the cloud, can save a summary as a file in this folder. MOTH imports it while it runs and moves it to "Imported". Nothing is deleted.
            {inbox?.enabled && inbox?.folder ? <div className="mt-1 truncate text-ok" title={inbox.folder}>Watching {inbox.folder}</div> : null}
          </div>
          <Button
            size="sm"
            loading={busy === "inbox"}
            onClick={() =>
              run("inbox", async () => {
                const f = await pickFolder();
                if (f) await rpc("folders.setupInbox", { folder: f });
              })
            }
          >
            {inbox?.enabled ? "Change" : "Choose folder"}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
        Good to know: MOTH only learns what Claude sends it through its tools (or what lands in the Claude Inbox). It cannot read every conversation by itself, and it will never claim Claude used it unless a real call was recorded.
      </p>
      {err ? <p className="mt-2 text-[12.5px] text-danger">{err}</p> : null}
    </Card>
  );
}

function ClientRow({ title, detail, state, action }: { title: string; detail: string; state: string; action: ReactNode }) {
  const s = STATE_TEXT[state] ?? STATE_TEXT.not_configured;
  return (
    <div className="flex items-center justify-between gap-3 rounded-[12px] border border-line px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[14px] text-ink">
          {title} <Badge tone={s.tone as any}>{s.label}</Badge>
        </div>
        <div className="text-[12px] text-ink-3">{detail}</div>
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ 4. Learning preferences
function PreferencesStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [s, setS] = useState<any>(null);
  const [autostart, setAuto] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void rpc<any>("settings.get").then((r) => setS(r.settings));
    void getAutostart().then(setAuto).catch(() => undefined);
  }, []);
  const set = async (key: string, value: unknown) => {
    setS((cur: any) => ({ ...cur, [key]: value }));
    try {
      await rpc("settings.set", { key, value });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!s) return <Card title="How MOTH learns"><div className="skeleton h-40" /></Card>;
  return (
    <Card
      title="How MOTH learns"
      onBack={onBack}
      footer={
        <Button variant="primary" onClick={onNext}>
          Continue
        </Button>
      }
    >
      <div className="grid gap-1">
        <Pref title="Save and update safe memories automatically" hint="New facts, added details and clear connections are saved right away. Every change keeps a version you can undo.">
          <Switch checked={s["automation.autoLearn"]} onChange={(v) => void set("automation.autoLearn", v)} label="Automatic memory" />
        </Pref>
        <Pref title="Ask me before risky changes" hint="Replacing facts, contradictions, uncertain merges and changes to things you wrote wait in the Review Queue (recommended).">
          <Switch checked={s["cortex.autonomy"] !== "autonomous"} onChange={(v) => void set("cortex.autonomy", v ? "balanced" : "autonomous")} label="Approval for risky changes" />
        </Pref>
        <Pref title="Keep running in the background" hint="Closing the window hides MOTH to the tray so Claude can keep using it. Quit from the tray menu to stop it completely.">
          <Switch
            checked={s["app.closeToTray"] !== false}
            onChange={(v) => {
              void set("app.closeToTray", v);
              void setKeepInTray(v);
            }}
            label="Background operation"
          />
        </Pref>
        <Pref title="Start with Windows" hint="Starts quietly in the tray when you sign in. The AI model is not loaded until it's needed.">
          <Switch
            checked={autostart}
            disabled={!isTauri()}
            onChange={async (v) => {
              try {
                setAuto(await setAutostart(v));
                await set("app.launchOnStartup", v);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
            label="Start with Windows"
          />
        </Pref>
        <Pref title="Remove passwords and keys before saving" hint="Anything that looks like a secret is replaced before it's stored.">
          <Switch checked={s["privacy.redactSecrets"]} onChange={(v) => void set("privacy.redactSecrets", v)} label="Redact secrets" />
        </Pref>
        <div className="mt-2 rounded-[12px] border border-line px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
          <div className="flex items-center gap-2 text-[13.5px] text-ink">
            <ShieldCheck className="size-4 text-accent-soft" /> Cloud fallback stays off
          </div>
          If MOTH's own model can't handle something, it can optionally ask Claude's API instead. That would send the selected memory text outside this PC and may cost API credits, so it stays off until you add an API key and turn it on in Cortex → Providers. Privacy Mode (Settings or the tray) stops all automatic learning at any time.
        </div>
      </div>
      {err ? <p className="mt-2 text-[12.5px] text-danger">{err}</p> : null}
    </Card>
  );
}

function Pref({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-[10px] px-1 py-2">
      <div>
        <div className="text-[13.5px] text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{hint}</div>
      </div>
      <div className="pt-1">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ 5. First memory
function FirstMemoryStep({ onDone, onBack, skipped }: { onDone: (id?: string) => void; onBack: () => void; skipped: string[] }) {
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<any>(null);
  const [graph, setGraph] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const ref = useRef<GraphHandle>(null);
  const settings = useMemo(() => ({ centerForce: 0.12, repelForce: 160, linkForce: 0.4, linkDistance: 46, nodeSize: 1.4, linkThickness: 1, textFadeThreshold: 0.2, showLabels: true, animate: true, colorBy: "none" as const, showArrows: false }), []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await rpc<any>("capture.save", { text, project: project.trim() || undefined, source: "first-flight", analyze: true });
      setSaved(r);
      setGraph(await rpc<any>("graph.local", { id: r.memory.id, depth: 1 }));
      setTimeout(() => ref.current?.focus(r.memory.id, 1.3), 600);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Your first memory"
      onBack={saved ? undefined : onBack}
      footer={
        saved ? (
          <Button variant="primary" size="lg" onClick={() => onDone(saved.memory.id)}>
            Enter The Mind
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onDone()}>
              Skip
            </Button>
            <Button variant="primary" loading={saving} disabled={text.trim().length < 3} onClick={save}>
              Remember this
            </Button>
          </>
        )
      }
    >
      {!saved ? (
        <>
          <p className="text-[13.5px] leading-relaxed text-ink-2">Tell MOTH something worth remembering. It's saved straight into your memory database and becomes the first point of light in The Mind.</p>
          <Textarea className="mt-4" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="I'm building a Roblox game." />
          <Field label="Project (optional)" className="mt-3" hint="Groups related memories. You can add more projects any time.">
            <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. Cursed RNG" />
          </Field>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-line px-4 py-2.5 text-[12.5px] text-ink-2">
            <span>{imported ?? "Already keep notes in Obsidian or a folder of Markdown files? Import them (optional)."}</span>
            <Button
              size="sm"
              onClick={async () => {
                const f = await pickFolder();
                if (!f) return;
                try {
                  const r = await rpc<any>("import.markdown", { folder: f });
                  setImported(`Imported ${r.imported} notes (${r.links} links).`);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Import notes
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Saved. <span className="text-ink">"{saved.memory.title}"</span> is now in MOTH's database{saved.memory.project_id ? " and connected to its project" : ""}.
          </p>
          <div className="relative mt-3 h-[230px] overflow-hidden rounded-[12px] border border-line">
            {graph ? <GraphCanvas ref={ref} nodes={graph.nodes} links={graph.links} settings={settings} selectedId={saved.memory.id} compact bloom={new Map([[saved.memory.id, performance.now() + 300]])} /> : null}
          </div>
          <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
            <Cpu className="size-3.5" /> {saved.analysis}
            {skipped.includes("model") ? " You can install MOTH's brain later in Cortex." : ""}
          </p>
        </>
      )}
      {err ? <p className="mt-2 text-[12.5px] text-danger">{err}</p> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ shared pieces
function Card({ title, children, footer, onBack }: { title: string; children: ReactNode; footer?: ReactNode; onBack?: () => void }) {
  return (
    <div className="panel p-6 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
      <h2 className="mb-4 text-[19px]">{title}</h2>
      {children}
      {footer || onBack ? (
        <div className="mt-6 flex items-center justify-end gap-2">
          {onBack ? (
            <Button variant="ghost" className="mr-auto" onClick={onBack}>
              Back
            </Button>
          ) : null}
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function Spec({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-line px-3 py-2 [&_svg]:size-3.5">
      <div className="flex items-center gap-1.5 text-ink-3">
        {icon} {label}
      </div>
      <div className="mt-0.5 truncate text-ink" title={value}>
        {value}
      </div>
    </div>
  );
}

function Notice({ icon, tone, children }: { icon: ReactNode; tone: "ok" | "warn"; children: ReactNode }) {
  return (
    <div className={cn("mt-4 flex items-start gap-2 rounded-[12px] border px-4 py-3 text-[12.5px] leading-relaxed [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0", tone === "ok" ? "border-[color-mix(in_srgb,var(--color-ok)_35%,transparent)] text-ok" : "border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] text-warn")}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

export function RestartIcon() {
  return <RefreshCw />;
}

/** A slow field of faint points drifting toward a soft light: the only decorative motion in MOTH. */
function Lightfield() {
  useEffect(() => {
    const c = document.getElementById("moth-lightfield") as HTMLCanvasElement | null;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduce-motion");
    let raf = 0;
    const pts = Array.from({ length: 70 }, () => ({ a: Math.random() * Math.PI * 2, r: 120 + Math.random() * 520, s: 0.0006 + Math.random() * 0.0012, z: Math.random() }));
    const draw = () => {
      const w = (c.width = c.clientWidth * devicePixelRatio);
      const h = (c.height = c.clientHeight * devicePixelRatio);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h * 0.36;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.45);
      g.addColorStop(0, "rgba(167,139,250,0.10)");
      g.addColorStop(1, "rgba(167,139,250,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (const p of pts) {
        if (!reduce) {
          p.a += p.s;
          p.r -= 0.05;
          if (p.r < 60) p.r = 600;
        }
        const x = cx + Math.cos(p.a) * p.r * devicePixelRatio;
        const y = cy + Math.sin(p.a) * p.r * 0.6 * devicePixelRatio;
        ctx.fillStyle = `rgba(184,184,189,${0.12 + p.z * 0.25})`;
        ctx.beginPath();
        ctx.arc(x, y, (0.8 + p.z * 1.3) * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas id="moth-lightfield" className="absolute inset-0 h-full w-full" aria-hidden />;
}
