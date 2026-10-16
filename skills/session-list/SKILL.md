---
name: session-list
description: >-
  Lists all Claude Code sessions for a project or globally, sorted by recency,
  size, or duration. Use when the user asks how many sessions they have, wants
  to see recent sessions, says "list sessions", or wants a session inventory.
---

# Session List

List all sessions, optionally filtered by project and sorted.

## Step 1: Run the listing script

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --limit 20 --format json
```

To filter by project:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --project "<filter>" --limit 20 --format json
```

To sort by size or duration instead of recency:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --sort size --limit 20 --format json
```

## Step 2: Present results

The script outputs a JSON array (each entry has a `title`: custom title if set, else auto title; may be null). Present as a markdown table:

| # | Session ID | Title | Project | Date | Messages | Duration | Size |
|---|-----------|-------|---------|------|----------|----------|------|

Highlight the current session if it matches the working directory. Show the resume command: `claude --resume <session-id>`.

If the user asks for more detail on a specific session, use `/session-stats <session-id>`.
