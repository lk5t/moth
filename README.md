# MOTH

**Follow the light. Remember the journey.**

MOTH is a Windows desktop app that gives Claude a long-term memory. When Claude starts a task it asks MOTH
what it already knows; when it finishes, it tells MOTH what changed. MOTH files that knowledge, connects it,
keeps it current and shows it as an Obsidian-style graph.

## Install

Download `MOTH_x.y.z_x64-setup.exe` from the latest build (Actions → *Build MOTH* → artifact, or Releases)
and run it. No admin rights needed. On first launch MOTH walks you through:

1. choosing local-only (default) or Google sign-in,
2. optional Anthropic API key for AI-assisted organisation,
3. connecting Claude Desktop and/or Claude Code (one click each),
4. a live test of the MCP server.

## Use it with Claude

After connecting, restart Claude Desktop. Then just work:

> Continue my Roblox game. Fix the inventory system and remember what we changed.

Claude calls `moth_begin_task`, gets the project's decisions, open tasks and past fixes, does the work, then
calls `moth_commit_learning` and `moth_end_task`. Watch it happen live in **The Mind** and **Metamorphosis**.

Tools: `moth_begin_task`, `moth_search_memories`, `moth_read_memory`, `moth_read_related`,
`moth_create_memory`, `moth_append_memory`, `moth_update_memory`, `moth_remove_memory`,
`moth_merge_memories`, `moth_link_memories`, `moth_get_project_context`, `moth_get_relevant_context`,
`moth_commit_learning`, `moth_end_task`, `moth_get_brain_status`.

## Develop

```bash
npm --prefix core install && npm --prefix core test      # engine, MCP, API tests
npm --prefix core run serve                               # engine + UI in a browser (after building app/)
npm --prefix app install && npm --prefix app run dev      # UI dev server
npm install && npm run build                              # full Windows build (on Windows)
```

The GitHub Actions workflow builds and tests everything on Windows, produces the installer, installs it on
the runner and checks that the app starts the engine and creates the brain.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, data model, security and known limitations.
