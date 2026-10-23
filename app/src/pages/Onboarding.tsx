import { Check, HardDrive, LogIn } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { MothMark } from "../components/MothLogo";
import { Button, Field, Input } from "../components/ui";
import { isTauri, rpc } from "../lib/api";
import { saveSecret } from "../lib/tauri";
import { cn } from "../lib/utils";

const STEPS = ["Welcome", "Your brain", "How it learns", "AI processing", "Connect Claude", "Test"] as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [info, setInfo] = useState<any>(null);
  const [key, setKey] = useState("");
  const [aiOn, setAiOn] = useState(false);
  const [connected, setConnected] = useState<{ desktop?: string; code?: string }>({});
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);

  useEffect(() => void rpc("app.info").then(setInfo), []);
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const finish = async () => {
    if (demo) await rpc("demo.load").catch(() => undefined);
    await rpc("onboarding.complete");
    onDone();
  };

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-bg">
      <Lightfield />
      <div className="relative z-10 w-[560px] max-w-[92vw]">
        {step > 0 ? (
          <ol className="mb-6 flex items-center gap-2" aria-label="Setup progress">
            {STEPS.map((s, i) => (
              <li key={s} className={cn("h-[3px] flex-1 rounded-full transition-colors", i <= step ? "bg-accent" : "bg-line")} aria-current={i === step ? "step" : undefined} title={s} />
            ))}
          </ol>
        ) : null}
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
            {step === 0 ? (
              <div className="text-center">
                <MothMark size={84} glow className="mx-auto text-accent-soft" />
                <h1 className="mt-6 text-[30px] font-[600] tracking-[0.22em]">MOTH</h1>
                <p className="mt-2 text-[15px] text-ink-2">Follow the light. Remember the journey.</p>
                <p className="mx-auto mt-6 max-w-[44ch] text-[13.5px] leading-relaxed text-ink-2">A private, long-term memory for Claude. It remembers your projects, decisions and fixes, connects them, and keeps them current as you work.</p>
                <Button variant="primary" size="lg" className="mt-8" onClick={next}>
                  Get started
                </Button>
              </div>
            ) : null}

            {step === 1 ? (
              <Card title="Where your brain lives">
                <div className="grid gap-3">
                  <Choice icon={<HardDrive />} title="On this computer only" selected onClick={next}>
                    No account. Memories stay in a private database in your user folder{info ? `: ${info.data_dir}` : ""}. It's created and ready.
                  </Choice>
                  <Choice icon={<LogIn />} title="Sign in with Google" onClick={next}>
                    Optional, and can be set up later in Settings → Account. It needs a Google OAuth client ID first, and your memories still stay on this computer.
                  </Choice>
                </div>
              </Card>
            ) : null}

            {step === 2 ? (
              <Card title="How MOTH learns" footer={<Button variant="primary" onClick={next}>Continue</Button>}>
                <ul className="space-y-3 text-[13.5px] leading-relaxed text-ink-2">
                  <Point>When Claude starts a task it asks MOTH for what's relevant: the project, past decisions, open work, and how similar problems were fixed.</Point>
                  <Point>When it finishes, Claude reports what changed. MOTH compares that with what it knows and updates, adds or connects memories, keeping every earlier version.</Point>
                  <Point>In the background, MOTH merges duplicates, flags contradictions and links related ideas. Every change has a reason, and you can undo any of it.</Point>
                  <Point>Passwords and API keys are removed before anything is saved.</Point>
                </ul>
              </Card>
            ) : null}

            {step === 3 ? (
              <Card
                title="AI processing (optional)"
                footer={
                  <>
                    <Button variant="ghost" onClick={next}>
                      Skip, keep it local
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!key.trim() || !aiOn}
                      onClick={async () => {
                        try {
                          await saveSecret("anthropic_api_key", key.trim());
                          await rpc("settings.set", { key: "ai.disclosureAccepted", value: true });
                          await rpc("settings.set", { key: "ai.enabled", value: true });
                          setKey("");
                          next();
                        } catch (e) {
                          setErr((e as Error).message);
                        }
                      }}
                    >
                      Save and continue
                    </Button>
                  </>
                }
              >
                <p className="text-[13.5px] leading-relaxed text-ink-2">MOTH works fully offline with built-in rules. With an Anthropic API key, it also asks Claude to judge how to file new knowledge and to spot contradictions.</p>
                <Field label="Anthropic API key" className="mt-4" hint={isTauri() ? "Saved in Windows Credential Manager." : undefined}>
                  <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" />
                </Field>
                <label className="mt-3 flex items-start gap-2 text-[12.5px] leading-snug text-ink-2">
                  <input type="checkbox" className="mt-0.5 accent-[#A78BFA]" checked={aiOn} onChange={(e) => setAiOn(e.target.checked)} />I understand that memory text involved in these decisions is sent to Anthropic's API.
                </label>
                {err ? <p className="mt-2 text-[12.5px] text-danger">{err}</p> : null}
              </Card>
            ) : null}

            {step === 4 ? (
              <Card title="Connect Claude" footer={<Button variant="primary" onClick={next}>{connected.desktop || connected.code ? "Continue" : "Skip for now"}</Button>}>
                <p className="mb-4 text-[13.5px] leading-relaxed text-ink-2">Pick the Claude apps you use. MOTH adds itself to their settings (a backup of the old file is kept).</p>
                <div className="grid gap-3">
                  <ConnectRow
                    title="Claude Desktop"
                    done={connected.desktop}
                    onClick={async () => {
                      try {
                        await rpc("connections.configureDesktop");
                        setConnected((c) => ({ ...c, desktop: "Added. Restart Claude Desktop to load MOTH." }));
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                  />
                  <ConnectRow
                    title="Claude Code"
                    done={connected.code}
                    onClick={async () => {
                      try {
                        await rpc("connections.configureCode", { hooks: true });
                        setConnected((c) => ({ ...c, code: "Added with memory hooks. New sessions use MOTH." }));
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                  />
                </div>
                {err ? <p className="mt-2 text-[12.5px] text-danger">{err}</p> : null}
              </Card>
            ) : null}

            {step === 5 ? (
              <Card
                title="Test the connection"
                footer={
                  <Button variant="primary" onClick={finish}>
                    Open MOTH
                  </Button>
                }
              >
                <p className="text-[13.5px] leading-relaxed text-ink-2">This starts MOTH's MCP server exactly the way Claude will and checks that all 15 memory tools answer.</p>
                <div className="mt-4 flex items-center gap-3">
                  <Button
                    loading={testing}
                    onClick={async () => {
                      setTesting(true);
                      setTest(await rpc("connections.selfTest").catch((e) => ({ ok: false, error: e.message })));
                      setTesting(false);
                    }}
                  >
                    Run test
                  </Button>
                  {test ? <span className={cn("text-[13px]", test.ok ? "text-ok" : "text-danger")}>{test.ok ? `All ${test.tools.length} tools answered in ${test.ms} ms` : `Failed: ${test.error}`}</span> : null}
                </div>
                <label className="mt-6 flex items-start gap-2 text-[12.5px] leading-snug text-ink-2">
                  <input type="checkbox" className="mt-0.5 accent-[#A78BFA]" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
                  Add a small demo project so the Mind isn't empty. It's labelled DEMO and can be removed in Settings → Data.
                </label>
              </Card>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="panel p-6 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
      <h2 className="mb-4 text-[18px]">{title}</h2>
      {children}
      {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
    </div>
  );
}

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}

function Choice({ icon, title, children, onClick, selected }: { icon: ReactNode; title: string; children: ReactNode; onClick: () => void; selected?: boolean }) {
  return (
    <button onClick={onClick} className={cn("flex gap-3 rounded-[12px] border p-4 text-left transition-colors hover:border-accent/60 [&_svg]:size-5", selected ? "border-accent/50" : "border-line")}>
      <span className="mt-0.5 text-accent-soft">{icon}</span>
      <span>
        <span className="block text-[14px] text-ink">{title}</span>
        <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-2">{children}</span>
      </span>
    </button>
  );
}

function ConnectRow({ title, done, onClick }: { title: string; done?: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-[12px] border border-line px-4 py-3">
      <div>
        <div className="text-[14px] text-ink">{title}</div>
        {done ? <div className="text-[12.5px] text-ok">{done}</div> : null}
      </div>
      {done ? (
        <Check className="size-5 text-ok" />
      ) : (
        <Button size="sm" onClick={onClick}>
          Connect
        </Button>
      )}
    </div>
  );
}

/** A slow field of faint points drifting toward a soft light: the only decorative motion in MOTH. */
function Lightfield() {
  useEffect(() => {
    const c = document.getElementById("moth-lightfield") as HTMLCanvasElement | null;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
