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

## Cortex (v0.2): MOTH's own local intelligence

```
 Claude ──moth_learn / moth_analyze_information / moth_get_intelligent_context──▶ MCP process
                                         │ (enqueues a job; never runs a model)
                                         ▼
 moth-core "serve" (desktop app engine) ── job worker ──▶ Cortex
   Cortex: Understand → Recall → Compare → Propose ──▶ IntelligenceRouter
                                                      ├─ LocalModelProvider ──HTTP 127.0.0.1──▶ llama-server (llama.cpp, GGUF)
                                                      └─ CloudModelProvider (Anthropic; only if configured + consented + allowed)
           Validate (deterministic code) ──▶ apply (versioned, reversible)  or  review_queue (user decides)
```

* **Runtime**: llama.cpp `llama-server`, pinned build `b11829` (CPU or Vulkan), downloaded by MOTH on first
  use from the official GitHub release and verified by SHA-256 (`core/src/cortex/manifest.ts`; values read
  by the `Discover runtime and model facts` workflow, not typed by hand).
* **Models**: Qwen2.5 Instruct GGUF Q4_K_M — 0.5B / 1.5B (Apache-2.0) / 3B (Qwen research licence),
  from Qwen's official Hugging Face repos, SHA-256 verified, resumable downloads. Recommended by RAM.
* **On demand**: nothing is loaded at start-up. The first AI task starts `llama-server` on a free
  127.0.0.1 port; it unloads after `cortex.idleTimeoutMin` (default 5) idle minutes. Requests are
  serialised, cancellable, and a crashed runtime is restarted on the next request (gives up after 3
  consecutive crashes). A runtime orphaned by a crashed engine is found via its pid/port record and stopped.
* **Why not in Rust**: the memory engine (database, validation, versioning) lives in the TypeScript
  sidecar; Cortex sits next to it so every model proposal passes the same deterministic checks as every
  other write. Inference runs in a separate process (llama-server) and never touches the database:
  the model only returns JSON constrained by a schema; it cannot run SQL or commands.
* **Balanced autonomy** (`core/src/cortex/validator.ts`): new sourced memories, non-conflicting additions,
  well-supported links and "already known" confirmations are applied; replacing facts, contradictions,
  likely duplicates, low confidence, inconsistent reasoning and anything touching text you wrote go to the
  **review queue**. Nothing is ever deleted automatically. Every applied change keeps the previous version
  and an undo recipe.
* **Learning without retraining**: approvals, rejections and undos are stored in `feedback` and shown to
  the model as examples for similar future decisions; `retrieval_feedback` (from `moth_end_task` or the UI)
  nudges search ranking by at most ±0.04. Model weights never change (no fine-tuning in this version).
* **Cloud**: Anthropic is implemented as the fallback provider but is off until you enable cloud fallback,
  add a key and accept the data disclosure; projects can be marked local-only.

### Tests

* `core/test/cortex.mock.test.ts` — **mocked** (fake llama-server): lifecycle, idle unload, crash recovery,
  cancellation, retries, validator, review/feedback, downloads + extraction, MCP queueing. Proves plumbing only.
* `core/test-real/cortex.real.test.ts` — **real** llama.cpp + Qwen2.5 1.5B, installed through MOTH's own
  installer, running the inventory 6 → 10 slots acceptance scenario. Runs in CI on Linux and Windows
  (`Real local AI` jobs); evidence is published as a job annotation.

## v0.2.5 — First Flight & Adaptation

### Data (migration v3, additive)
- `memories` gain `memory_type` (episodic, semantic, procedural, project, preference, research, lesson), `scope` (global/project/private), `pinned`, `domain`, `evidence` (sourced/unsourced/speculative). Existing rows are backfilled from their category.
- `projects` gain `transfer_enabled` and `private`.
- New tables: `memory_sources` (provenance: URL, title, publisher, dates, excerpt — stored exactly as submitted), `preference_meta` + `preference_evidence` (Adaptation profile), `lesson_meta`, `transfer_suggestions`, `inbox_files` (Claude Inbox de-duplication). `review_queue` gains `kind`, `deferred_until`, `affected_ids`, `sources`.
- Settings changes now appear in the change feed, so the tray and every window stay in sync.

### Engine modules
- `engine/adaptation.ts` — preferences (explicit = confirmed; inferred = tentative until seen `adaptation.inferAfter` times and confirmed by the user in the Review Queue; never promoted automatically), relevance-ranked retrieval per task with scope rules, research memory with provenance (claims of evidence without sources go to review; speculation is labelled; URLs are never invented), lessons from verified corrections, knowledge transfer (research/lessons/procedures only, never private projects or other projects' decisions).
- `engine/review.ts` — the unified Memory Inbox (approve / edit / reject / defer) dispatching by kind or handler; rejections are recorded as feedback.
- `engine/folders.ts` — Claude Inbox folder (any Claude can drop .md/.txt/.json files; imported, then moved to `Imported/`, never deleted), vault sync, MD/TXT/JSON file import with content-hash de-duplication.
- `api/pulse.ts` — MOTH Pulse and the filtered Memory Timeline, computed from the audit trail.
- Brain: Privacy Mode and "learning paused" hold automatic jobs in the queue (they never resume by themselves), resource profiles (Eco/Balanced/Performance change model idle unload and when maintenance runs), Sleep Cycle scheduling (idle / after a Claude session / manual) using Windows idle time and power state reported by the shell, CPU-load deferral, notifications with levels, integrity-checked backups with a configurable folder and retention, and a graceful shutdown that drains the job queue, unloads the model and checkpoints the database.

### MCP (24 tools)
New: `moth_record_preference`, `moth_get_preferences`, `moth_submit_research`, `moth_record_lesson`, `moth_get_project_insights`. `moth_begin_task` now also returns `preferences` and `knowledge_transfer`.

### What is automatic, and what isn't
MOTH cannot observe Claude conversations. It learns from (a) MCP tool calls Claude makes, (b) Claude Code hooks (optional), (c) files placed in the Claude Inbox folder, (d) what the user enters (Quick Capture, editing). Organising, linking, backups and Sleep Cycles are automatic.

### Desktop shell
Tray menu: Open MOTH, Open The Mind, Open Cortex, Quick Capture, Pause/Resume Learning, Privacy Mode, Settings, Restart memory engine, Quit MOTH Completely. Close hides to the tray when enabled; double-click restores. Global Quick Capture shortcut (default Ctrl+Alt+M, configurable) opens a small always-on-top window. "Start with Windows" starts minimised without loading the model. Quit asks the engine to stop cleanly and only force-stops it after 15 s.

## v0.2.6 — Awakening (visual update)

- **The Mind renderer** (`app/src/graph/GraphCanvas.tsx`, Canvas 2D + d3-force/d3-zoom): soft-white nodes; glow drawn from two cached radial-gradient sprites (white, lavender) with additive blending — no shadowBlur or full-screen blur. Every visual state (hover, selection, neighbours, dimming, size boost, labels) is an eased per-node/per-edge value. Ordinary edges are drawn in one batched path; only highlighted/new edges are drawn individually. Hit testing uses a d3 quadtree rebuilt only when positions change. A canvas tooltip shows the hovered memory's title.
- **Physics:** link/charge/collision forces plus a pull toward a per-project anchor (golden-angle layout derived from real project membership); cross-project links pull less; more damping (`velocityDecay 0.52`); repulsion scales gently with graph size; dragged nodes are released to settle naturally (saved pins still honoured); positions persist; new nodes enter next to a connected neighbour or their project.
- **Living graph:** the change feed drives `markNew` (fade + scale in + local light), `markNewLinks` (edge reveal + a pulse travelling along it), `pulse` (updated memory) and a "N memories learned" notice. All triggered by real database rows.
- **Idle cost:** no redraws when nothing changes (measured 0 redraws in 3 s idle), nothing while the page is hidden; the optional shimmer runs at 12 fps only in the "Full" motion level.
- **Motion level** (`appearance.motion`: Automatic/Full/Balanced/Minimal; Automatic follows Windows' reduce-animations setting).
- **Startup:** inline SVG/CSS splash in `index.html` (light → moth unfolds → motes → fade), dismissed by `lib/splash.ts` as soon as the app is ready (never delays it), with a calm "waking up" state if the engine is slow; skipped for the Quick Capture window.
- **Cortex activity** (`components/CortexPulse.tsx`): wing-beat indicator only while the runtime/queue/install is really busy; real install progress; done/error states.

## v0.3.0 — The Mind 2.0: Living Atmosphere

- **Layers** (bottom → top, all under `GraphCanvas`): the container's CSS background image is the static
  backdrop (`graph/atmosphere.ts`: charcoal `#0E0E13`, three faint radial lights, vignette, 4 % grain tile —
  painted once per size, never per frame); a transparent particle canvas (36–140 motes by area, very slow drift,
  parallax with the camera, dirty-rectangle redraws, 12 fps Balanced / 24 fps Full, half rate when the window
  isn't focused); a cluster-region canvas; a "breathing" canvas; the graph canvas (transparent). All decorative
  layers have `pointer-events: none`.
- **Clusters** = real projects with ≥ 3 visible memories. Centre = mean position, radius = 85th-percentile
  distance × 1.12 + 26 (outliers don't inflate it); targets are recomputed only when positions change and eased
  (~240 ms). Regions are painted on their own layer only when they change; during camera moves that layer is
  moved with a CSS transform and repainted 140 ms after the camera stops; dimming on focus is a CSS opacity
  change. Names are drawn in screen space, fade as memory labels take over, and are clickable (glide to the
  cluster + soft boundary ring).
- **Nodes:** cores are white / grey / muted lavender by importance (`coreColor`); "core" memories (starred,
  project hubs, importance ≥ 0.85) carry a little more steady light. The *varying* part of breathing (core
  memories, the selected memory) and the light flowing along the selected memory's connections are drawn on the
  breathing layer at 10 fps (20 in Full), so idle frames never redraw the whole graph (measured 0 graph redraws
  while idle).
- **Camera:** eased wheel zoom anchored at the pointer (falls back to direct steps automatically if this machine
  redraws slower than ~35 fps), eased focus/fit; any user gesture cancels a running glide.
- **Real events only:** create → fade/scale-in + light; link → edge reveal + pulse; update → pulse; cluster
  change → eased region transition. Driven by the change feed, as in v0.2.6.
- **Settings:** `appearance.ambient` (Settings → General → "Living atmosphere in The Mind", default on). Off, or
  motion Minimal / Windows "reduce animations": nothing drifts or breathes (measured 0 redraws while idle).
- **Smoothness check:** The Mind → graph settings → "Check smoothness" moves the view, zooms and hovers by itself
  and reports real frames per second on the current computer (`GraphHandle.measure`).
