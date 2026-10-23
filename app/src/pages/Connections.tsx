import { Check, ClipboardCopy, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge, Button, Field, Input, PageHeader, SectionTitle, Switch } from "../components/ui";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { cn, timeAgo } from "../lib/utils";

export function ConnectionsPage() {
  const { toast } = useApp();
  const { data: s, reload } = useLive<any>("connections.status", {}, { entities: ["activity"] });
  const { data: instr } = useLive<any>("connections.instructions", {}, { entities: [] });
  const [test, setTest] = useState<any | null>(null);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const run = async (fn: () => Promise<any>, ok: string) => {
    try {
      const r = await fn();
      toast({ kind: "ok", text: ok });
      void reload();
      return r;
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  const selfTest = async () => {
    setTesting(true);
    try {
      setTest(await rpc("connections.selfTest"));
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message, tools: [] });
    } finally {
      setTesting(false);
    }
  };
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast({ kind: "ok", text: "Copied" }));

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Connections"
        description="How Claude reaches MOTH. Claude uses MOTH through MCP tools when it starts and finishes tasks; MOTH never sees chats Claude doesn't share with it."
        actions={
          <Button onClick={selfTest} loading={testing}>
            <PlugZap /> Test MCP server
          </Button>
        }
      />
      <div className="grid gap-6 px-8 pb-10 xl:grid-cols-2">
        {test ? (
          <div className={cn("panel p-4 xl:col-span-2", test.ok ? "border-[color-mix(in_srgb,var(--color-ok)_40%,transparent)]" : "border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)]")}>
            <p className="text-[13px] text-ink">
              {test.ok ? `MOTH's MCP server started and answered with all ${test.tools.length} tools in ${test.ms} ms.` : `The MCP server test failed: ${test.error ?? "missing tools"}`}
            </p>
            <p className="mt-1 text-[12px] text-ink-3">This launches the server exactly the way Claude does. It proves MOTH is ready; it doesn't prove Claude is set up.</p>
          </div>
        ) : null}

        <Card
          title="Claude Desktop"
          status={s ? (s.claude_desktop.configured ? <Badge tone="ok">Configured</Badge> : s.claude_desktop.installed ? <Badge>Not configured</Badge> : <Badge tone="warn">Not found</Badge>) : null}
        >
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            Adds MOTH to Claude Desktop's MCP settings. Restart Claude Desktop afterwards; MOTH's tools then appear in Claude's tool menu, and Claude is told to call moth_begin_task first and moth_commit_learning at the end.
          </p>
          {s ? <p className="selectable mt-2 break-all text-[11.5px] text-ink-3">{s.claude_desktop.configFile}</p> : null}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={() => run(() => rpc("connections.configureDesktop"), "Added to Claude Desktop. Restart Claude Desktop to load MOTH.")}>
              <Check /> {s?.claude_desktop.configured ? "Update configuration" : "Connect automatically"}
            </Button>
            {s?.claude_desktop.configured ? (
              <Button variant="ghost" size="sm" onClick={() => run(() => rpc("connections.removeDesktop"), "Removed from Claude Desktop")}>
                <Unplug /> Remove
              </Button>
            ) : null}
          </div>
          <details className="mt-3 text-[12.5px] text-ink-2">
            <summary className="cursor-default text-ink-3 hover:text-ink">Manual setup</summary>
            <p className="mt-2">In Claude Desktop open Settings → Developer → Edit Config, and add this inside "mcpServers":</p>
            <Code onCopy={copy}>{s ? JSON.stringify({ moth: s.command }, null, 2) : ""}</Code>
          </details>
        </Card>

        <Card title="Claude Code" status={s ? (s.claude_code.configured ? <Badge tone="ok">{s.claude_code.hooks ? "Configured with hooks" : "Configured"}</Badge> : <Badge>Not configured</Badge>) : null}>
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            Registers MOTH for all your Claude Code projects and adds two hooks: before each prompt MOTH adds a short block of relevant memories, and when a session ends it can queue the session for learning (only if you turn that on in Settings).
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={() => run(() => rpc("connections.configureCode", { hooks: true }), "Claude Code configured. New sessions will use MOTH.")}>
              <Check /> Connect with hooks
            </Button>
            <Button size="sm" onClick={() => run(() => rpc("connections.configureCode", { hooks: false }), "Claude Code configured (tools only)")}>
              Tools only
            </Button>
          </div>
          <details className="mt-3 text-[12.5px] text-ink-2">
            <summary className="cursor-default text-ink-3 hover:text-ink">Manual setup</summary>
            <p className="mt-2">Run in a terminal:</p>
            <Code onCopy={copy}>{instr?.cli ?? ""}</Code>
            <p className="mt-2">Optional: add to your CLAUDE.md so Claude always uses MOTH:</p>
            <Code onCopy={copy}>{instr?.claudeMd ?? ""}</Code>
          </details>
        </Card>

        <Card title="Live status" className="xl:col-span-2">
          <div className="grid gap-4 md:grid-cols-3">
            <Stat label="Claude right now">{s ? (s.claude_connected ? "Connected" : "Not connected") : "…"}</Stat>
            <Stat label="Last successful request">{s?.last_success ? `${s.last_success.action.replace("moth_", "").replace(/_/g, " ")}, ${timeAgo(s.last_success.created_at)}` : "None yet"}</Stat>
            <Stat label="Last request from">{s?.last_call?.source ?? "Nobody yet"}</Stat>
          </div>
          {s?.sessions?.length ? (
            <div className="mt-4">
              <h3 className="mb-1.5 text-[12.5px] text-ink-3">Sessions</h3>
              <ul className="space-y-1 text-[12.5px]">
                {s.sessions.slice(0, 6).map((x: any) => (
                  <li key={x.id} className="flex items-center gap-2">
                    <span className={cn("size-1.5 rounded-full", x.live ? "bg-ok" : "bg-ink-3")} />
                    <span className="text-ink">{x.client_name ?? "Unknown client"}</span>
                    <span className="text-ink-3">
                      {x.transport}, {x.calls} calls{x.errors ? `, ${x.errors} errors` : ""}, last seen {timeAgo(x.last_seen_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card title="Recent tool calls">
          <ul className="space-y-1">
            {(s?.recent_calls ?? []).slice(0, 12).map((c: any) => (
              <li key={c.id} className="flex items-center gap-2 text-[12.5px]">
                <span className={cn("size-1.5 rounded-full", c.status === "ok" ? "bg-ok" : "bg-danger")} />
                <span className="text-ink">{c.action}</span>
                <span className="ml-auto text-ink-3">{timeAgo(c.created_at)}</span>
              </li>
            ))}
            {s && !s.recent_calls.length ? <li className="text-[12.5px] text-ink-3">No calls yet.</li> : null}
          </ul>
          {s?.errors?.length ? (
            <div className="mt-4">
              <h3 className="mb-1 text-[12.5px] text-danger">Recent errors</h3>
              <ul className="space-y-1 text-[12px] text-ink-2">
                {s.errors.slice(0, 5).map((e: any) => (
                  <li key={e.id}>
                    {e.action}: {e.detail?.error ?? "rejected"} ({timeAgo(e.created_at)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card title={`Tools Claude can use (${s?.tools.length ?? ""})`}>
          <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-[12.5px] text-ink-2 sm:grid-cols-2">
            {(s?.tools ?? []).map((t: string) => (
              <li key={t} className="truncate">
                {t}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Network access (advanced)" className="xl:col-span-2" status={s?.http_running ? <Badge tone="ok">Running</Badge> : <Badge>Off</Badge>}>
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            For MCP clients that connect over HTTP instead of launching MOTH. Listens on this computer only (127.0.0.1) and requires the access token below. Leave it off unless a tool asks for a URL.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Switch checked={!!s?.http.enabled} onChange={(v) => run(() => rpc("settings.set", { key: "mcp.http.enabled", value: v }), v ? "HTTP endpoint started" : "HTTP endpoint stopped")} label="Enable HTTP endpoint" />
            <span className="selectable text-[12.5px] text-ink">{s?.http.url}</span>
          </div>
          {s?.http.enabled ? (
            <div className="mt-3 grid max-w-[560px] gap-2">
              <Field label="Access token" hint="Send as: Authorization: Bearer <token>">
                <div className="flex gap-2">
                  <Input readOnly value={showToken ? s.http_token ?? "" : "•".repeat(32)} className="selectable" />
                  <Button size="sm" variant="ghost" onClick={() => setShowToken(!showToken)}>
                    {showToken ? "Hide" : "Show"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copy(s.http_token)}>
                    <ClipboardCopy />
                  </Button>
                  <Button size="sm" variant="ghost" title="New token" onClick={() => run(() => rpc("connections.regenerateHttpToken"), "New token created; the old one stopped working")}>
                    <RefreshCw />
                  </Button>
                </div>
              </Field>
            </div>
          ) : null}
        </Card>

        <div className="panel p-4 text-[12.5px] leading-relaxed text-ink-2 xl:col-span-2">
          <SectionTitle>What MOTH can and can't see</SectionTitle>
          MOTH only knows what Claude sends through its tools, what the Claude Code hooks pass (your prompt, and the session file only if you allow it), and what you import. Claude decides when to call a tool: the setup tells it to use MOTH at the start and end of tasks, but a client can skip
          it. Claude.ai in the browser and the mobile apps can't run local MCP servers.
        </div>
      </div>
    </div>
  );
}

function Card({ title, status, children, className }: { title: string; status?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel p-4", className)}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[14px]">{title}</h2>
        {status}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[13.5px] text-ink">{children}</div>
    </div>
  );
}

function Code({ children, onCopy }: { children: string; onCopy: (t: string) => void }) {
  return (
    <div className="relative mt-2">
      <pre className="selectable overflow-x-auto rounded-[8px] border border-line bg-bg p-3 pr-10 text-[11.5px] leading-relaxed text-ink-2">{children}</pre>
      <button className="absolute right-2 top-2 text-ink-3 hover:text-ink" onClick={() => onCopy(children)} aria-label="Copy">
        <ClipboardCopy className="size-4" />
      </button>
    </div>
  );
}
