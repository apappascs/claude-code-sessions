# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Session intelligence plugin for Claude Code — reads `~/.claude/projects/` and `~/.claude/tasks/` to provide search, analytics, timeline, and task management across all Claude Code sessions. Built with Bun (TypeScript), Alpine.js SPA frontend, zero external runtime dependencies.

## Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test --watch         # Watch mode
bun test tests/server.test.ts          # Run a single test file
bun test --grep "pattern"              # Run tests matching pattern
bun run typecheck        # Typecheck (bunx tsc --noEmit)
bun run lint             # Lint & format check (Biome)
bun run lint:fix         # Auto-fix lint/format issues
bun run ui               # Start UI server on :3000
bun run ui:open          # Start + open browser
```

CLI usage (each lib file is directly runnable):
```bash
bun run lib/session-store.ts list [--project FILTER] [--sort recency|size|duration] [--limit N]
bun run lib/session-store.ts search "<query>" [--project FILTER] [--since DATE]
bun run lib/session-store.ts tasks [--status pending|completed|in_progress|all]
bun run lib/session-parser.ts stats <session.jsonl>
bun run lib/session-parser.ts export <session.jsonl> [--format md|txt]
```

## Architecture

**Four-layer stack:**

1. **`lib/formatters.ts`** — Shared utilities (JSON serialization, truncation, timestamp parsing). No I/O.
2. **`lib/session-parser.ts`** — Single-session JSONL parser. Extracts stats, tasks, messages, tools, diffs from one `.jsonl` file. Also a CLI.
3. **`lib/session-store.ts`** — Cross-session operations. Scans `~/.claude/projects/` directory tree to list, search, filter, and aggregate across all sessions. Also a CLI.
4. **`ui/server.ts`** — Bun HTTP server. Imports from lib, exposes REST endpoints (`/api/sessions`, `/api/search`, `/api/tasks`, `/api/dashboard/stats`, etc.), serves static files from `ui/public/`.

**Frontend** (`ui/public/`):
- `index.html` — SPA shell with Alpine.js (loaded via CDN), hash-based routing
- `js/app.js` — Alpine stores, API client, formatters. Must load synchronously before Alpine (which loads with `defer`)
- `css/` — Design token system: `tokens.css` → `reset.css` → `layout.css` → `components.css`. Uses OKLCH color system with warm-tinted neutrals (hue 85). Light/dark theme support.

**Data flow:** Claude Code writes JSONL to `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. This plugin reads those files. Most operations are read-only; the delete and cleanup skills can remove session files when explicitly invoked. Tasks come from `~/.claude/tasks/` (primary) with JSONL fallback for older sessions.

**Key pattern:** The API layer maps internal camelCase types to snake_case JSON output to match Claude Code's native format.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List sessions with sort/filter/limit |
| GET | `/api/sessions/stats` | Stats for a single session |
| GET | `/api/sessions/:id` | Full session detail |
| GET | `/api/sessions/:id/messages` | Paginated messages with tool filter |
| DELETE | `/api/sessions/:id` | Delete session file (+ optional tasks) |
| GET | `/api/search` | Full-text search with context |
| GET | `/api/tasks` | Aggregated tasks across sessions |
| GET | `/api/tasks/lists` | All task lists |
| GET | `/api/tasks/orphans` | Orphaned task lists |
| GET | `/api/dashboard/stats` | Dashboard summary stats |
| DELETE | `/api/tasks/:listId/:taskId` | Delete a specific task |
| DELETE | `/api/tasks/:listId` | Delete an entire task list |

## Resumed Sessions

When a user runs `claude --resume <session-id>` or `claude --continue`, Claude Code creates a **new JSONL file** with a new session ID. The previous session's context is loaded into memory but does not appear in the new file. There is no standard metadata linking the two sessions — no `resumed_from`, no `parent_session_id` field exists in the JSONL format (see [anthropics/claude-code#5135](https://github.com/anthropics/claude-code/issues/5135)).

**Detection heuristics** (no official API — these are reverse-engineered signals):
1. **Best**: assistant message with `model: "<synthetic>"`, `isApiErrorMessage: false`, content text `"No response requested."` — resume bridge message injected by Claude Code
2. **Secondary**: `type: "last-prompt"` entry with `lastPrompt: "continue"` — explicit `--continue` command
3. **Tertiary**: startup triplet (`custom-title` + `agent-name` + `permission-mode`) appearing mid-file — indicates CLI reconnection

Signal #1 is used in `getStats()` and surfaced as `is_resumed: boolean` in `SessionStats`. The session detail UI shows a banner when detected.

## Testing

Tests use Bun's built-in test runner. Test files mirror source: `tests/formatters.test.ts`, `tests/session-parser.test.ts`, `tests/session-store.test.ts`, `tests/server.test.ts`. Tests create temp directories with fixture JSONL data — no mocking of the filesystem. Server tests use `createHandler()` directly (no network).

## UI

5 views: Dashboard, Sessions, Search, Tasks, and Session Detail (slide-in). Interactive features include session deletion (single + bulk), task CRUD, orphan task list detection and cleanup. Design context for UI work is in `.impeccable.md` at the project root.

