// Claude Code hook handlers (supported automation points).
//  - user-prompt (UserPromptSubmit): injects a small, relevant MOTH context block before Claude starts.
//  - session-start (SessionStart): same, based on the working folder name.
//  - stop (Stop): if the user enabled transcript learning, queues the finished session for learning.
//  - session-end (SessionEnd, documented with session_id, transcript_path, cwd and a 1.5 s budget): if the user
//    enabled automatic handoffs, queues a "session_handoff" job (the desktop app writes the handoff later).
// Hooks must be fast and must never block Claude: every failure exits 0 silently.
import path from "node:path";
import type { Brain } from "./engine/brain.ts";
import { buildContext, type ContextPackage } from "./engine/context.ts";
import { truncate } from "./engine/text.ts";

async function readStdin(timeoutMs = 3000): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    const t = setTimeout(() => resolve(safeParse(data)), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => {
      clearTimeout(t);
      resolve(safeParse(data));
    });
  });
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

export function formatContext(pkg: ContextPackage): string {
  const items = [...pkg.sections.decisions, ...pkg.sections.open_tasks, ...pkg.sections.errors_and_solutions, ...pkg.sections.relevant];
  if (!items.length) return "";
  const lines = [`<moth_memory>`, `(${pkg.notice})`];
  if (pkg.project) lines.push(`Project: ${pkg.project.name}${pkg.project.status ? ` — ${pkg.project.status}` : ""}`);
  for (const i of items) lines.push(`- [${i.category}${i.task_state === "open" ? ", open" : ""}] ${i.title} (${i.id}): ${truncate(i.summary || i.excerpt, 220)}`);
  lines.push(`Use moth_read_memory for details. When the task is done, call moth_commit_learning.`, `</moth_memory>`);
  return lines.join("\n");
}

export async function runHook(brain: Brain, event: string): Promise<void> {
  const input = await readStdin();
  const started = Date.now();
  try {
    if (event === "user-prompt" || event === "session-start") {
      const query = event === "user-prompt" ? String(input.prompt ?? "") : `${path.basename(String(input.cwd ?? process.cwd()))}`;
      if (query.trim().length < 4) return;
      const pkg = await buildContext(brain.store, brain.search, query.slice(0, 2000), { tokenBudget: 900, maxItems: 6, minScore: 0.28 });
      const text = formatContext(pkg);
      brain.store.logActivity({ kind: "hook", source: "claude_code", action: event, duration_ms: Date.now() - started, detail: { items: pkg.stats.items, project: pkg.project?.name ?? null } });
      if (!text) return;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event === "user-prompt" ? "UserPromptSubmit" : "SessionStart", additionalContext: text } }));
    } else if (event === "session-end") {
      const on = brain.settings.get("sessions.autoHandoff");
      if (!on || !input.transcript_path || !input.session_id) {
        brain.store.logActivity({ kind: "hook", source: "claude_code", action: "session_end", detail: { queued: false, reason: !on ? "automatic handoffs are off" : "no transcript or session id" } });
        return;
      }
      const id = brain.jobs.enqueue("session_handoff", { transcript_path: String(input.transcript_path), session_id: String(input.session_id), cwd: String(input.cwd ?? ""), reason: String(input.reason ?? "") }, { dedupe: `handoff:${input.session_id}`, delayMs: 2000, owner: "sessions", title: "Write session handoff (Claude Code)" });
      brain.store.logActivity({ kind: "hook", source: "claude_code", action: "session_end", detail: { queued: id !== null, job_id: id } });
    } else if (event === "stop") {
      if (input.stop_hook_active) return;
      if (!brain.settings.get("automation.learnFromTranscripts") || !input.transcript_path) {
        brain.store.logActivity({ kind: "hook", source: "claude_code", action: "stop", detail: { queued: false } });
        return;
      }
      brain.jobs.enqueue("transcript_learning", { transcript_path: input.transcript_path, session_id: input.session_id }, { dedupe: `transcript:${input.session_id ?? input.transcript_path}`, delayMs: 3000 });
      brain.store.logActivity({ kind: "hook", source: "claude_code", action: "stop", detail: { queued: true } });
    }
  } catch (e) {
    brain.store.logActivity({ kind: "hook", source: "claude_code", action: event, status: "error", detail: { error: (e as Error).message } });
  }
}
