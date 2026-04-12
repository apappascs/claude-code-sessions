---
name: session-tasks
description: >-
  Aggregates tasks across Claude Code task lists and sessions — shows pending,
  in-progress, and completed tasks with dependencies. Use when the user asks
  "what tasks are pending", "show my tasks", "orphaned tasks", "task dependencies",
  or wants a cross-session task inventory.
---

# Session Tasks

Aggregate tasks from the Tasks filesystem (`~/.claude/tasks/`) and session JSONL.

## List all task lists

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts task-lists
```

## All tasks across all task lists

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts tasks
```

## Filter by status

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts tasks --status pending
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts tasks --status in_progress
```

## Tasks from a specific task list

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-store.ts tasks --task-list <task-list-id>
```

## Fallback: tasks from a session JSONL (legacy)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/session-parser.ts tasks <session-jsonl-path>
```

## Present results

Group tasks by status:
1. **In Progress** tasks first (actively being worked on — check `activeForm` for current activity)
2. **Pending** tasks (need attention — check `blockedBy` for dependencies)
3. **Completed** tasks

For each task show: subject, description, status, task list ID, dependencies.

If tasks have `blocks`/`blockedBy` relationships, show a dependency summary:
- "Task 2 (Add tests) is blocked by Task 1 (Setup project)"

Flag **orphaned tasks** — tasks with status "pending" or "in_progress" in task lists older than 7 days.

The `source` field indicates whether the task came from the filesystem (`"filesystem"`) or was extracted from session JSONL (`"jsonl"`).
