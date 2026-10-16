---
name: session-memory
description: >-
  Searches and lists all Claude Code memories across projects.
  Use when the user asks what memories exist, wants to see stored knowledge,
  asks "what do you remember", or wants an overview of their memory files.
  Also triggered by: "list memories", "show memories", "what's in my memory".
---

## Step 1: Scan all memories

Run the memory scanner to discover all memory files across projects:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/memory-scanner.ts scan
```

Optional filters — add based on user request:
- `--type user|feedback|project|reference` — filter by memory type
- `--project FILTER` — filter by project name (substring match)

## Step 2: Present the results

Parse the JSON output and present as a **grouped-by-project** table:

**For each project that has memories, show:**

| # | Name | Type | Age | Indexed |
|---|------|------|-----|---------|
| 1 | Memory name | `type` | Nd | yes/no |

**At the top, show the summary line:**
> Found **N memories** across **M projects** — N user, N feedback, N project, N reference

**Highlight issues if visible:**
- If any memory has `indexed: false`, note it: "N memories not indexed in MEMORY.md — run `/session-memory-audit` to fix"
- If any memory has `has_frontmatter: false`, note it: "N memories missing frontmatter"

## Step 3: Suggest follow-ups

Based on what was found, suggest relevant next steps:
- "/session-memory-audit" — to health-check and fix issues
- "/session-memory-search <keyword>" — to search across memory content
