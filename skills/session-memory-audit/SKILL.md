---
name: session-memory-audit
description: >-
  Health-checks Claude Code memories for staleness, broken links, orphaned files,
  expired dates, missing frontmatter, and duplicates. Offers two-tier fixes:
  deterministic auto-fixes and AI-assisted corrections.
  Use when the user asks to clean up memories, check memory health, find stale
  memories, or audit their stored knowledge. Also triggered by: "memory health",
  "stale memories", "clean up memories", "memory audit".
---

## Step 1: Run the audit

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/lib/memory-scanner.ts audit
```

Optional: `--age-threshold N` (default 60 days for staleness check)

## Step 2: Present the summary

Show the health summary first:

> **Memory Health Report**
> N memories across M projects
> N critical · N warnings · N info

## Step 3: Present findings in two sections

**IMPORTANT: Always separate findings into two clearly labeled groups.**

### Section A: Auto-fixable (deterministic, no AI)

These are safe, mechanical fixes. Present as a numbered table:

| # | Action | File | Project | Issue |
|---|--------|------|---------|-------|

Where Action is one of:
- **DELETE** — for `expired` findings (delete file + remove MEMORY.md entry)
- **REMOVE** — for `broken_link` findings (remove dead entry from MEMORY.md)
- **INDEX** — for `orphan` findings with frontmatter (add entry to MEMORY.md)
- **SYNC** — for `index_mismatch` findings (update MEMORY.md description)

After the table, ask: **"Apply all N auto-fixes? (yes/no)"**

If yes:
- For DELETE: Remove the file with `rm`, then edit MEMORY.md to remove the line referencing it
- For REMOVE: Edit MEMORY.md to remove the broken link line
- For INDEX: Read the file's frontmatter, append a new entry to MEMORY.md: `- [name](filename.md) — description`
- For SYNC: Update the MEMORY.md entry's description to match the file's frontmatter description

Report each fix as it completes.

### Section B: AI-assisted (requires analysis)

Present these AFTER auto-fixes are complete (or skipped):

**"There are also N findings that require analysis to fix. Would you like to review them? (yes/no)"**

If no — show summary and stop. Do NOT proceed with AI-assisted fixes.

If yes — walk through ONE AT A TIME:

For each finding, the `ai_action` field tells you what to do:

**missing_frontmatter:**
1. Read the file content
2. Infer the memory type from content (user bio = user, behavioral rule = feedback, project state = project, external pointers = reference)
3. Infer a concise name and description
4. Show the proposed frontmatter to the user
5. If approved, prepend it to the file

**stale_path:**
1. For each missing path, search the filesystem by filename: `find / -name "filename" -type f 2>/dev/null | head -5`
2. If found at a new location, suggest updating the path in the memory file
3. If not found, suggest removing the reference or marking the memory for deletion

**duplicate:**
1. Read both memory files fully
2. Compare content — are they truly duplicates or do they serve different projects?
3. If duplicates: propose a merged version, ask user which project should keep it
4. If different: suggest renaming one to differentiate (e.g., "User profile — backend" vs "User profile — frontend")

**stale (age-based):**
1. Read the file content
2. Check if it references specific facts that may have changed (versions, counts, dates, URLs)
3. Present a summary: "This memory is N days old. It claims X — is this still accurate?"
4. If user says outdated: help update the content
5. If user says still valid: suggest updating the file's modification date with `touch`

## Safety Rules

- NEVER delete a file without explicit user confirmation
- NEVER modify MEMORY.md without showing what will change
- Auto-fixes are batched but each destructive action (DELETE) should be confirmed individually within the batch
- AI-assisted fixes are always one-at-a-time with user approval
- If the user says "no" to reviewing AI-assisted findings, stop immediately — do not summarize them, do not suggest reviewing them later
