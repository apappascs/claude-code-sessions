---
name: session-timeline
description: >-
  Shows a chronological timeline of all Claude Code sessions for a project.
  Use when the user asks "what's the history of this project", "show me all
  sessions", "session timeline", or wants to see patterns in their work.
---

# Session Timeline

Show chronological history of sessions for a project.

## Step 1: Run the timeline script

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts timeline --project "$(basename $(pwd))"
```

To show only recent sessions:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts timeline --project "$(basename $(pwd))" --since "2026-04-01"
```

## Step 2: Present the timeline

The script outputs a JSON array of sessions in chronological order. Present as a visual timeline:

```
2026-04-08  ████░░░░  45m  main        (12 messages)
2026-04-09  ██████░░  1h 20m  feat/cli  (34 messages)
2026-04-10  ██░░░░░░  15m  feat/cli    (8 messages)
2026-04-11  ████████  2h 10m  main      (56 messages)
```

Identify patterns:
- Daily cadence or sporadic?
- Long sessions vs short?
- Branch switches?
- Gaps in activity?
