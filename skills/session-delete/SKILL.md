---
name: session-delete
description: >-
  Delete a Claude Code session file, with optional cleanup of associated task
  lists and tasks. Warns about orphaned tasks before deleting. Use when the user
  says "delete session", "remove session", or wants to clean up a specific session.
---

# Session Delete

Delete a session and optionally its associated tasks.

## Step 1: Preview what will be deleted

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts session-detail <session-id>
```

Show the session summary, token usage, and associated task lists.
Also show the file path so the user can inspect it manually if desired.

## Step 2: Confirm before deleting

**NEVER delete without explicit user confirmation.** Present:

- Session ID and project
- File path (for manual inspection: `ls -la "<path>"`)
- Number of associated task lists and tasks that will become orphans

Ask: "Delete this session? (If you have associated tasks, I can delete those too, or leave them.)"

## Step 3: Execute deletion

If user confirms, delete with or without tasks:

```bash
# Delete session only (tasks become orphans)
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts delete-session <session-id>

# Delete session and associated tasks
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts delete-session <session-id> --delete-tasks
```

Alternatively, the user can delete manually:
```bash
rm "<session-file-path>"
```

## Step 4: Report result

Show what was deleted: session file path, and if tasks were deleted, how many.

## Safety

- Never delete without explicit confirmation
- Always show what will be deleted first
- Always show the file path for manual inspection
- Default to NOT deleting associated tasks unless user opts in
