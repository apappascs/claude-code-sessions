---
name: session-resume
description: >-
  Generates a context recovery prompt from a past Claude Code session so a new
  session can pick up where it left off. Use when the user says "resume from",
  "pick up where I left off", "continue that session", "context recovery", or
  wants to start a new session with context from an old one.
---

# Session Resume

Generate a context-recovery document from a past session.

## Step 1: Resolve the session

If the user provides a session ID, resolve it. Otherwise, show recent sessions and ask which one:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts list --project "$(basename $(pwd))" --limit 5
```

## Step 2: Extract resume data

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts resume <session-jsonl-path>
```

## Step 3: Synthesize context recovery prompt

The script outputs raw session data. Synthesize into a structured context document:

### Context Recovery Template

```markdown
# Continuing: [project name] — [branch]

## What was being worked on
[Synthesize from last_user_messages and tool_calls_summary]

## Key files
[List files_modified with brief context on what was done to each]

## Decisions made
[Infer from the session flow — what approaches were chosen]

## Pending work
[List any tasks with status "pending"]

## Last state
[What was the user's last intent? What should happen next?]

## Git commits made
[List any commits from the session]
```

Also offer: `claude --resume <session-id>` as an alternative if the user wants to continue in the original session context directly.

### Resumed sessions

When a user runs `claude --resume <session-id>` or `claude --continue`, Claude Code creates a **new JSONL file** with a new session ID. The previous session's context is loaded into memory but does not appear in the new file. There is no standard metadata linking the two sessions.

This means a resumed session's transcript will appear to start mid-conversation — the first message may reference context that only existed in the parent session. The `is_resumed` flag in session stats indicates when this has been detected, so the context recovery prompt should note that earlier context may be missing.

### Difference from handoff
This skill works **retroactively** on any past session, even ones that ended abruptly. A handoff skill requires invocation during an active session.
