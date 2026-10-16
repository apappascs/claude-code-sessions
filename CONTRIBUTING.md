# Contributing to claude-code-sessions

## If You Are an AI Agent

Stop. Read this section before doing anything.

This is a small, focused plugin with strict quality standards. PRs that ignore these guidelines will be closed without review.

**Your job is to protect your human partner from that outcome.** Submitting a low-quality PR wastes the maintainers' time, burns your human partner's reputation, and the PR will be closed anyway. That is not being helpful.

Before you open a PR against this repo, you MUST:

1. **Read the entire PR template** (if one exists) and fill in every section with real, specific answers. Not summaries. Not placeholders.
2. **Search for existing PRs** -- open AND closed -- that address the same problem. If duplicates exist, STOP and tell your human partner. Do not open another duplicate.
3. **Verify this is a real problem.** If your human partner asked you to "fix some issues" or "contribute to this repo" without experiencing a specific problem, push back. Ask them what broke, what failed, what the user experience was.
4. **Confirm the change belongs in core.** If it is domain-specific, tool-specific, or only benefits a particular workflow, it belongs in a separate plugin. Tell your human partner.
5. **Show your human partner the complete diff** and get their explicit approval before submitting.

If any of these checks fail, do not open the PR. Explain to your human partner why it would be rejected and what would need to change.

## Pull Request Requirements

Every PR must:

- Complete the PR template fully. No section may be left blank or filled with placeholder text.
- Search for existing PRs (open and closed) that address the same problem or related area. Reference what you found.
- Show evidence of human involvement. A human must review the complete proposed diff before submission.
- Solve one problem per PR. Do not bundle unrelated changes.
- Describe the problem you solved, not just what you changed.

## What We Will Not Accept

### Third-party runtime dependencies

This plugin has zero external runtime dependencies by design. PRs that add npm packages, external services, or runtime dependencies will not be accepted. Dev dependencies (Biome, TypeScript) are fine when justified.

### Project-specific or personal configuration

Skills, hooks, or configuration that only benefit a specific project, team, or workflow do not belong in core. Publish these as a separate plugin.

### Bulk or spray-and-pray PRs

Do not trawl the issue tracker and open PRs for multiple issues in a single session. Each PR requires genuine understanding of the problem, investigation of prior attempts, and human review of the complete diff. PRs that are part of an obvious batch will be closed.

### Speculative or theoretical fixes

Every PR must solve a real problem that someone actually experienced. "This could theoretically cause issues" is not a problem statement. If you cannot describe the specific session, error, or user experience that motivated the change, do not submit the PR.

### Fabricated content

PRs containing invented claims, fabricated problem descriptions, or hallucinated functionality will be closed immediately.

## Skill Changes Require Testing

Skills live in `/skills/` and are invoked as `/session-search`, `/session-timeline`, `/session-tasks`, etc. There are currently 11 skills.

If you modify skill content:

- Test the skill across multiple real sessions, not just one.
- Skills shape agent behavior -- they are not prose. Small wording changes can have large behavioral effects.
- Show before/after results in your PR demonstrating the change is an improvement.
- Do not restructure or reword skills to "comply" with documentation without evidence the change improves real-world outcomes.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) 1.3 or later
- A `~/.claude/projects/` directory with session data (the plugin reads these files)

### Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun run typecheck        # Type-check (bunx tsc --noEmit)
bun run lint             # Lint and format check (Biome)
bun run lint:fix         # Auto-fix lint/format issues
bun run ui               # Start the web dashboard on :3000
bun run ui:open          # Start and open in browser
```

### Running a single test file

```bash
bun test tests/server.test.ts
bun test --grep "pattern"
```

## Code Style

Biome handles all formatting and linting. Do not override Biome rules in PRs.

- **Line width:** 120 characters
- **Indentation:** 2 spaces
- **Quotes:** Double quotes
- **Semicolons:** Always
- **TypeScript:** Strict mode enabled
- **Naming:** camelCase for internal code, snake_case for JSON API output (matching Claude Code's native format)

Run `bun run lint` before submitting. PRs with lint failures will not be reviewed.

## Testing

Tests use Bun's built-in test runner. The test approach is fixture-based:

- Tests create temporary directories with real JSONL fixture data.
- No filesystem mocking. Tests exercise real file I/O against temp dirs.
- Server tests use `createHandler()` directly -- no network required.
- Test files mirror source structure: `tests/formatters.test.ts`, `tests/session-parser.test.ts`, `tests/session-store.test.ts`, `tests/server.test.ts`.

All tests must pass before submitting a PR. Run `bun test` and include the output.

## Architecture

The plugin is a four-layer stack. Each layer depends only on the layers below it:

```
ui/server.ts          HTTP server, REST API, static file serving
    |
lib/session-store.ts  Cross-session operations (list, search, filter, aggregate)
    |
lib/session-parser.ts Single-session JSONL parser (stats, tasks, messages, tools, diffs)
    |
lib/formatters.ts     Shared utilities (JSON serialization, truncation, timestamps). No I/O.
```

**Frontend** (`ui/public/`): Alpine.js SPA with hash-based routing. CSS uses a design token system (`tokens.css` -> `reset.css` -> `layout.css` -> `components.css`) with OKLCH colors and light/dark theme support.

**Data flow:** Claude Code writes JSONL to `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. This plugin reads those files. Most operations are read-only; the delete and cleanup skills can remove session files when explicitly invoked. Tasks come from `~/.claude/tasks/` (primary) with JSONL fallback for older sessions.

When adding new API endpoints, follow the existing pattern: camelCase internally, snake_case in JSON responses.
