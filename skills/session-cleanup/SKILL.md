---
name: session-cleanup
description: >-
  Finds old, empty, or tiny Claude Code session files that are candidates for
  deletion. Use when the user wants to clean up sessions, free disk space,
  says "clean up old sessions", or asks about session storage usage.
---

# Session Cleanup

Find session files that are candidates for cleanup.

## Step 1: Identify candidates

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts cleanup --min-messages 3
```

To also find old sessions:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts cleanup --older-than 30d --min-messages 3
```

## Step 2: Present candidates

The script outputs a JSON object with `candidates` array and `total_size_bytes`. Present as a table:

| # | Session ID | Project | Reason | Messages | Age | Size |
|---|-----------|---------|--------|----------|-----|------|

Show the total reclaimable space.

## Step 3: Confirm before deleting

**NEVER delete without explicit user confirmation.** Present the list and ask:

> "Found N sessions (X total) that could be cleaned up. Want me to delete them? (yes/no)"

If confirmed, delete each session using the delete command:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts delete-session <session-id>
```

This will also report any task lists that become orphaned.

For manual deletion, the file path is also shown:
```bash
rm "<path-to-session.jsonl>"
```

Report each deletion. If the user wants to keep some, ask which ones to skip.

## Step 4: Check for orphan task lists

After cleanup, check for task lists that no longer have matching sessions:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts orphan-task-lists
```

If orphans are found, present them:

| Task List ID | Tasks | Last Modified |
|-------------|-------|---------------|

Ask: "Found N orphan task lists with no matching session. Delete them? (yes/no/select)"

If confirmed, delete using:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts delete-task-list <task-list-id>
```

Or the user can inspect and delete manually:
```bash
ls ~/.claude/tasks/<task-list-id>/
rm -r ~/.claude/tasks/<task-list-id>/
```

## Safety

- The script only identifies candidates — it never deletes
- Always show the full list before asking for confirmation
- Delete one file at a time, reporting each
- If in doubt, suggest the user review the list first
