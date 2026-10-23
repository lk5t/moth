import { CircleHelp, DatabaseBackup, Download, FileInput, FolderInput, FolderOpen, LogIn, LogOut, Moon, RotateCcw, Search, ShieldCheck, ShieldOff, Trash2, Upload } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Dialog, Field, Input, PageHeader, Select, Slider, Switch } from "../components/ui";
import { isTauri, rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { getAutostart, keyringGet, keyringSet, openExternal, pickFiles, pickFolder, revealPath, saveSecret, setAutostart, setCaptureShortcut, setKeepInTray, shellInfo } from "../lib/tauri";
import { cn, timeAgo } from "../lib/utils";
import { useGraphSettings } from "./Mind";
import { setMotionSetting } from "../lib/motion";

const SECTIONS = [
  ["general", "General"],
  ["background", "Privacy, resources & Sleep Cycle"],
  ["automation", "Memory automation"],
  ["ai", "AI providers"],
  ["privacy", "Privacy and permissions"],
  ["graph", "Graph physics"],
  ["data", "Data and backups"],
  ["account", "Account"],
] as const;
type Section = (typeof SECTIONS)[number][0];

export function SettingsPage({ onRestartFirstFlight }: { onRestartFirstFlight?: () => void } = {}) {
  const { params } = useApp();
  const [section, setSection] = useState<Section>((params.section as Section) ?? "general");
  const { data, reload } = useLive<any>("settings.get", {}, { entities: ["settings" as any] });
  const { toast } = useApp();
  const s = data?.settings;
  const set = async (key: string, value: unknown, msg?: string) => {
    try {
      await rpc("settings.set", { key, value });
      await reload();
      if (msg) toast({ kind: "ok", text: msg });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" />
      <div className="flex min-h-0 flex-1 gap-8 px-8 pb-8">
        <nav className="w-[200px] shrink-0 space-y-0.5" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} onClick={() => setSection(id)} className={cn("block h-8 w-full rounded-[8px] px-3 text-left text-[13px]", section === id ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink")}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 max-w-[720px] flex-1 overflow-y-auto pr-2">
          {!s ? (
            <div className="skeleton h-40 w-full" />
          ) : section === "general" ? (
            <General s={s} set={set} onRestartFirstFlight={onRestartFirstFlight} />
          ) : section === "background" ? (
            <Background s={s} set={set} />
          ) : section === "automation" ? (
            <Automation s={s} set={set} />
          ) : section === "ai" ? (
            <Ai s={s} set={set} />
          ) : section === "privacy" ? (
            <Privacy s={s} set={set} />
          ) : section === "graph" ? (
            <GraphPhysics />
          ) : section === "data" ? (
            <Data />
          ) : (
            <Account s={s} set={set} />
          )}
        </div>
      </div>
    </div>
  );
}

type SP = { s: any; set: (k: string, v: unknown, msg?: string) => Promise<void> };

function Block({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[15px]">{title}</h2>
      {description ? <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{description}</p> : null}
      <div className="mt-3 divide-y divide-line rounded-[12px] border border-line">{children}</div>
    </section>
  );
}

function Line({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function General({ s, set, onRestartFirstFlight }: SP & { onRestartFirstFlight?: () => void }) {
  const { toast, go } = useApp();
  const [autostart, setAuto] = useState(false);
  const [update, setUpdate] = useState<any>(null);
  const [shortcut, setShortcut] = useState<string>(s["quickCapture.shortcut"]);
  useEffect(() => void getAutostart().then(setAuto), []);
  const applyShortcut = async (enabled: boolean, value: string) => {
    const err = await setCaptureShortcut(enabled ? value.trim() || null : null);
    if (err) return toast({ kind: "error", text: err });
    await set("quickCapture.enabled", enabled);
    await set("quickCapture.shortcut", value.trim(), enabled ? `Quick Capture: ${value.trim()}` : "Quick Capture shortcut off");
  };
  return (
    <>
      <Block title="First Flight & help">
        <Line label="Quick Guide" hint="How MOTH works, what's automatic and what isn't.">
          <Button size="sm" onClick={() => go("guide")}>
            <CircleHelp /> Open
          </Button>
        </Line>
        <Line label="Restart First Flight" hint="Walk through the setup again. Your memories and settings stay as they are.">
          <Button
            size="sm"
            onClick={async () => {
              await rpc("firstFlight.restart");
              onRestartFirstFlight?.();
            }}
          >
            <RotateCcw /> Restart
          </Button>
        </Line>
      </Block>
      <Block title="Quick Capture" description="A small window to save a thought from anywhere while MOTH runs. The memory is saved first; Cortex can organise it afterwards.">
        <Line label="Global shortcut" hint="For example Ctrl+Alt+M or Ctrl+Shift+Space. If another app already uses it, MOTH tells you.">
          <div className="flex items-center gap-2">
            <Input className="w-[150px]" value={shortcut} onChange={(e) => setShortcut(e.target.value)} aria-label="Shortcut" />
            <Button size="sm" onClick={() => void applyShortcut(true, shortcut)} disabled={!isTauri()}>
              Apply
            </Button>
            <Switch checked={s["quickCapture.enabled"]} disabled={!isTauri()} onChange={(v) => void applyShortcut(v, shortcut)} label="Quick Capture shortcut" />
          </div>
        </Line>
      </Block>
      <Block title="Desktop">
        <Line label="Start MOTH when Windows starts" hint="MOTH starts minimised in the tray so the memory engine is always ready.">
          <Switch
            checked={autostart}
            disabled={!isTauri()}
            label="Launch on startup"
            onChange={async (v) => {
              try {
                setAuto(await setAutostart(v));
                await set("app.launchOnStartup", v);
              } catch (e) {
                toast({ kind: "error", text: (e as Error).message });
              }
            }}
          />
        </Line>
        <Line label="Closing the window keeps MOTH running in the tray" hint="So background learning continues. Quit from the tray icon.">
          <Switch checked={s["app.closeToTray"]} onChange={(v) => (void setKeepInTray(v), set("app.closeToTray", v))} label="Close to tray" />
        </Line>
        <Line label="Notifications" hint="Important: model installed, conflicts, review queue piling up, connection or backup failures. All: also imports and finished Sleep Cycles.">
          <Select value={s["notifications.level"]} onChange={(e) => set("notifications.level", e.target.value)} aria-label="Notifications">
            <option value="important">Important only</option>
            <option value="all">All supported</option>
            <option value="silent">Silent</option>
          </Select>
        </Line>
        <Line label="Motion" hint={s["appearance.motion"] === "full" ? "All animations, glow and a gentle shimmer in The Mind." : s["appearance.motion"] === "minimal" ? "Essential feedback only: no glow animation, instant transitions." : s["appearance.motion"] === "balanced" ? "Subtle glow and smooth interactions, no ambient effects." : "Balanced, or Minimal when Windows is set to reduce animations."}>
          <Select
            value={s["appearance.reduceMotion"] ? "minimal" : s["appearance.motion"]}
            onChange={async (e) => {
              const v = e.target.value as any;
              setMotionSetting(v, false);
              await set("appearance.reduceMotion", false);
              await set("appearance.motion", v);
            }}
            aria-label="Motion"
          >
            <option value="auto">Automatic</option>
            <option value="full">Full</option>
            <option value="balanced">Balanced</option>
            <option value="minimal">Minimal</option>
          </Select>
        </Line>
      </Block>
      <Block title="Updates">
        <Line label="Check for updates" hint={update ? (update.available ? `Version ${update.latest} is available.` : update.message ?? `You have the latest version (${update.current}).`) : "Checks the project's releases page. Nothing is installed without you."}>
          <div className="flex gap-2">
            {update?.available ? (
              <Button size="sm" variant="primary" onClick={() => openExternal(update.url)}>
                Download
              </Button>
            ) : null}
            <Button size="sm" onClick={async () => setUpdate(await rpc("updates.check"))}>
              Check now
            </Button>
          </div>
        </Line>
      </Block>
    </>
  );
}

function Background({ s, set }: SP) {
  const { toast } = useApp();
  const { data: sleep, reload } = useLive<any>("sleep.status", {}, { entities: ["activity", "settings" as any] });
  const toggle = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast({ kind: "ok", text: msg });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <>
      <Block title="Privacy Mode" description="Pausing learning keeps MOTH running and readable by Claude but stops automatic learning. Privacy Mode goes further: it also blocks research capture, the Claude Inbox and any cloud processing. Neither switches back on by itself. Quitting MOTH (tray menu) stops everything.">
        <Line label="Privacy Mode" hint="Also available in the tray menu. Your existing memories stay available to view.">
          <Switch checked={s["privacy.mode"]} onChange={(v) => void toggle(() => rpc("privacy.set", { on: v }), v ? "Privacy Mode on" : "Privacy Mode off")} label="Privacy Mode" />
        </Line>
        <Line label="Pause learning" hint="Claude can still read memories; nothing new is learned automatically.">
          <Switch checked={s["automation.paused"]} onChange={(v) => void toggle(() => rpc("automation.pause", { paused: v }), v ? "Learning paused" : "Learning resumed")} label="Pause learning" />
        </Line>
      </Block>
      <Block title="Resource profile" description="How hard MOTH works in the background. MOTH never promises a fixed CPU or memory use; these change when work runs and how long the model stays loaded.">
        <Line label="Profile" hint={s["resources.profile"] === "eco" ? "Minimal background work, unloads the model after 2 idle minutes, defers maintenance (especially on battery)." : s["resources.profile"] === "performance" ? "Processes promptly and keeps the model loaded for at least 15 idle minutes." : "Processes memory jobs, defers heavy maintenance while the PC is busy. Recommended."}>
          <Select value={s["resources.profile"]} onChange={(e) => set("resources.profile", e.target.value, "Resource profile changed")} aria-label="Resource profile">
            <option value="eco">Eco</option>
            <option value="balanced">Balanced</option>
            <option value="performance">Performance</option>
          </Select>
        </Line>
      </Block>
      <Block title="Sleep Cycle" description="MOTH's background reflection: merging duplicates, flagging contradictions, connecting related memories and refreshing summaries. It waits while the PC is busy, on battery saver, when learning is paused or in Privacy Mode.">
        <Line label="When to run" hint={s["sleep.mode"] === "idle" ? (sleep?.idle_known ? "When you haven't used the PC for a while." : "Idle time isn't reported on this system, so it runs on the regular interval.") : s["sleep.mode"] === "after_session" ? "After a Claude work session (moth_end_task) has finished." : "Only when you start it."}>
          <Select value={s["sleep.mode"]} onChange={(e) => set("sleep.mode", e.target.value)} aria-label="Sleep Cycle mode">
            <option value="idle">When the PC is idle</option>
            <option value="after_session">After a Claude work session</option>
            <option value="manual">Manual only</option>
          </Select>
        </Line>
        {s["sleep.mode"] === "idle" ? (
          <Line label="Idle for at least">
            <Select value={String(s["sleep.idleMinutes"])} onChange={(e) => set("sleep.idleMinutes", Number(e.target.value))}>
              <option value="5">5 minutes</option>
              <option value="10">10 minutes</option>
              <option value="30">30 minutes</option>
            </Select>
          </Line>
        ) : null}
        <Line label="Run now" hint={sleep ? `${sleep.last_run ? `Last run ${timeAgo(sleep.last_run)}.` : "Hasn't run yet."}${sleep.defer_reason ? ` Waiting: ${sleep.defer_reason}.` : ""}` : undefined}>
          <Button size="sm" onClick={() => void toggle(() => rpc("sleep.run").then(reload), "Sleep Cycle started")}>
            <Moon /> Run Sleep Cycle
          </Button>
        </Line>
      </Block>
    </>
  );
}

function Automation({ s, set }: SP) {
  return (
    <>
      <Block title="Learning" description="What MOTH does on its own with what Claude reports. Every automatic change is recorded with a reason and can be undone from Metamorphosis.">
        <Line label="Pause all automation" hint="Claude can still read memories, but nothing is learned or reorganised.">
          <Switch checked={s["automation.paused"]} onChange={(v) => set("automation.paused", v)} label="Pause automation" />
        </Line>
        <Line label="Connect related memories automatically" hint="Only when they share a real topic; the shared words are stored as the reason.">
          <Switch checked={s["automation.autoLink"]} onChange={(v) => set("automation.autoLink", v)} label="Auto link" />
        </Line>
        <Line label="Merge near-identical memories automatically" hint="Close calls are never merged; they're listed for you to decide.">
          <Switch checked={s["automation.autoMerge"]} onChange={(v) => set("automation.autoMerge", v)} label="Auto merge" />
        </Line>
        <Line label="Reflection interval">
          <Select value={String(s["automation.reflectIntervalMin"])} onChange={(e) => set("automation.reflectIntervalMin", Number(e.target.value))}>
            <option value="10">Every 10 minutes</option>
            <option value="30">Every 30 minutes</option>
            <option value="60">Every hour</option>
            <option value="240">Every 4 hours</option>
            <option value="1440">Once a day</option>
          </Select>
        </Line>
      </Block>
      <Block title="Sensitivity">
        <div className="grid gap-5 px-4 py-4">
          <Slider label="Merge only above this similarity" min={0.85} max={0.99} step={0.01} value={s["automation.mergeThreshold"]} onChange={(v) => set("automation.mergeThreshold", v)} format={(v) => v.toFixed(2)} />
          <Slider label="Treat as duplicate above" min={0.7} max={0.97} step={0.01} value={s["automation.duplicateThreshold"]} onChange={(v) => set("automation.duplicateThreshold", v)} format={(v) => v.toFixed(2)} />
          <Slider label="Connect memories above" min={0.25} max={0.8} step={0.01} value={s["automation.linkThreshold"]} onChange={(v) => set("automation.linkThreshold", v)} format={(v) => v.toFixed(2)} />
        </div>
      </Block>
      <Block title="What Claude receives">
        <div className="grid gap-5 px-4 py-4">
          <Slider label="Context size per task (approx. tokens)" min={500} max={8000} step={100} value={s["retrieval.tokenBudget"]} onChange={(v) => set("retrieval.tokenBudget", v)} />
          <Slider label="Maximum memories per task" min={3} max={30} step={1} value={s["retrieval.maxItems"]} onChange={(v) => set("retrieval.maxItems", v)} />
          <Slider label="Minimum relevance" min={0.05} max={0.6} step={0.01} value={s["retrieval.minScore"]} onChange={(v) => set("retrieval.minScore", v)} format={(v) => v.toFixed(2)} />
        </div>
        <RetrievalPreview />
      </Block>
    </>
  );
}

function RetrievalPreview() {
  const [q, setQ] = useState("");
  const [r, setR] = useState<any | null>(null);
  return (
    <div className="px-4 py-4">
      <div className="text-[13px] text-ink">Try it</div>
      <p className="mb-2 text-[12px] text-ink-3">Type a request as you'd give it to Claude to see exactly what MOTH would hand over.</p>
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Continue my Roblox game and fix the inventory" onKeyDown={async (e) => e.key === "Enter" && q.trim() && setR(await rpc("context.preview", { query: q }))} />
        <Button size="sm" disabled={!q.trim()} onClick={async () => setR(await rpc("context.preview", { query: q }))}>
          Preview
        </Button>
      </div>
      {r ? (
        <div className="selectable mt-3 rounded-[10px] border border-line bg-bg p-3 text-[12.5px]">
          <p className="text-ink-2">
            {r.project ? `Project: ${r.project.name}. ` : "No project detected. "}
            {r.stats.items} memories, about {r.stats.approx_tokens} tokens of {r.stats.token_budget}.
          </p>
          <ul className="mt-2 space-y-1">
            {[...r.sections.decisions, ...r.sections.open_tasks, ...r.sections.errors_and_solutions, ...r.sections.relevant].map((i: any) => (
              <li key={i.id} className="text-ink">
                {i.title} <span className="text-ink-3">({Math.round(i.score * 100)}%, {i.why.join(", ")})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Ai({ s, set }: SP) {
  const { toast } = useApp();
  const { data: present, reload } = useLive<any>("secrets.status", {}, { entities: [] });
  const [key, setKey] = useState("");
  const [embKey, setEmbKey] = useState("");
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [consent, setConsent] = useState(false);
  const storeKey = async (name: string, value: string | null) => {
    try {
      await saveSecret(name, value);
      await reload();
      toast({ kind: "ok", text: value ? "Saved in Windows Credential Manager" : "Key removed" });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <>
      <Block
        title="Anthropic API (optional)"
        description="Without it, MOTH organises memories with built-in rules that run entirely on this computer. With it, MOTH asks Claude through the API to decide how to file findings, spot contradictions and write better summaries."
      >
        <Line label="Use AI processing" hint={s["ai.enabled"] && !s["ai.disclosureAccepted"] ? "Approve sending data first" : "Memory text involved in a decision is sent to Anthropic's API."}>
          <Switch
            checked={s["ai.enabled"] && s["ai.disclosureAccepted"]}
            onChange={async (v) => {
              if (v && !s["ai.disclosureAccepted"]) return setConsent(true);
              await set("ai.enabled", v);
            }}
            label="AI processing"
          />
        </Line>
        <div className="grid gap-3 px-4 py-4">
          <Field label="API key" hint={present?.anthropic_api_key ? "A key is stored. Paste a new one to replace it." : isTauri() ? "Stored in Windows Credential Manager, never in MOTH's database." : "Browser mode: kept in memory until the engine stops."}>
            <div className="flex gap-2">
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={present?.anthropic_api_key ? "••••••••••••••••" : "sk-ant-…"} autoComplete="off" />
              <Button size="sm" disabled={!key.trim()} onClick={() => storeKey("anthropic_api_key", key).then(() => setKey(""))}>
                Save
              </Button>
              {present?.anthropic_api_key ? (
                <Button size="sm" variant="ghost" onClick={() => storeKey("anthropic_api_key", null)}>
                  Remove
                </Button>
              ) : null}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model for learning">
              <Input defaultValue={s["ai.model"]} onBlur={(e) => e.target.value !== s["ai.model"] && set("ai.model", e.target.value.trim(), "Model saved")} />
            </Field>
            <Field label="Model for reflection">
              <Input defaultValue={s["ai.reflectionModel"]} onBlur={(e) => e.target.value !== s["ai.reflectionModel"] && set("ai.reflectionModel", e.target.value.trim(), "Model saved")} />
            </Field>
          </div>
          <Slider label="Maximum AI calls per hour" min={5} max={300} step={5} value={s["ai.maxCallsPerHour"]} onChange={(v) => set("ai.maxCallsPerHour", v)} />
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              loading={testing}
              onClick={async () => {
                setTesting(true);
                setTest(await rpc("ai.test").catch((e) => ({ ok: false, message: e.message })));
                setTesting(false);
              }}
            >
              Test connection
            </Button>
            {test ? <span className={cn("text-[12.5px]", test.ok ? "text-ok" : "text-danger")}>{test.ok ? `Working (${test.model})` : test.message}</span> : null}
          </div>
        </div>
        <Line label="Use AI when learning from tasks">
          <Switch checked={s["ai.useForLearning"]} onChange={(v) => set("ai.useForLearning", v)} label="AI for learning" />
        </Line>
        <Line label="Use AI during reflection">
          <Switch checked={s["ai.useForReflection"]} onChange={(v) => set("ai.useForReflection", v)} label="AI for reflection" />
        </Line>
      </Block>

      <Block title="Semantic search" description="How MOTH measures similarity between memories. The built-in option works offline; a model gives better matching for different wording.">
        <div className="grid gap-3 px-4 py-4">
          <Field label="Provider">
            <Select value={s["embeddings.provider"]} onChange={(e) => set("embeddings.provider", e.target.value, "Provider changed. MOTH re-indexes in the background.")}>
              <option value="local">Built-in (offline, word based)</option>
              <option value="openai-compatible">OpenAI-compatible server (Ollama, llama.cpp, LM Studio, OpenAI)</option>
              <option value="voyage">Voyage AI</option>
            </Select>
          </Field>
          {s["embeddings.provider"] !== "local" ? (
            <>
              {s["embeddings.provider"] === "openai-compatible" ? (
                <Field label="Server URL" hint="For Ollama: http://127.0.0.1:11434/v1">
                  <Input defaultValue={s["embeddings.baseUrl"]} placeholder="http://127.0.0.1:11434/v1" onBlur={(e) => set("embeddings.baseUrl", e.target.value.trim())} />
                </Field>
              ) : null}
              <Field label="Model">
                <Input defaultValue={s["embeddings.model"]} placeholder={s["embeddings.provider"] === "voyage" ? "voyage-3.5-lite" : "nomic-embed-text"} onBlur={(e) => set("embeddings.model", e.target.value.trim())} />
              </Field>
              <Field label="API key" hint={present?.embeddings_api_key ? "A key is stored." : "Leave empty for local servers."}>
                <div className="flex gap-2">
                  <Input type="password" value={embKey} onChange={(e) => setEmbKey(e.target.value)} autoComplete="off" />
                  <Button size="sm" disabled={!embKey.trim()} onClick={() => storeKey("embeddings_api_key", embKey).then(() => setEmbKey(""))}>
                    Save
                  </Button>
                </div>
              </Field>
            </>
          ) : null}
        </div>
      </Block>

      <Dialog
        open={consent}
        onClose={() => setConsent(false)}
        title="Send memory text to Anthropic?"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConsent(false)}>
              Keep it local
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await set("ai.disclosureAccepted", true);
                await set("ai.enabled", true, "AI processing is on");
                setConsent(false);
              }}
            >
              Allow
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">
          When AI processing is on, MOTH sends the findings Claude reports, and the few existing memories they're compared with, to Anthropic's API using your key. It's used to decide how to file knowledge, to check possible contradictions and to improve summaries. Calls are limited per hour and listed
          in Activity. You can turn this off at any time.
        </p>
      </Dialog>
    </>
  );
}

function Privacy({ s, set }: SP) {
  const p = s["mcp.permissions"];
  const setPerm = (k: string, v: boolean) => set("mcp.permissions", { ...p, [k]: v });
  return (
    <>
      <Block title="What Claude may do" description="Checked on every tool call. Changes apply immediately, even to an open Claude session.">
        <Line label="Read memories">
          <Switch checked={p.read} onChange={(v) => setPerm("read", v)} label="Read" />
        </Line>
        <Line label="Add and update memories">
          <Switch checked={p.write} onChange={(v) => setPerm("write", v)} label="Write" />
        </Line>
        <Line label="Merge memories">
          <Switch checked={p.merge} onChange={(v) => setPerm("merge", v)} label="Merge" />
        </Line>
        <Line label="Archive memories" hint="Archived memories stay restorable.">
          <Switch checked={p.archive} onChange={(v) => setPerm("archive", v)} label="Archive" />
        </Line>
        <Line label="Delete permanently when you ask Claude to" hint="Off by default. Even when on, Claude must state that you explicitly asked.">
          <Switch checked={p.delete} onChange={(v) => setPerm("delete", v)} label="Delete" />
        </Line>
      </Block>
      <Block title="Protection">
        <Line label="Remove passwords and API keys before saving" hint="Detects common key formats and 'password: …' patterns.">
          <Switch checked={s["privacy.redactSecrets"]} onChange={(v) => set("privacy.redactSecrets", v)} label="Redact secrets" />
        </Line>
        <Line label="Flag instruction-like text" hint="Memories that look like they try to instruct Claude are marked and ranked lower. Claude is always told memories are data.">
          <Switch checked={s["privacy.flagInjections"]} onChange={(v) => set("privacy.flagInjections", v)} label="Flag injections" />
        </Line>
        <Line label="Learn from finished Claude Code sessions" hint="Reads the session file Claude Code saves and, with AI processing on, extracts what's worth keeping. Off by default.">
          <Switch checked={s["automation.learnFromTranscripts"]} onChange={(v) => set("automation.learnFromTranscripts", v)} label="Transcript learning" />
        </Line>
      </Block>
      <div className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        Your brain is stored only on this computer. The engine listens on 127.0.0.1 with a new random key each launch, and the optional HTTP endpoint needs its own token.
      </div>
    </>
  );
}

function GraphPhysics() {
  const [g, update] = useGraphSettings();
  if (!g) return null;
  return (
    <Block title="Graph physics" description="The same controls as the panel in The Mind.">
      <div className="grid gap-5 px-4 py-4">
        <Slider label="Center force" min={0} max={0.6} step={0.01} value={g.centerForce} onChange={(v) => update({ centerForce: v })} format={(v) => v.toFixed(2)} />
        <Slider label="Repel force" min={10} max={600} step={5} value={g.repelForce} onChange={(v) => update({ repelForce: v })} />
        <Slider label="Link force" min={0} max={1} step={0.01} value={g.linkForce} onChange={(v) => update({ linkForce: v })} format={(v) => v.toFixed(2)} />
        <Slider label="Link distance" min={10} max={250} step={1} value={g.linkDistance} onChange={(v) => update({ linkDistance: v })} />
        <Slider label="Node size" min={0.4} max={2.5} step={0.05} value={g.nodeSize} onChange={(v) => update({ nodeSize: v })} format={(v) => v.toFixed(2)} />
        <Slider label="Link thickness" min={0.2} max={3} step={0.1} value={g.linkThickness} onChange={(v) => update({ linkThickness: v })} format={(v) => v.toFixed(1)} />
        <Slider label="Text fade threshold" min={0.3} max={4} step={0.1} value={g.textFadeThreshold} onChange={(v) => update({ textFadeThreshold: v })} format={(v) => v.toFixed(1)} />
      </div>
    </Block>
  );
}

function Data() {
  const { toast } = useApp();
  const { data: backups, reload } = useLive<any[]>("backup.list", {}, { entities: ["activity"] });
  const { data: bst, reload: reloadBst } = useLive<any>("backup.status", {}, { entities: ["settings" as any, "activity"] });
  const { data: inbox, reload: reloadInbox } = useLive<any>("folders.status", {}, { entities: ["settings" as any, "memory"] });
  const [inspect, setInspect] = useState<any>(null);
  const { data: info } = useLive<any>("app.info", {}, { entities: [] });
  const { data: demo, reload: reloadDemo } = useLive<any>("demo.present", {}, { entities: ["memory"] });
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [restore, setRestore] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => void shellInfo().then((s) => setLog(s?.log_dir ?? null)), []);
  const run = async (id: string, fn: () => Promise<any>, ok: (r: any) => string) => {
    setBusy(id);
    try {
      const r = await fn();
      toast({ kind: "ok", text: ok(r) });
      void reload();
      void reloadDemo();
      void reloadBst();
      void reloadInbox();
      return r;
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Block title="Import" description="Bring in an Obsidian vault or any folder of Markdown notes. [[Links]] become connections, files under Projects/ become projects. Importing again updates notes instead of duplicating them.">
        <div className="flex gap-2 px-4 py-4">
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\you\Documents\Mega mind" />
          {isTauri() ? (
            <Button size="sm" variant="ghost" onClick={async () => setFolder((await pickFolder()) ?? folder)}>
              <FolderOpen /> Browse
            </Button>
          ) : null}
          <Button size="sm" disabled={!folder.trim()} loading={busy === "import"} onClick={() => run("import", () => rpc("import.markdown", { folder }), (r) => `Imported ${r.imported} notes, updated ${r.updated}, ${r.links} connections, ${r.projects} projects`)}>
            <FolderInput /> Import
          </Button>
        </div>
      </Block>
      <Block title="Import files" description="Markdown, plain text or JSON (a list of memories, a MOTH export, or research/lesson/preference objects). Identical content isn't imported twice.">
        <Line label="Choose files">
          <Button size="sm" disabled={!isTauri()} loading={busy === "files"} onClick={async () => {
            const files = await pickFiles();
            if (files.length) await run("files", () => rpc("import.files", { files }), (r) => `Imported ${r.imported} memories from ${r.files} file(s)${r.notes?.length ? ` (${r.notes.length} note${r.notes.length === 1 ? "" : "s"})` : ""}`);
          }}>
            <FileInput /> Import files
          </Button>
        </Line>
      </Block>
      <Block title="Claude Inbox folder" description="Any Claude (also chats in the browser or the cloud) can drop .md, .txt or .json files here. MOTH imports them while it runs and moves them to an Imported subfolder; nothing is deleted. Paused in Privacy Mode.">
        <Line label={inbox?.enabled ? "Watching" : "Off"} hint={inbox?.folder ? <span className="selectable break-all">{inbox.folder}{inbox.exists ? "" : " (folder not found)"}{inbox.last_scan ? ` · checked ${timeAgo(inbox.last_scan)}` : ""}</span> : "Choose a folder, for example inside your Obsidian vault."}>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={!isTauri()} onClick={async () => {
              const f = await pickFolder();
              if (f) await run("inbox", () => rpc("folders.setupInbox", { folder: f }), () => "Claude Inbox folder set");
            }}>
              <FolderOpen /> Choose
            </Button>
            {inbox?.folder ? (
              <>
                <Button size="sm" loading={busy === "scan"} onClick={() => run("scan", () => rpc("folders.scanInbox"), (r) => (r.skipped ? r.skipped : `Imported ${r.imported} memories from ${r.files} file(s)`))}>
                  <Search /> Check now
                </Button>
                <Switch checked={!!inbox?.enabled} onChange={(v) => run("inbox-toggle", () => rpc("settings.set", { key: "inbox.enabled", value: v }), () => (v ? "Claude Inbox on" : "Claude Inbox off"))} label="Claude Inbox" />
              </>
            ) : null}
          </div>
        </Line>
        {inbox?.recent?.length ? (
          <div className="px-4 py-3">
            <div className="mb-1 text-[12px] text-ink-3">Recently processed</div>
            <ul className="space-y-0.5 text-[12px]">
              {inbox.recent.slice(0, 6).map((f: any) => (
                <li key={f.hash} className="flex gap-2">
                  <span className={cn("shrink-0", f.status === "failed" ? "text-danger" : "text-ok")}>{f.status}</span>
                  <span className="truncate text-ink-2" title={f.detail}>{f.name}</span>
                  <span className="ml-auto shrink-0 text-ink-3">{timeAgo(f.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Line label="Keep an Obsidian vault in sync" hint={inbox?.vault?.folder ? `${inbox.vault.folder}${inbox.vault.last_sync ? ` · synced ${timeAgo(inbox.vault.last_sync)}` : ""}` : "Re-imports the vault every few minutes so edits show up in MOTH (updates notes, never duplicates)."}>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={!isTauri()} onClick={async () => {
              const f = await pickFolder();
              if (f) await run("vault", async () => (await rpc("settings.set", { key: "vault.folder", value: f }), await rpc("settings.set", { key: "vault.sync", value: true }), rpc("folders.syncVault")), (r) => `Vault synced: ${r.imported ?? 0} new, ${r.updated ?? 0} updated`);
            }}>
              <FolderOpen /> Choose vault
            </Button>
            {inbox?.vault?.folder ? <Switch checked={!!inbox.vault.enabled} onChange={(v) => run("vault-toggle", () => rpc("settings.set", { key: "vault.sync", value: v }), () => (v ? "Vault sync on" : "Vault sync off"))} label="Vault sync" /> : null}
          </div>
        </Line>
      </Block>
      <Block title="Export">
        <Line label="Everything as JSON" hint="Memories, versions, connections, projects and history.">
          <Button size="sm" loading={busy === "json"} onClick={() => run("json", () => rpc("export.json"), (r) => `Exported to ${r.path}`).then((r) => r && revealPath(r.path))}>
            <Download /> Export
          </Button>
        </Line>
        <Line label="As an Obsidian vault" hint="One Markdown note per memory, connections as [[links]].">
          <Button size="sm" loading={busy === "md"} onClick={() => run("md", () => rpc("export.markdown"), (r) => `Wrote ${r.files} notes to ${r.path}`).then((r) => r && revealPath(r.path))}>
            <Upload /> Export
          </Button>
        </Line>
      </Block>
      <Block title="Backups" description="A consistent snapshot of the whole brain (memories, connections, projects, preferences, sources, version history and settings), checked for integrity after it's written. If the database is ever damaged, MOTH restores the newest healthy backup on start.">
        <Line label="Automatic backups" hint={bst ? `${bst.last_ok ? `Last good backup ${timeAgo(bst.last_ok)}.` : "No backup yet."}${bst.last_error ? ` Last problem: ${bst.last_error}` : ""}` : undefined}>
          <div className="flex items-center gap-2">
            <Select value={String(bst?.interval_hours ?? 24)} onChange={(e) => run("bint", () => rpc("settings.set", { key: "backup.intervalHours", value: Number(e.target.value) }), () => "Backup schedule saved")} aria-label="How often">
              <option value="6">Every 6 hours</option>
              <option value="12">Every 12 hours</option>
              <option value="24">Daily</option>
              <option value="168">Weekly</option>
            </Select>
            <Select value={String(bst?.keep ?? 7)} onChange={(e) => run("bkeep", () => rpc("settings.set", { key: "backup.keep", value: Number(e.target.value) }), () => "Retention saved")} aria-label="Keep">
              {[3, 5, 7, 14, 30].map((n) => (
                <option key={n} value={n}>
                  Keep {n}
                </option>
              ))}
            </Select>
            <Switch checked={!!bst?.auto} onChange={(v) => run("bauto", () => rpc("settings.set", { key: "backup.auto", value: v }), () => (v ? "Automatic backups on" : "Automatic backups off"))} label="Automatic backups" />
          </div>
        </Line>
        <Line label="Backup folder" hint={<span className="selectable break-all">{bst?.folder}</span>}>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={!isTauri()} onClick={async () => {
              const f = await pickFolder();
              if (f) await run("bloc", () => rpc("settings.set", { key: "backup.location", value: f }), () => "Backups will be saved there");
            }}>
              <FolderOpen /> Change
            </Button>
            {bst && bst.folder !== bst.default_folder ? (
              <Button size="sm" variant="ghost" onClick={() => run("bloc", () => rpc("settings.set", { key: "backup.location", value: "" }), () => "Back to the default folder")}>
                Default
              </Button>
            ) : null}
          </div>
        </Line>
        <Line label="Back up now">
          <Button size="sm" loading={busy === "backup"} onClick={() => run("backup", () => rpc("backup.create"), (r) => `Saved ${r.name} (integrity ${r.integrity})`)}>
            <DatabaseBackup /> Back up now
          </Button>
        </Line>
        {(backups ?? []).slice(0, 10).map((b) => (
          <Line key={`${b.folder}-${b.name}`} label={b.name.replace(".db", "")} hint={`${(b.bytes / 1024).toFixed(0)} KB, ${timeAgo(b.created_at)}`}>
            <Button size="sm" variant="ghost" onClick={async () => {
              setRestore(b.name);
              setInspect(null);
              setInspect(await rpc("backup.inspect", { name: b.name }).catch((e) => ({ ok: false, integrity: (e as Error).message })));
            }}>
              <RotateCcw /> Restore
            </Button>
          </Line>
        ))}
      </Block>
      <Block title="Demo memories">
        <Line label={demo?.present ? "Demo memories are loaded" : "Load a small labelled demo project"} hint="Clearly marked DEMO and removable in one click.">
          {demo?.present ? (
            <Button size="sm" variant="danger" onClick={() => run("demo", () => rpc("demo.remove"), (r) => `Removed ${r.removed} demo memories`)}>
              Remove demo
            </Button>
          ) : (
            <Button size="sm" onClick={() => run("demo", () => rpc("demo.load"), (r) => `Loaded ${r.memories} demo memories`)}>
              Load demo
            </Button>
          )}
        </Line>
      </Block>
      <Block title="Storage">
        <Line label="Data folder" hint={<span className="selectable break-all">{info?.data_dir}</span>}>
          {isTauri() ? (
            <Button size="sm" variant="ghost" onClick={() => revealPath(info.data_dir + "/moth.db")}>
              Open
            </Button>
          ) : null}
        </Line>
        {log ? (
          <Line label="Logs" hint={<span className="selectable break-all">{log}</span>}>
            <Button size="sm" variant="ghost" onClick={() => revealPath(log)}>
              Open
            </Button>
          </Line>
        ) : null}
      </Block>
      <Dialog
        open={!!restore}
        onClose={() => setRestore(null)}
        title="Restore this backup?"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestore(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!inspect?.ok} onClick={() => run("restore", () => rpc("backup.restore", { name: restore }), (r) => (r.restored ? "Restored. Your previous state was backed up first." : "Restore staged; it completes the next time MOTH starts.")).then(() => setRestore(null))}>
              Restore
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">Your brain goes back to {restore}. MOTH backs up the current state first, so this can be undone by restoring that backup.</p>
        {inspect ? (
          inspect.ok ? (
            <p className="mt-2 text-[12.5px] text-ink-2">
              This backup passed its integrity check and contains {inspect.memories} active memories, {inspect.relationships} connections, {inspect.projects} projects and {inspect.versions} versions.
            </p>
          ) : (
            <p className="mt-2 text-[12.5px] text-danger">This backup can't be used: {inspect.integrity}</p>
          )
        ) : (
          <p className="mt-2 text-[12.5px] text-ink-3">Checking the backup…</p>
        )}
      </Dialog>
    </>
  );
}

function Account({ s, set }: SP) {
  const { toast } = useApp();
  const { data: me, reload } = useLive<any>("auth.user", {}, { entities: [] });
  const { data: conn, reload: reloadConn } = useLive<any>("connections.status", {}, { entities: [] });
  const { data: present, reload: reloadPresent } = useLive<any>("secrets.status", {}, { entities: [] });
  const [secret, setSecret] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null);
  const [erase, setErase] = useState(false);
  const [phrase, setPhrase] = useState("");

  const google = async (purpose: string) => {
    try {
      const { state, authUrl } = await rpc<any>("auth.google.start", { purpose });
      setWaiting(purpose);
      await openExternal(authUrl);
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await rpc<any>("auth.google.status", { state });
        if (st.status === "waiting") continue;
        if (st.status === "error") throw new Error(st.error);
        if (st.result?.refresh_token) await keyringSet(`google_refresh_${purpose}`, st.result.refresh_token);
        toast({ kind: "ok", text: purpose === "signin" ? `Signed in as ${st.result.user?.email}` : "Connected" });
        break;
      }
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setWaiting(null);
      void reload();
      void reloadConn();
    }
  };
  const integ = (p: string) => (conn?.integrations ?? []).find((i: any) => i.provider === p);
  const importNow = async (p: string) => {
    const token = await keyringGet(`google_refresh_${p}`);
    if (!token) return toast({ kind: "error", text: "Connect this service again; its access was not found in Credential Manager." });
    try {
      const r = await rpc<any>("google.import", { provider: p, refresh_token: token });
      toast({ kind: "light", text: `Imported ${r.imported} new, updated ${r.updated}` });
      void reloadConn();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <>
      <Block title="Account">
        <Line label={me?.kind === "google" ? me.email : "Local only"} hint={me?.kind === "google" ? `Signed in with Google. Your memories are kept separately from the local profile's.` : "Your brain lives only on this computer. No account needed."}>
          {me?.kind === "google" ? (
            <Button size="sm" onClick={async () => (await rpc("auth.signOut"), await keyringSet("google_refresh_signin", null), reload())}>
              <LogOut /> Sign out
            </Button>
          ) : (
            <Button size="sm" disabled={!s["google.clientId"]} loading={waiting === "signin"} onClick={() => google("signin")}>
              <LogIn /> Sign in with Google
            </Button>
          )}
        </Line>
      </Block>
      <Block title="Google sign-in setup" description="Google requires each app copy to have its own OAuth client. Create a 'Desktop app' OAuth client in Google Cloud Console and paste its details here.">
        <div className="grid gap-3 px-4 py-4">
          <Field label="Client ID">
            <Input defaultValue={s["google.clientId"]} placeholder="1234-abc.apps.googleusercontent.com" onBlur={(e) => e.target.value.trim() !== s["google.clientId"] && set("google.clientId", e.target.value.trim(), "Client ID saved")} />
          </Field>
          <Field label="Client secret" hint={present?.google_client_secret ? "Stored in Credential Manager." : "Stored in Credential Manager, never in the database."}>
            <div className="flex gap-2">
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
              <Button size="sm" disabled={!secret.trim()} onClick={async () => (await saveSecret("google_client_secret", secret), setSecret(""), reloadPresent(), toast({ kind: "ok", text: "Saved" }))}>
                Save
              </Button>
            </div>
          </Field>
        </div>
      </Block>
      <Block title="Google services" description="Each one is a separate, read-only permission. Signing in doesn't grant any of them. Imported items keep a link to where they came from.">
        {[
          ["google_drive", "Google Drive", "Your 15 most recent Google Docs"],
          ["gmail", "Gmail", "Your 15 most recent starred emails (subject and preview)"],
          ["google_calendar", "Google Calendar", "Events in the next 14 days"],
        ].map(([id, label, what]) => {
          const i = integ(id);
          const on = i?.status === "connected";
          const cfg = i ? (typeof i.config === "string" ? JSON.parse(i.config || "{}") : i.config ?? {}) : {};
          return (
            <Line key={id} label={label} hint={on ? `Connected. Imports: ${what}.${cfg.last_import ? ` Last import ${timeAgo(cfg.last_import)}.` : ""}` : `Imports: ${what}.`}>
              <div className="flex gap-2">
                {on ? (
                  <>
                    <Button size="sm" onClick={() => importNow(id)}>
                      Import now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={async () => (await rpc("auth.disconnect", { provider: id }), await keyringSet(`google_refresh_${id}`, null), reloadConn())}>
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button size="sm" disabled={!s["google.clientId"]} loading={waiting === id} onClick={() => google(id)}>
                    Connect
                  </Button>
                )}
              </div>
            </Line>
          );
        })}
        {!s["google.clientId"] ? <div className="px-4 py-3 text-[12px] text-ink-3">Add a Google client ID above to enable these.</div> : null}
      </Block>
      <Block title="Delete">
        <Line label={me?.kind === "google" ? "Delete this account and its brain" : "Erase this brain"} hint="Removes every memory, connection and history entry for this profile. A final backup is kept in the backups folder.">
          <Button size="sm" variant="danger" onClick={() => setErase(true)}>
            <Trash2 /> Delete
          </Button>
        </Line>
      </Block>
      <Dialog
        open={erase}
        onClose={() => setErase(false)}
        title="Delete everything?"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setErase(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={phrase !== "DELETE MY BRAIN"}
              onClick={async () => {
                try {
                  await rpc("account.erase", { confirm: phrase });
                  toast({ kind: "ok", text: "Everything was deleted. A final backup is in the backups folder." });
                  setErase(false);
                  setPhrase("");
                  void reload();
                } catch (e) {
                  toast({ kind: "error", text: (e as Error).message });
                }
              }}
            >
              Delete everything
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] leading-relaxed text-ink-2">Type DELETE MY BRAIN to confirm.</p>
        <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoFocus />
      </Dialog>
      <p className="text-[12px] text-ink-3">
        <Badge>{me?.id ?? "local"}</Badge>
      </p>
    </>
  );
}
