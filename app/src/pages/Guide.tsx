// Quick Guide: a permanent, plain-language explanation of how MOTH works and what is (and isn't) automatic.
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Kbd, PageHeader } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";

export function GuidePage({ onRestartFirstFlight }: { onRestartFirstFlight?: () => void }) {
  const { go, toast } = useApp();
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Quick Guide"
        description="How MOTH works, in plain words."
        actions={
          <Button
            onClick={async () => {
              await rpc("firstFlight.restart");
              toast({ kind: "light", text: "First Flight will start now." });
              onRestartFirstFlight?.();
            }}
          >
            <RotateCcw /> Restart First Flight
          </Button>
        }
      />
      <div className="mx-auto grid max-w-[1040px] gap-4 px-8 pb-12 md:grid-cols-2">
        <G title="What MOTH is">
          A private, long-term memory for Claude that lives on this PC. It stores what you and Claude learn, connects related knowledge in The Mind, and gives Claude the relevant pieces at the start of a task.
        </G>
        <G title="How Claude uses it">
          Claude Desktop and Claude Code talk to MOTH through MCP tools. At the start of a task Claude calls <C>moth_begin_task</C> and gets context, your relevant preferences and useful knowledge from other projects. When it finishes, it reports what it learned.
        </G>
        <G title="What is automatic, and what isn't">
          <ul className="list-disc space-y-1 pl-4">
            <li>Automatic: organising, linking and tidying what MOTH receives; backups; Sleep Cycles; Claude Code hooks (if enabled) that ask MOTH for context on each prompt.</li>
            <li>Needs Claude to call a tool: saving research (<C>moth_submit_research</C>), lessons (<C>moth_record_lesson</C>), preferences (<C>moth_record_preference</C>), task outcomes and decisions.</li>
            <li>MOTH cannot read your Claude conversations by itself. The Claude Inbox folder is the way for any Claude, even a web chat, to hand MOTH a summary file.</li>
          </ul>
        </G>
        <G title="Safe and risky changes">
          New facts, added details and clear connections are saved automatically, each with an undo. Replacing facts, contradictions, uncertain merges, inferred preferences and research without sources wait in the <L onClick={() => go("inbox")}>Review Queue</L>. Nothing is ever deleted automatically.
        </G>
        <G title="Quick Capture">
          Press <Kbd>Ctrl</Kbd> <Kbd>Alt</Kbd> <Kbd>M</Kbd> anywhere while MOTH runs to save a thought. It's stored immediately; Cortex can organise it afterwards. Change or turn off the shortcut in Settings.
        </G>
        <G title="Pause, Privacy Mode and Quit">
          <ul className="list-disc space-y-1 pl-4">
            <li><b>Pause learning</b>: MOTH keeps running and Claude can still read memories, but nothing is learned automatically.</li>
            <li><b>Privacy Mode</b>: like pausing, and also blocks research capture, the Claude Inbox and any cloud processing. It never switches off by itself.</li>
            <li><b>Quit MOTH Completely</b> (tray menu): finishes or saves pending work, unloads the AI model and closes the database.</li>
          </ul>
        </G>
        <G title="What MOTH knows about you">
          <L onClick={() => go("adaptation")}>About Me</L> lists the preferences MOTH has learned. Things you said are confirmed; things it noticed stay tentative until you confirm them. You can edit, pin, scope, reject or delete any of them. MOTH doesn't retrain any AI model: it keeps these notes and picks the relevant ones per task.
        </G>
        <G title="The Mind">
          Every point is a real memory and every line a real connection. Click a memory to spotlight it and its neighbours, double-click to centre it, right-click for actions, and switch between all memories, one project or one memory's neighbourhood.
        </G>
        <G title="Backups">
          MOTH saves a consistent copy of its database every day and keeps the last seven by default. You can choose the folder, make a backup now, check what a backup contains and restore it in Settings → Data.
        </G>
        <G title="Keyboard">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span><Kbd>Ctrl</Kbd> <Kbd>K</Kbd></span> <span>Command Center: search memories, open projects, run actions</span>
            <span><Kbd>Ctrl</Kbd> <Kbd>1–9</Kbd></span> <span>Main pages</span>
            <span><Kbd>Ctrl</Kbd> <Kbd>N</Kbd></span> <span>New memory</span>
            <span><Kbd>Ctrl</Kbd> <Kbd>,</Kbd></span> <span>Settings</span>
            <span><Kbd>Ctrl</Kbd> <Kbd>Alt</Kbd> <Kbd>M</Kbd></span> <span>Quick Capture (anywhere)</span>
          </div>
        </G>
      </div>
    </div>
  );
}

function G({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel p-5">
      <h2 className="text-[14.5px] text-ink">{title}</h2>
      <div className="mt-2 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-px text-[12px] text-accent-soft">{children}</code>;
}

function L({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-accent hover:text-accent-soft" onClick={onClick}>
      {children}
    </button>
  );
}
