---
name: session-detail
description: >-
  Show detailed information about a Claude Code session including stats, token
  usage, models used, tools called, associated tasks, and conversation messages.
  Use when the user says "show session", "session details", "what happened in session X".
---

# Session Detail

Show comprehensive details about a single session.

## Step 1: Get session detail

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts session-detail <session-id>
```

This returns: session summary, token usage (input/output/cache), models used, tools called, and associated task lists with their tasks.

## Step 2: Present summary

Show a formatted summary:

- **Session**: ID, project, date, duration
- **Tokens**: input, output, cache read, cache create
- **Models**: which models were used and how many turns each
- **Tools**: top tools used with counts
- **Tasks**: associated task lists and task status summary

## Note on resumed sessions

If `is_resumed` is true in the stats, this session was started via `claude --resume` or `claude --continue`. The JSONL only contains messages from the resumed portion — earlier context from the parent session is not included. Mention this to the user so they understand why the transcript may appear to start mid-conversation.

## Step 3: Show messages (optional)

If the user wants to see the conversation:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts messages <session-path> --limit 20
```

For more messages, increase `--offset` and `--limit`:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts messages <session-path> --offset 20 --limit 20
```

To include tool call details:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts messages <session-path> --include-tools --limit 20
```
