---
name: session-stats
description: >-
  Shows token usage, model distribution, turn count, duration, and tool usage
  for a Claude Code session. Use when the user asks about token usage, session
  cost, model breakdown, or says "session stats" or "how much did this session use".
---

# Session Stats

Show detailed statistics for a single session.

## Step 1: Resolve the session

If the user provides a session ID or path, use it directly. Otherwise, find the current session:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --project "$(basename $(pwd))" --limit 1
```

Use the `path` field from the first result.

## Step 2: Run the stats script

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts stats <session-jsonl-path>
```

## Step 3: Present results

The script outputs a JSON object. Present as a visual summary:

- **Duration and turns** as headline stats
- **Token usage** as a breakdown (input, output, cache read, cache create) with totals
- **Model distribution** as a list showing which models were used and how many turns each
- **Tool usage** as a ranked list (most used first)

Note: Cost estimation is not available. Report raw token counts and model names only.
