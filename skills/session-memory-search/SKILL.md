---
name: session-memory-search
description: >-
  Searches across all Claude Code memory file contents by keyword.
  Use when the user asks to find something in their memories, search stored
  knowledge, or locate a specific memory by content rather than name.
  Also triggered by: "search memories for", "find in memories", "which memory mentions".
---

## Step 1: Run the search

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/memory-scanner.ts search "<query>" --limit 20 --context 1
```

Replace `<query>` with the user's search term. Add filters based on request:
- `--type user|feedback|project|reference` — filter by memory type
- `--project FILTER` — filter by project name
- `--context N` — lines of context around each match (default 1)
- `--limit N` — max results (default 20)

## Step 2: Present the results

Output is NDJSON (one JSON object per line). Parse each line and **group results by project**.

**For each project with matches:**

**Project: project-name**

| File | Type | Line | Match |
|------|------|------|-------|
| filename.md | type | N | matched text (trimmed) |

Show context lines (if available) indented below each match.

**If no results:** Suggest broadening the search or trying alternative keywords.

## Step 3: Offer actions

For each matched memory file, the user might want to:
- Read the full file — use the Read tool on the `path` field
- Edit the memory — use the Edit tool on the `path` field
- Check health — suggest `/session-memory-audit`
