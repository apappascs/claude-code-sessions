---
name: session-search
description: >-
  Searches Claude Code sessions across all projects by keyword, topic, or content.
  Use when the user wants to find a previous session, locate past work, search for
  something they discussed before, or cannot remember which project a conversation
  was in. Also use when the user says "find that session where" or "search sessions".
---

# Session Search

Search across all Claude Code sessions by keyword or regex.

## Step 1: Run the search

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts search "<query>" --limit 20 --context 1
```

To filter by project:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts search "<query>" --project "<filter>" --limit 20 --context 1
```

To filter by date:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts search "<query>" --since "2026-04-01" --limit 20
```

## Step 2: Present results

The script outputs newline-delimited JSON (one match per line). Group results by session and present:

- **Session ID** and **project** as headers
- **Matching text** with timestamp
- **Context** (lines before/after) if available
- **Resume command**: `claude --resume <session-id>`

If no results, suggest broadening the search or trying different keywords.
