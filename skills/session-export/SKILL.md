---
name: session-export
description: >-
  Exports a Claude Code session as a clean, readable markdown transcript.
  Use when the user wants to export a session, create a transcript, save
  session history to a file, or says "export this session".
---

# Session Export

Export a session as a clean transcript.

## Step 1: Resolve the session

If no session specified, use the current one:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --project "$(basename $(pwd))" --limit 1
```

## Step 2: Export

To print to conversation:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts export <session-jsonl-path> --format md
```

To save to file:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts export <session-jsonl-path> --format md --output session-transcript.md
```

For plain text:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts export <session-jsonl-path> --format txt --output session-transcript.txt
```

## Step 3: Present

If written to file, confirm the path and line count. If inline, present the transcript directly.

Tool calls are summarized (tool name only, not full input JSON) to keep the transcript readable.
