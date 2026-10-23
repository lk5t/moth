# MOTH architecture

> Follow the light. Remember the journey.

MOTH is a Windows desktop app that gives Claude a private, persistent, self-organising memory through the
Model Context Protocol (MCP).

```
 ┌───────────────────────────── MOTH.exe (Tauri 2, Rust) ─────────────────────────────┐
 │  native window (custom title bar) · tray · autostart · notifications · single     │
 │  instance · Windows Credential Manager · supervises + restarts the sidecar         │
 │                                                                                    │
 │   React UI (WebView2) ──HTTP JSON-RPC + SSE (127.0.0.1, random token)──┐           │
 └──────────────────────────────────────────────────────────────────────────┼──────────┘
                                                                            ▼
 ┌──────────────── moth-core.exe "serve" (Node 22 single executable) ────────────────┐
 │  Brain: MemoryStore · SearchEngine · LearningEngine · Metamorphosis · JobQueue    │
 │  Local API (UI) · optional Streamable HTTP MCP (127.0.0.1 + bearer token)         │
 └───────────────────────────────────────┬────────────────────────────────────────────┘
                                         │  same SQLite file (WAL, busy timeout)
 ┌───────────── moth-core.exe "mcp" (launched by Claude Desktop / Claude Code) ───────┐
 │  official MCP TypeScript SDK, stdio transport, 15 moth_* tools                     │
 └────────────────────────────────────────────────────────────────────────────────────┘
               %APPDATA%\MOTH\moth.db   (+ backups\, exports\, logs\)
```

## Why this split

* **One engine, one language.** The memory engine, the MCP server and the UI API are the same TypeScript code,
  so what Claude sees through MCP and what you see in the app can't drift apart.
* **No native modules.** SQLite comes from Node's built-in `node:sqlite` (SQLite 3.50 with FTS5). The engine is
  packaged as a Node *single executable application* and shipped as a Tauri sidecar: nothing to install, no
  database server.
* **Thin Rust shell.** Rust handles only what must be native: window, tray, autostart, notifications, the
  credential vault and supervising the engine (crash → automatic restart with backoff).
* **Every process writes the same database.** Triggers append every change to `db_changes`; the app streams
  that feed to the UI over Server-Sent Events, so a memory created by Claude through MCP appears in The Mind
  within a second, whichever process wrote it.

## Data model (SQLite, see `core/src/db/migrations.ts`)

| table | purpose |
|---|---|
| `users` | local profile + optional Google accounts (all queries are scoped by user) |
| `memories` | id, title, content, summary, category, tags, source, source_ref, source_timestamp, project, importance, confidence, verification, embedding_ref, status (active/archived/superseded/merged), version, manual_lock, task_state, flags |
| `memory_versions` | full snapshot per version, who changed it and why |
| `memory_relationships` | typed edges (RELATED_TO, BELONGS_TO, DEPENDS_ON, SOLVES, CAUSED_BY, REFERENCES, SUPERSEDES, CONTINUES), each with a required reason |
| `projects`, `project_memories` | projects with a hub memory, status, goals, files, aliases |
| `memory_embeddings` | float32 vectors per (memory, model); local vectors always, remote ones optional |
| `tasks` | Claude work sessions (`moth_begin_task` → `moth_end_task`) |
| `learning_events` | every change with description, reason, actor and an **undo recipe** |
| `activity_logs` | real MCP calls, AI calls, hooks, system events |
| `settings`, `integrations`, `jobs`, `node_positions`, `mcp_clients`, `db_changes`, `memories_fts` | config, connected services, background queue, graph layout, MCP sessions, change feed, FTS5 index |

## Memory pipeline

`moth_commit_learning` → **extract** candidates (items, decisions, errors + fixes, unfinished, completed) →
**search** similar existing memories → **compare** → **decide** per candidate:
create / append / reinforce / supersede / skip (built-in rules offline; Claude via the Anthropic API when
the user enables it, validated against the candidate list) → **apply** in one transaction → link fixes to
errors (SOLVES), discover related memories (shared-topic evidence required) → close completed tasks →
update the project (progress log, status, files) → record a learning event.

Memories the user wrote or corrected are **locked**: automation may append, never overwrite. Conflicting
new information is stored alongside and both are flagged for review.

## Retrieval

Hybrid score = semantic (0.36) + keyword BM25 (0.27) + project (0.10) + graph proximity (0.09) +
importance (0.08) + recency (0.06) + confidence (0.04), with a textual-relevance floor, a minimum score
and a token budget. Project detection uses names, aliases, descriptions and the hub memory; other
projects' memories are excluded unless very strong matches.

## Metamorphosis (background)

Persistent job queue (atomic claiming, dedupe keys, exponential retry, cancellation, crash recovery).
Every reflection: merge near-identical memories (configurable threshold), flag close duplicates for
review, flag contradictions (heuristic, confirmed by AI when enabled), add missing connections, file loose
notes into the project they name, flag stale tasks, fill/improve summaries, optimise the FTS index.
Daily automatic backups (`VACUUM INTO`), kept 10. A damaged database is detected on start and restored
from the newest healthy backup automatically.

## Security

* Engine API on 127.0.0.1 only, random token per launch, Host and Origin checks.
* HTTP MCP endpoint off by default; when on: 127.0.0.1, bearer token (timing-safe compare), Host/Origin checks.
* API keys live in Windows Credential Manager; the UI can write them but not read them back.
* Secrets in incoming text are redacted before storage; instruction-like text is flagged and down-ranked;
  every context package tells Claude that memories are data, not instructions.
* MCP permissions (read / write / merge / archive / delete) are checked on every call; permanent deletion
  is off by default and also requires `user_requested: true`.
* External AI processing requires explicit consent, is rate-limited and every call is logged.

## Honest limitations

* MCP is pull-based: Claude decides when to call tools. MOTH's server instructions, the Claude Code hooks
  and an optional CLAUDE.md snippet make it reliable, but no client is forced to call MOTH, and MOTH never
  sees conversations it isn't given. Claude.ai web/mobile can't launch local MCP servers.
* The built-in embeddings are lexical (shared words and word forms). For meaning-level matching, point
  MOTH at an embedding model (Ollama/llama.cpp/OpenAI-compatible or Voyage).
* Google sign-in and Drive/Gmail/Calendar import need your own Google OAuth client ID.
