// moth-core: one executable, several roles.
//   moth-core serve            desktop sidecar: local API + background Metamorphosis engine (+ optional HTTP MCP)
//   moth-core mcp              MCP server over stdio (what Claude Desktop / Claude Code launch)
//   moth-core mcp-http         standalone authenticated Streamable HTTP MCP endpoint
//   moth-core hook <event>     Claude Code hook handler (user-prompt | session-start | stop)
//   moth-core status|self-test|configure-claude-desktop|backup|version
import http from "node:http";
import readline from "node:readline";
import { Secrets } from "./engine/ai.ts";
import { Brain } from "./engine/brain.ts";
import { startApi } from "./api/server.ts";
import { configureClaudeDesktop, selfTest } from "./connections.ts";
import { runHook } from "./hooks.ts";
import { initLogger, log } from "./logger.ts";
import { runStdio, startHttpMcp, VERSION } from "./mcp/server.ts";
import { paths } from "./paths.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function serve(args: string[]): Promise<void> {
  initLogger(paths().logs, "moth-core");
  let brain = Brain.open({ role: "app" });
  brain.startBackground();
  let httpMcp: http.Server | null = null;

  const controller = {
    brain: () => brain,
    reopen: () => {
      log.info("Re-opening brain (restore)");
      brain.close();
      brain = Brain.open({ role: "app" });
      brain.startBackground();
    },
    httpMcpRunning: () => !!httpMcp,
    setHttpMcp: async (enabled: boolean) => {
      if (httpMcp) {
        await new Promise((r) => httpMcp!.close(() => r(null)));
        httpMcp = null;
      }
      if (!enabled) return { running: false };
      try {
        httpMcp = await startHttpMcp(brain, brain.settings.get("mcp.http.port"), brain.settings.get("mcp.http.token"));
        log.info(`HTTP MCP listening on 127.0.0.1:${brain.settings.get("mcp.http.port")}`);
        return { running: true };
      } catch (e) {
        return { running: false, error: (e as Error).message };
      }
    },
  };
  if (brain.settings.get("mcp.http.enabled") && brain.settings.get("mcp.http.token")) await controller.setHttpMcp(true);

  const api = await startApi(controller, { port: Number(flag(args, "port") ?? 0), token: flag(args, "token"), staticDir: flag(args, "static") });
  const ready = { port: api.port, token: api.token, pid: process.pid, version: VERSION, data_dir: brain.paths.base };
  process.stdout.write(`MOTH_READY ${JSON.stringify(ready)}\n`);
  log.info(`API ready on 127.0.0.1:${api.port}`);
  if (flag(args, "static")) process.stderr.write(`\nOpen MOTH: http://127.0.0.1:${api.port}/#token=${api.token}\n\n`);

  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log.info(`Shutting down (${why})`);
    const hard = setTimeout(() => process.exit(0), 15_000);
    try {
      if (httpMcp) await new Promise((r) => httpMcp!.close(() => r(null)));
      await api.close();
      const r = await brain.shutdownGracefully();
      log.info(`Clean shutdown: ${JSON.stringify(r)}`);
      process.stdout.write(`MOTH_STOPPED ${JSON.stringify(r)}\n`);
    } catch (e) {
      log.error("shutdown error", e);
    } finally {
      clearTimeout(hard);
      process.exit(0);
    }
  };
  // The desktop shell talks to us over stdin: secrets from Windows Credential Manager, and shutdown.
  if (!process.stdin.isTTY && !args.includes("--detached")) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "secrets" && msg.values && typeof msg.values === "object") {
          for (const [k, v] of Object.entries(msg.values)) Secrets.set(k, typeof v === "string" ? v : null);
          brain.refreshEmbeddingProvider();
          log.info(`Received ${Object.keys(msg.values).length} secret(s) from the desktop shell`);
        } else if (msg.type === "system") {
          // Windows idle time and power state from the desktop shell (used by the Sleep Cycle and resource profiles).
          brain.system = {
            idleSeconds: Number.isFinite(msg.idle_seconds) ? Number(msg.idle_seconds) : null,
            onBattery: typeof msg.on_battery === "boolean" ? msg.on_battery : null,
            batterySaver: typeof msg.battery_saver === "boolean" ? msg.battery_saver : null,
            updatedAt: Date.now(),
          };
        } else if (msg.type === "shutdown") void shutdown("requested");
      } catch {
        /* ignore malformed lines */
      }
    });
    rl.on("close", () => void shutdown("parent closed stdin"));
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (e) => log.error("uncaught exception", e));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", e));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";
  switch (cmd) {
    case "serve":
      return serve(args);
    case "mcp": {
      initLogger(paths().logs, "moth-mcp");
      process.on("uncaughtException", (e) => log.error("uncaught exception", e));
      return runStdio(Brain.open({ role: "mcp" }));
    }
    case "mcp-http": {
      initLogger(paths().logs, "moth-mcp-http");
      const brain = Brain.open({ role: "mcp" });
      const token = process.env.MOTH_MCP_TOKEN || brain.settings.get("mcp.http.token");
      const port = Number(flag(args, "port") ?? brain.settings.get("mcp.http.port"));
      await startHttpMcp(brain, port, token);
      process.stderr.write(`MOTH MCP (Streamable HTTP) on http://127.0.0.1:${port}/mcp\n`);
      return;
    }
    case "hook": {
      process.env.MOTH_LOG_STDERR = "0";
      initLogger(paths().logs, "moth-hooks");
      const brain = Brain.open({ role: "cli" });
      try {
        await runHook(brain, args[1] ?? "");
      } finally {
        brain.close();
      }
      return;
    }
    case "status": {
      const brain = Brain.open({ role: "cli" });
      process.stdout.write(JSON.stringify(brain.status(), null, 2) + "\n");
      brain.close();
      return;
    }
    case "self-test": {
      const r = await selfTest();
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "configure-claude-desktop": {
      const brain = Brain.open({ role: "cli" });
      process.stdout.write(JSON.stringify(configureClaudeDesktop(brain), null, 2) + "\n");
      brain.close();
      return;
    }
    case "backup": {
      const brain = Brain.open({ role: "cli" });
      process.stdout.write(JSON.stringify(brain.backup("manual")) + "\n");
      brain.close();
      return;
    }
    case "version":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stderr.write(`Unknown command "${cmd}". Use: serve | mcp | mcp-http | hook <event> | status | self-test | configure-claude-desktop | backup | version\n`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  log.error("fatal", e);
  process.exit(1);
});
