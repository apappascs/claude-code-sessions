---
name: session-search
description: >-
  Searches Claude Code sessions across all projects by keyword, topic, or content.
  Use when the user wants to find a previous session, locate past work, search for
  something they discussed before, or cannot remember which project a conversation
  was in. Also use when the user says "find that session where" or "search sessions".
---

# Session Search

Search across all Claude Code sessions by keyword. The query is matched (case-insensitive, literal) against
message text **and** session titles: the user-set name (`customTitle`, e.g. from `/rename`) and the
auto-generated name (`aiTitle`). Searching a session's name therefore finds it. Earlier names also match: every
distinct title the session ever had is searched, so an old `/rename` name or the auto title still finds a renamed
session. The row then shows the current title (`title`) alongside the title that matched (`match`).

Title matches are listed first (custom-title matches, then ai-title matches), followed by message matches in scan
order. `--limit` applies after that ordering, so a session found by name is never cut off by message hits elsewhere.

## Step 1: Run the search

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts search "<query>" --limit 20 --context 1 --format json
```

To filter by project:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts search "<query>" --project "<filter>" --limit 20 --context 1 --format json
```

To filter by date:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts search "<query>" --since "2026-04-01" --limit 20 --format json
```

Date filters (`--since`/`--until`): title rows are kept when the session's first-to-last timestamp span overlaps the
window (unlike `list`, which uses last activity); as in `list`, sessions with no parseable timestamp are dropped when
a date filter is set. Message rows without a timestamp are not filtered.

## Step 2: Present results

The script outputs newline-delimited JSON (one match per line, title matches first). Group results by session and present:

- **Session ID**, **project**, and **title** (`title`: custom title if set, else auto title; may be null) as headers
- **Matching text** with timestamp. Rows with `"match_type": "title"` are title matches: `type` is
  `custom-title` or `ai-title` and `match` is the title value that matched (a custom-title match is preferred over
  an ai-title match). If `match` differs from `title`, say the session was found by an earlier or auto name and show
  the current title alongside. Flag these as "matched session title".
  `timestamp` on a title row is the session's last activity. Rows with `"match_type": "message"` are message text.
- **Context** (lines before/after) if available
- **Resume command**: `claude --resume <session-id>`

If no results, suggest broadening the search or trying different keywords.
