# Skill Examples

One example prompt and output for each of the 11 claude-code-sessions skills. All outputs are representative — your actual session data will differ.

---

## `/session-list`

```
/session-list
```

**Output:**

| # | Session ID | Project | Date | Messages | Duration | Size |
|---|-----------|---------|------|----------|----------|------|
| 1 | `3d687407` | **my-app** ★ | 2026-04-15 | 3,653 | 50h 36m | 16.2 MB |
| 2 | `c662674d` | **my-app** ★ | 2026-04-14 | 177 | 14m | 563 KB |
| 3 | `29142ab7` | other-project | 2026-04-15 | 870 | 3h 33m | 2.2 MB |
| 4 | `81b580f4` | **my-app** ★ | 2026-04-15 | 10 | 3m | 9.4 KB |

**★** = current project

To resume any session: `claude --resume <session-id>`

---

## `/session-search`

```
/session-search "database migration"
```

**Output:**

### Session `3d687407` — my-app (2026-04-14)

- **14:22** — *"Let me run the database migration and verify the schema changes"*
- **14:35** — *"The migration added the `user_preferences` table with 3 columns"*

Resume: `claude --resume 3d687407`

---

## `/session-stats`

```
/session-stats
```

**Output:**

```
Session: 3d687407
Duration: 50h 36m  |  Turns: 1,962  |  Messages: 3,567

Tokens
  Input:            190,849
  Output:           372,482
  Cache read:   182,109,547
  Cache create:   8,772,359

Models
  claude-opus-4-6     1,741 turns
  claude-sonnet-4-6      21 turns

Top tools
  Bash        384
  Read        226
  Edit        157
  Grep         98
  Agent        63
```

---

## `/session-detail`

```
/session-detail 3d687407
```

**Output:**

**Session** `3d687407` — my-app — Apr 13–15, 2026 — 50.8 hours

| Tokens | Count |
|--------|-------|
| Input | 191,158 |
| Output | 382,058 |
| Cache Read | 186,948,845 |
| Cache Create | 8,827,996 |

**Models:** claude-opus-4-6 (1,741 turns), claude-sonnet-4-6 (21 turns)

**Top tools:** Bash (413), Read (227), Edit (158), Grep (98), Agent (63)

**Tasks:** 30 total — all completed

---

## `/session-diff`

```
/session-diff compare my last two sessions
```

**Output:**

| | Session A (newer) | Session B (older) |
|---|---|---|
| **ID** | `c662674d` | `3d687407` |
| **Date** | Apr 14, 2026 | Apr 13–15, 2026 |
| **Duration** | 14m | ~50 hours |
| **Messages** | 177 | 3,567 |

**Session A focus:** Bug fixes — dashboard data, pagination, amend+push

**Session B focus:** Full feature build — design, implementation, 30 tasks completed

**Tool shift:** A was heavier on Read+Bash (debugging). B used Agent (63×) for parallelism.

**Continuity:** B is the main build. A is day-after cleanup.

---

## `/session-timeline`

```
/session-timeline
```

**Output:**

```
DATE         DURATION  SIZE    MSGS   SESSION
──────────────────────────────────────────────────────
2026-04-11   ██░░░░░░   9m   58KB    45   8636b081
2026-04-13   ███░░░░░  23m  114KB    75   24d6dd57
2026-04-13   ████████  51h   16MB  3,567  3d687407  ← marathon session
2026-04-14   █░░░░░░░  2.5m  393KB   47   8624b80a
2026-04-14   ████░░░░  14m  563KB   177   c662674d
2026-04-15   ░░░░░░░░   3m    9KB    10   81b580f4
```

**Patterns:** One marathon session dominates; short cleanup sessions follow; sporadic cadence with one productive burst.

---

## `/session-resume`

```
/session-resume
```

**Output (context recovery document):**

```markdown
# Continuing: my-app — main

## What was being worked on
Dashboard bug: sessions page showed stale data after pagination fix.
Sanitized fixture data and amended the commit.

## Key files
- lib/session-parser.ts — pagination fix
- ui/public/js/app.js — dashboard display update
- ui/server.ts — endpoint adjustment

## Decisions made
- Single commit history (private repo, clean amend)
- Bun for all test runs

## Pending work
None — all tasks completed.

## Last state
Session ended after final amend+push. Ready to continue.
```

Or jump directly: `claude --resume c662674d-6a13-4757-bd49-d32b42520525`

---

## `/session-tasks`

```
/session-tasks
```

**Output:**

**In Progress (1)**

| Task | List |
|------|------|
| Write failing test for auth middleware | `abc12345` |

**Pending (5)**

| Task | List |
|------|------|
| Add integration tests | `abc12345` |
| Update README with new endpoints | `abc12345` |
| Deploy to staging | `abc12345` |

**⚠ Orphaned (2 task lists)** — sessions deleted, tasks remain

Run `/session-cleanup` to review.

---

## `/session-export`

```
/session-export session 81b580f4
```

**Output:**

```markdown
# Session Transcript

## User (09:12)
Is APIM the auth server when using Entra ID with OAuth PKCE?

## Assistant (09:12) [claude-opus-4-6]
No — Entra ID is the authorization server, not APIM.

| Component  | Role                                    |
|------------|-----------------------------------------|
| Entra ID   | Authorization Server — issues tokens   |
| APIM       | API Gateway — validates tokens          |
| MCP Client | OAuth Client — initiates PKCE flow     |
| MCP Server | Resource Server — serves protected APIs|

## User (09:15)
Do we need one OAuth server per MCP server?

## Assistant (09:15) [claude-opus-4-6]
No — one Entra ID tenant, one App Registration per MCP server for
audience isolation. The APIM "authorization server" object is just
portal metadata, not a real auth server.
```

---

## `/session-cleanup`

```
/session-cleanup
```

**Output:**

```
Found 2 sessions (11 KB total) that could be cleaned up:

| # | Session ID | Project  | Reason                  | Messages | Age | Size |
|---|-----------|----------|-------------------------|----------|-----|------|
| 1 | fec6298c  | my-app   | empty (0 real turns)    | 4        | 0d  | 2 KB |
| 2 | c00083d5  | my-app   | empty (0 real turns)    | 5        | 0d  | 1 KB |

Delete these 2 sessions? (yes/no)
```

Nothing is deleted until you confirm.

---

## `/session-delete`

```
/session-delete session fec6298c
```

**Output:**

```
Session fec6298c-1746-4f59-be68-0786dff25042
Project:   my-app
File:      ~/.claude/projects/.../fec6298c.jsonl  (2 KB)
Messages:  4  |  Duration: 0m  |  Tasks: none

This is an empty/stub session — no real conversation happened.

Delete this session? (yes/no)
```

Type `yes` to confirm. Associated tasks (if any) are left intact unless you opt in to delete them too.
