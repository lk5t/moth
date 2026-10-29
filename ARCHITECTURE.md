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

## v0.4.0 — Consciousness (proactive intelligence on stored knowledge)

Nothing in v0.4.0 is sentient or watches conversations. Every feature below works on what is stored in MOTH's
database, and every result points back at the stored records it came from.

### Database migrations (automatic, keep all existing data)
- **v4 `intelligence_foundation`:** `jobs` rebuilt (SQLite can't change a CHECK constraint in place; every row is
  copied) with the states `pending, running, done, failed, cancelled, interrupted, awaiting_approval`, plus owner,
  scope, title, time limit and timestamps; `job_steps` (checkpoints); `permissions`; `findings`.
- **v5 `project_state`:** `project_items` (objective / unresolved decision / blocker / milestone), `handoffs` and
  `handoff_versions`. Triggers feed the change feed (`project_item`, `handoff`) and the project's last activity.
- Decisions, tasks, research and lessons remain memories; project items hold only what memories didn't capture.

### Durable jobs (`engine/jobs.ts`)
- Every background task is a row. Restart recovery: jobs that were running when MOTH stopped become
  `interrupted`; only kinds registered as resumable are re-queued automatically, and they continue from their
  last checkpoint (`ctx.step(key, fn)` stores each finished step in `job_steps`, so a step never runs twice).
- Cancellation passes an `AbortSignal` down to the local model request. A `permission_denied` error fails the job
  immediately (no retries). `awaitingApproval(result)` parks a job in `awaiting_approval` until every review it
  created is decided (database trigger).
- Held work: intelligence jobs wait while Privacy Mode or Pause Learning is on; background-scope work also waits
  while the computer is busy, on battery with the Eco profile, or when background intelligence is off.
- No progress percentages are shown anywhere: the UI shows the real state, the running time and the result.

### Permissions (`intelligence/permissions.ts`)
- Subjects: `background`, `agent:<id>` (automated) and `client:<app>` (connected apps; the name without version,
  e.g. `client:claude-ai`, `client:claude-code`).
- Automated subjects: read memories / read project data / create analysis / propose changes / apply safe changes
  (all default on); read approved folders, internet (default off); **change important knowledge and external
  tools can never be granted** (they always go through the review queue). Private projects are excluded from
  automated work unless allowed per project.
- Connected apps: read memories, read project data, save and change memories (default on), with per-project
  exceptions. Resolution order: project rule → general rule → default. Every denial is written to the activity log.
- Enforced in the engine, not the UI: every agent/background action calls `assert()`; every MCP tool call goes
  through `mcp/access.ts` (below).

### MCP (`mcp/server.ts`, 30 tools)
- New tools: `moth_save_handoff`, `moth_get_latest_handoff`, `moth_list_handoffs`, `moth_resume_project`,
  `moth_record_project_item`, `moth_resolve_project_item`.
- `ClientAccess` (per call): before the tool runs, reading needs `read_memories` and changing needs
  `write_memories` — globally, for the project the tool names, and for the project of every memory id passed in.
  After it runs, memories and projects the app may not read are removed wherever they appear in the result, and
  the result carries `withheld: {count, note}`. A single requested memory the app may not read is a
  `permission_denied` error rather than an empty answer.
- Handoff saves are idempotent (client + session id, or an explicit key): unchanged content is reported as
  `unchanged`, changed content becomes a new version (earlier versions kept). References to memories that don't
  exist are rejected.

### Supported vs unsupported client automation (honest)
- **Claude Code:** the documented `SessionEnd` hook (fields `session_id`, `transcript_path`, `cwd`) can queue an
  automatic handoff job — only when Settings → "Write a handoff when a Claude Code session ends" is on, Privacy Mode
  is off and the local model is ready. The hook only enqueues (it must return within its time budget); the job
  reads the transcript file locally and writes the handoff with the local model, marked `source: hook`,
  confidence 0.6. The `UserPromptSubmit` hook adds relevant memories before each prompt (unchanged from v0.2).
- **Claude Desktop:** has no lifecycle hooks. Handoffs happen only when Claude calls `moth_save_handoff` (the server
  instructions ask it to at the end of a session) or when you write one in Projects. MOTH cannot observe Desktop
  conversations and doesn't claim to.
- MOTH never claims context reached Claude unless a tool call or hook actually returned it (visible in Connections →
  recent tool calls).

### Findings (`intelligence/findings.ts`)
- One table for awareness, health, discovery and agent results. Each finding has a fingerprint (what it is about)
  and an evidence hash (memory ids @ version + extra facts). No duplicate active findings; a dismissed finding
  stays dismissed until its evidence changes; `reconcile()` resolves findings a complete scan no longer detects,
  with the reason recorded. Findings must cite existing memories or projects (or be marked `system`, e.g. the
  search index).

### Intelligence modules
- **Project Intelligence** (`projects.ts`): project state, progress only from milestones or tasks (otherwise
  "unknown", never a guess), deterministic resume (last completed, decisions, unresolved, helpful research with
  the reason it's included, and a next step chosen from: latest handoff → oldest blocker → oldest unresolved
  decision → oldest open task).
- **Awareness** (`awareness.ts`): unresolved decisions, blockers, unfinished work, knowledge gaps, research to
  review, relevant lessons, conflicting requirements. Runs when the knowledge change mark moves (no idle loop).
- **Knowledge Health** (`health.ts`): 11 checks. Automatic repairs only for derived data that can always be
  recreated (search index rebuild, similarity vectors), each logged as `health_repair`; everything else is a
  proposal in the review queue. The possible-duplicates check is incremental: after a complete pass, only
  memories created or edited since then are compared (a full pass runs weekly).
- **Discovery** (`discovery.ts`, quiet mode): cross-project knowledge, stored knowledge that may answer an open
  question, independent support for decisions. Candidates come from the full-text index using each memory's most
  distinctive words (`SearchEngine.candidates`), then word-vector similarity and shared words. Confidence =
  `min(0.95, 0.25 + 0.55·clamp((sim−0.2)/0.5) + 0.05·min(4, shared words))`; the threshold rises for categories you
  keep dismissing. At most `discovery.maxPerKind` (30) are stored per kind, most confident first, and at most 3 per
  memory. Confirming creates a real relationship with provenance.
- **Agents** (`agents.ts`): Research Analyst, Memory Curator, Project Analyst, Knowledge Connector — jobs owned by
  `agent:<id>` on the same queue and the same local model (one job at a time). Model output is schema-validated
  and checked against the stored text (quotes must exist verbatim, citations only from the note's own sources);
  consequential changes wait in the review queue.
- Long scans hand control back to the event loop at least every ~30 ms so the app stays responsive.

### The Mind 3.0 (`mindtime.ts`, `GraphCanvas`, `pages/MindLenses.tsx`)
- **Paths:** breadth-first search over stored active relationships (≤ 6 hops); each step shows the stored
  relationship, its direction and reason. No path → "MOTH doesn't invent one".
- **History:** the graph at a past moment is rebuilt from `memory_versions` (title and status as they were),
  relationship creation times, and removed relationships restored from their `unlinked` events. Steps are only the
  days on which something changed. Permanently deleted memories can't be shown.
- **Suggestions** (dashed, never part of the layout) come from active discoveries; **attention** rings from active
  awareness findings. Both are off unless toggled.

### MOTH Connect and Pulse 2.0
- Client states come from evidence only: configuration files, recorded MCP sessions (live process / recent HTTP),
  logged tool calls and the last self-test → connected, disconnected, error, authorization required, configured,
  restart required, not configured — each with the evidence lines shown in Connections.
- Diagnostics start MOTH's MCP server like a client and run real tool calls: tool discovery, a tool invocation,
  memory retrieval (search), handoff retrieval, and error handling (a missing memory must return `not_found`).
- `pulse.intelligence`: counts are plain SQL (active projects, unresolved decisions, pending reviews, discoveries
  ≥ 75 % confidence, blockers, awareness items, health issues); feeds list stored findings, agent jobs and the
  per-project resume.

### Performance
- `core/scripts/bench.ts` measures the real engine on generated data at any size (build, startup, search, graph,
  Pulse, Mind queries, scans, agents, memory, idle CPU). Results for v0.4.0 are in `docs/benchmarks/` and the
  release notes; CI runs it on Windows (100 and 1,000 memories) and publishes the numbers as annotations.

## v0.5.0 — Vault (Knowledge Library, notes, Obsidian import, workspace, updater)

### Where things live (actual architecture)
- The persistence and filesystem work runs in the **engine** (`core/`, TypeScript on Node 22, `node:sqlite`), which is
  MOTH's backend process. The Rust/Tauri shell only hosts the window, tray, single instance, native dialogs and now
  the updater. The UI never touches the filesystem: it calls narrowly scoped engine RPCs (`library.*`, `docs.*`,
  `import.*`, `workspace.*`, `collections.*`); attachments are served read-only by `GET /api/attachments/:id`
  (token-checked, only from MOTH's attachments folder, `nosniff`, sandbox CSP).
- `core/src/vault/markdown.ts` (parsing), `library.ts` (notes, folders, links, revisions, attachments, collections,
  workspace), `importer.ts` (scan / import / undo). UI: `pages/Library.tsx`, `components/NoteEditor.tsx`,
  `Workspace.tsx`, `ImportWizard.tsx`, `lib/docstore.ts`, `lib/markdown.ts`, `lib/updater.ts`, `components/Updates.tsx`.

### Migration v6 `vault`
- New tables: `folders`, `documents` (+ `documents_fts`), `document_tags`, `document_aliases`, `document_revisions`,
  `document_links`, `document_positions`, `collections`, `collection_items`, `attachments`, `attachment_refs`,
  `import_batches`, `import_items`, `import_link_targets`, `workspace_sessions`. Nothing existing is changed.
- **Before any migration of an existing database, a consistent copy is written** (`backups/before-schema-vN-*.db`,
  `VACUUM INTO`); each migration runs in one transaction. Tested by turning a real database into the exact v0.4.0
  schema (all v6 objects removed) and upgrading it.
- Change-feed rows for documents are written by the library (one per edit, one per import batch), not per-row
  triggers, so a 50,000-note import doesn't flood the live UI.
- Query plans: SQLite has no statistics on a fresh database and would otherwise pick the (user, status) index;
  hot lookups (title, alias, path, imported hash) use `INDEXED BY` so link resolution and duplicate checks stay O(log n).

### Documents vs memories
A document (note) is the user's own text, stored verbatim (frontmatter and unknown syntax included). A memory is a
fact MOTH or Claude extracted. They stay separate entities; they connect through links (`[[memory:id]]` or a link
added by hand), through Cortex provenance (`source_ref = document:<id>`), and in search and The Mind.

### Notes and saving
- Saves carry `base_version`; a save based on an older version is refused with code `conflict` (no stale overwrite).
- Revisions: the previous state is kept at most every 10 minutes of editing, and always before rename, move, restore
  and link rewrites. Restoring snapshots the current text first.
- UI (`docstore`): one shared state per open note for all panes; debounced autosave (0.9 s); saves for one note
  never overlap; drafts kept in browser storage until a save succeeds (offered back after a crash); flush on tab
  switch, tab close, blur, hiding the window and before updates.
- Rendering: `marked` → DOMPurify (no scripts, handlers, iframes, forms, inline SVG/MathML, styles); only http(s),
  mailto, data images and MOTH attachment URLs survive; remote images are not loaded; links never navigate the app.

### Smart Backlinks (deterministic resolution)
1. Path links (`Folder/Note`, `./Note`, `../x/Note`, `Note.md`) → the note at that path (vault-relative for imported
   notes, folder path otherwise). 2. Names → title or alias. One match → resolved. Several → same folder as the
   linking note, then same import; still several → **ambiguous** (candidates stored), never a guess. 3. Not a note →
   attachment by file name. Unsafe schemes are recorded as `unsafe`, web links as `external`.
- Creating, renaming, archiving or restoring a note re-resolves the links that name it. Rename and move capture the
  incoming links first and rewrite exactly those (in MOTH's copies only), so a rename never redirects links to a
  different note with the old name; links that still find it through an alias are left as written.
- Manual links (note → note / memory) are kept when the text is re-parsed.

### Obsidian import (one-time, read-only source)
- Scan: iterative directory walk (no recursion depth limit, symlinks not followed), manifest rows written in batches
  of 500 (`import_items`), link targets and aliases recorded (`import_link_targets`); notes read one at a time,
  attachments only measured. Preview numbers are SQL over the manifest. Disk space via `statfs`.
- Import: a chain of background jobs, each working about a minute (so other jobs can run in between and a crash loses
  at most one batch): notes in transactions of 100 with their manifest rows, then attachments streamed (hash + copy in
  one pass, 1 MB chunks) into `attachments/<hash[0:2]>/<hash><ext>` (stored once per content; each name keeps its
  own entry), then link resolution across the whole vault, then links in existing notes that now resolve.
- Pause = cancel the current job and keep state; resume = enqueue again; restart recovery = the resumable job kind is
  re-queued and continues with the rows still `pending`. Idempotent: finished rows are skipped.
- Duplicates: a *confirmed* duplicate is the same vault-relative path with the same content from an earlier import
  (skipped by default, or imported separately on request). Same text elsewhere is never merged.
- Undo: removes the import's notes except those edited after the import, those linked from notes outside the import
  and those with user-made links; attachments only when no note uses them; empty import folders deepest-first.
- Tests compare the vault's full manifest (path, size, mtime, sha256) before and after; the vault is made read-only
  for the test where the OS enforces it.

### Workspace
`workspace_sessions` stores `{ panes: [{ tabs: [{ key, kind, id, title, mode }], active }], focus }` (≤ 2 panes).
On restore, tabs whose record no longer exists are dropped with a notice (`workspace.resolve`).

### Updater (Tauri 2 official plugin)
- `tauri-plugin-updater` + `tauri-plugin-process`; `plugins.updater.pubkey` (minisign public key), endpoint
  `https://github.com/lk5t/moth/releases/latest/download/latest.json`, `windows.installMode = passive`;
  `bundle.createUpdaterArtifacts = true`; capabilities `updater:default`, `process:allow-restart`.
- Flow (`lib/updater.ts`): check → notice ("MOTH Update Available": installed → available, notes, Update now /
  Later) → download with real byte progress (signature verified by the plugin) → `flushAll()` → engine
  `system.prepareUpdate` (pause imports and remember them, drain the job queue, WAL checkpoint, backup copy) →
  install (Windows: the app exits; the NSIS hook stops `moth-core.exe`) → relaunch → imports resume. If the install
  doesn't happen, `system.resumeAfterUpdateAttempt` restarts background work.
- CI: builds with `TAURI_SIGNING_PRIVATE_KEY` (secret), verifies the `.sig` with the public key from the config
  (Ed25519 over BLAKE2b-512 + trusted-comment signature) and checks that a tampered copy fails, writes `latest.json`
  only after that, and publishes installer, signature and manifest together.
- Not verified yet: an end-to-end in-place update from one installed signed version to the next (needs two published
  signed versions; the first possible test is v0.5.0 → v0.5.1).

### v0.5.1 — every file type, re-import adds what's missing
- Every non-Markdown file in a vault is imported as an attachment, whatever its type (v0.5.0 skipped types it couldn't
  preview, e.g. 3D models). Served with `nosniff`, a sandbox CSP and `attachment` disposition unless it's a previewable
  type, as before.
- Re-importing the same vault folder (same `source_root`): files an earlier import copied are recognised from its
  manifest (same vault path, size and modification time, stored copy still present) and marked `duplicate` instead of
  being read and copied again; new files go into the earlier import's root folder; notes are matched as before (path +
  content). After the import, notes outside the import that have unresolved or ambiguous links are indexed again, so
  their links find the new notes **and files**. Undo of the second import removes only files it added that no note uses.
