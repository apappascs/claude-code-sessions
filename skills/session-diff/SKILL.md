---
name: session-diff
description: >-
  Compares two Claude Code sessions — shows what changed in files, tools used,
  branches, and topics. Use when the user says "what changed between sessions",
  "diff sessions", "compare yesterday and today", or wants to understand how
  work evolved across sessions.
---

# Session Diff

Compare two sessions to see what changed.

## Step 1: Resolve session paths

If the user provides two session IDs, resolve them:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --project "$(basename $(pwd))" --limit 2
```

Use the `path` fields from the results.

## Step 2: Run the diff

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts diff <session-a.jsonl> <session-b.jsonl>
```

## Step 3: Interpret and present

The script outputs raw structural data. Your job is to synthesize the narrative:

- **What was the focus of each session?** (use `first_user_messages`)
- **Files added/dropped/common** between sessions
- **Branch changes** (did they switch branches?)
- **Tool usage shifts** (more editing? more reading? more testing?)
- **Continuity** — does session B pick up where A left off?

Present as a side-by-side comparison with your interpretation.
