# MOTH

**Follow the light. Remember the journey.**

MOTH is a Windows desktop app that gives Claude a long-term memory and gives you a home for everything you know.
When Claude starts a task it asks MOTH what it already knows; when it finishes, it tells MOTH what changed. MOTH
files that knowledge, connects it, keeps it current and shows it as a living graph (The Mind). Since v0.5.0 MOTH
also holds your own notes: a Markdown editor, a Knowledge Library and a one-time Obsidian importer.

## Install

Download `MOTH_x.y.z_x64-setup.exe` from [Releases](https://github.com/lk5t/moth/releases) and run it. No admin
rights needed. From v0.5.0 on, MOTH updates itself (Settings → Updates); **if you have v0.4.0 or older, install
v0.5.0 by hand once**. On first launch MOTH walks you through:

1. choosing local-only (default) or Google sign-in,
2. optional Anthropic API key for AI-assisted organisation,
3. connecting Claude Desktop and/or Claude Code (one click each),
4. a live test of the MCP server.

## Use it with Claude

After connecting, restart Claude Desktop. Then just work:

> Continue my Roblox game. Fix the inventory system and remember what we changed.

Claude calls `moth_begin_task`, gets the project's decisions, open tasks and past fixes, does the work, then
calls `moth_commit_learning` and `moth_end_task`. At the end of a session it can save a handoff
(`moth_save_handoff`) so the next session resumes where this one stopped. Claude can also search and read your
notes (`moth_search_notes`, `moth_read_note`). Per-app permissions in Connections decide which projects each app may
read or change.

## Knowledge Library and MOTH Notes (v0.5.0)

- **Notes:** Markdown with three views — source (with highlighting), preview, or both side by side. Headings,
  lists, checklists, tables, code blocks, links, images, `#tags` and `[[wikilinks]]`. Autosave (about a second after
  you stop typing) with a visible status; if the same note changed elsewhere, your text is kept and you choose.
  Unsaved text survives a crash as a recoverable draft. History keeps earlier versions (at most one every 10
  minutes of editing, plus before every rename, move or restore) and restoring never loses the newer text.
- **Library:** folders (nested, rename, move; only empty folders can be deleted), collections (groups that don't
  move anything), tags, files, an archive (delete permanently only from there), search across notes and memories.
- **Smart Backlinks:** `[[Note]]`, `[[Note|alias]]`, `[[Folder/Note]]`, `[[Note#Heading]]`, `![[file.png]]` and
  standard Markdown links. Resolution is deterministic (path → title or alias → same folder → same import); when
  several notes match, the link is marked *ambiguous* and never guessed. Renaming or moving a note updates the links
  that point to it. Word-based suggestions are shown separately and never become links unless you click Link.
- **Workspace tabs:** notes, memories, projects and The Mind in tabs, in one or two panes (Ctrl+click opens in the
  second pane; drag tabs between panes). The layout is restored after a restart.
- **The Mind:** notes appear as small rounded squares next to memories; their links are edges.

## Importing an Obsidian vault

Library → *Import Obsidian vault*. It's a **one-time copy**: MOTH only reads the vault (nothing is created, changed,
moved or deleted in it, and no tracking files are written). Notes, folders, tags, frontmatter, aliases, links and
every other file (images, PDFs, 3D models, textures, scripts… any type) come over; `.obsidian`, `.trash` and `.git`
are left out. MOTH previews images, PDFs, audio, video and text; other files are stored and listed under Files.

1. Choose the folder. MOTH scans it in the background and shows real numbers: notes, folders, attachments, total
   size, links, links that point nowhere, notes with the same name, files already imported, and whether there's
   enough disk space.
2. Choose options (keep folders, copy attachments, leave out big files or file types).
3. Import. Progress shows files and bytes actually done. You can keep working, pause, resume or cancel. Quitting is
   safe: the import continues where it stopped (each file's outcome is recorded; nothing is imported twice).
4. Done: counts of notes, folders, files, connected and unresolved links, skipped files and errors, and how long it
   took. Optionally let Cortex (the local AI) read some notes and propose memories; importing never needs it.

**Large vaults:** there is no limit on vault size or file counts. The scan and import use bounded memory (the vault
is never loaded at once; attachments are streamed in 1 MB chunks) and work in batches with durable checkpoints.
Measured: 50,000 notes + 5 GB of attachments (see `docs/benchmarks/`); larger vaults are bounded by disk space and
time, but sizes beyond what's listed there haven't been tested.

**Re-importing / undo:** importing the same vault again skips notes already imported (same file, same content) and
reuses files already copied (same file, same size and date), and adds anything new to the same folder; identical
text in different notes is never merged. *Import history → Undo* removes what an import added but keeps
notes you edited, notes your own notes link to and notes with links you added; files are removed only when no note
uses them.

## Updates

Settings → Updates shows the installed version, checks for updates and installs them. Updates are downloaded from
this repository's Releases and **must be signed**: MOTH checks the signature against the public key built into the
app and refuses anything else. Before installing, MOTH saves your notes and workspace, pauses imports (they resume
after the restart), lets background work finish and makes a backup copy of the database. On Windows MOTH closes
while the installer runs and starts again afterwards.

Release signing (maintainers): the key pair is made with `tauri signer generate`; the public key is in
`src-tauri/tauri.conf.json`, the private key only in the repository secret `TAURI_SIGNING_PRIVATE_KEY` (never in the
code). CI signs the installer, verifies the signature with the public key (and checks that a tampered copy fails),
writes `latest.json` and publishes all three. Without the secret, CI still builds but makes no update files.

## Troubleshooting

- **An import stopped with errors:** open Library → Import history → the import; the files that couldn't be read
  are listed with the reason. Fix or ignore them; everything else was imported.
- **"Not enough free disk space":** leave out large attachments (size limit or file types) or free up space.
- **A link shows as ambiguous:** several notes have that name; write the folder path, e.g. `[[Projects/Notes]]`.
- **"Changed elsewhere" in a note:** choose *Keep mine* or *Use the saved version*; nothing is lost either way
  (earlier versions are in History).
- **Updates say the signature didn't match:** nothing was installed. Download the installer from Releases instead.

## Develop

```bash
npm --prefix core install && npm --prefix core test      # engine, MCP, API, library and import tests
node --experimental-transform-types core/scripts/bench.ts 100 1000 10000         # engine benchmark
node --experimental-transform-types core/scripts/vault-bench.ts 20000 1024       # large-vault import benchmark
npm --prefix core run serve                               # engine + UI in a browser (after building app/)
npm --prefix app install && npm --prefix app run dev      # UI dev server
npm install && npm run build                              # full Windows build (on Windows)
```

The GitHub Actions workflow builds and tests everything on Linux and Windows (including real local-AI tests),
produces the installer, installs it on a clean Windows runner and checks that it starts, and signs and verifies the
update files. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, data model, security and known limitations.
