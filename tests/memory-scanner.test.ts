import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { auditMemories, parseFrontmatter, scanMemories, searchMemories } from "../lib/memory-scanner";

const CLI_PATH = join(import.meta.dir, "..", "lib", "memory-scanner.ts");

const FIXTURES_BASE = join(import.meta.dir, "fixtures", "memory");

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  test("parses valid frontmatter with all fields", () => {
    const content = `---
name: Test memory
description: A test memory file
type: user
---

This is the body.
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("Test memory");
    expect(result.description).toBe("A test memory file");
    expect(result.type).toBe("user");
    expect(result.body).toContain("This is the body.");
  });

  test("returns null fields for missing frontmatter", () => {
    const content = "Just a plain body with no frontmatter.";
    const result = parseFrontmatter(content);
    expect(result.name).toBeNull();
    expect(result.description).toBeNull();
    expect(result.type).toBeNull();
    expect(result.body).toBe(content);
  });

  test("handles frontmatter with extra fields gracefully", () => {
    const content = `---
name: Extra fields test
description: Has extra fields
type: feedback
author: someone
priority: high
---

Body content here.
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("Extra fields test");
    expect(result.description).toBe("Has extra fields");
    expect(result.type).toBe("feedback");
    expect(result.body).toContain("Body content here.");
  });

  test("handles empty content", () => {
    const result = parseFrontmatter("");
    expect(result.name).toBeNull();
    expect(result.description).toBeNull();
    expect(result.type).toBeNull();
    expect(result.body).toBe("");
  });

  test("handles frontmatter with only some fields", () => {
    const content = `---
name: Partial frontmatter
type: reference
---

Just a body.
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("Partial frontmatter");
    expect(result.description).toBeNull();
    expect(result.type).toBe("reference");
    expect(result.body).toContain("Just a body.");
  });

  test("strips quotes from frontmatter values", () => {
    const content = `---
name: "Quoted name"
description: 'Single quoted'
type: user
---

Body.
`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe("Quoted name");
    expect(result.description).toBe("Single quoted");
  });
});

// ---------------------------------------------------------------------------
// scanMemories
// ---------------------------------------------------------------------------

describe("scanMemories", () => {
  test("discovers all memory files across projects", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE });
    // 4 projects scanned (alpha, beta, empty, gamma)
    expect(result.projectsScanned).toBe(4);
    // 3 projects have memories (alpha=3, beta=2, gamma=2; empty has none)
    expect(result.projectsWithMemories).toBe(3);
    // 7 total memory files
    expect(result.totalMemories).toBe(7);
  });

  test("counts memories by type", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE });
    // user: alpha/user_profile + gamma/user_profile = 2
    expect(result.byType.user).toBe(2);
    // feedback: alpha/feedback_testing = 1
    expect(result.byType.feedback).toBe(1);
    // project: beta/project_expired_reminder = 1
    expect(result.byType.project).toBe(1);
    // reference: alpha/orphan_file + beta/reference_stale_path = 2
    expect(result.byType.reference).toBe(2);
    // unknown: gamma/no_frontmatter = 1
    expect(result.byType.unknown).toBe(1);
  });

  test("filters by type", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE, typeFilter: "user" });
    expect(result.memories.length).toBe(2);
    for (const m of result.memories) {
      expect(m.type).toBe("user");
    }
  });

  test("filters by project", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE, projectFilter: "alpha" });
    expect(result.projectsScanned).toBe(1);
    expect(result.memories.length).toBe(3);
    for (const m of result.memories) {
      expect(m.project).toBe("project-alpha");
    }
  });

  test("detects frontmatter presence", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE });
    const noFm = result.memories.find((m) => m.file === "no_frontmatter.md");
    expect(noFm).toBeDefined();
    expect(noFm!.hasFrontmatter).toBe(false);

    const withFm = result.memories.find((m) => m.file === "user_profile.md" && m.project === "project-alpha");
    expect(withFm).toBeDefined();
    expect(withFm!.hasFrontmatter).toBe(true);
  });

  test("detects indexed status from MEMORY.md", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE });
    // user_profile.md in alpha is listed in MEMORY.md
    const indexed = result.memories.find((m) => m.file === "user_profile.md" && m.project === "project-alpha");
    expect(indexed).toBeDefined();
    expect(indexed!.indexed).toBe(true);

    // orphan_file.md in alpha is NOT listed in MEMORY.md
    const orphan = result.memories.find((m) => m.file === "orphan_file.md");
    expect(orphan).toBeDefined();
    expect(orphan!.indexed).toBe(false);
  });

  test("returns empty result for nonexistent base", () => {
    const result = scanMemories({ projectsBase: "/nonexistent/path/that/does/not/exist" });
    expect(result.projectsScanned).toBe(0);
    expect(result.projectsWithMemories).toBe(0);
    expect(result.totalMemories).toBe(0);
    expect(result.memories).toHaveLength(0);
  });

  test("generates readable project name", () => {
    const result = scanMemories({ projectsBase: FIXTURES_BASE, projectFilter: "alpha" });
    expect(result.memories.length).toBeGreaterThan(0);
    // "project-alpha" → "project/alpha"
    expect(result.memories[0].projectReadable).toBe("project/alpha");
  });
});

// ---------------------------------------------------------------------------
// auditMemories
// ---------------------------------------------------------------------------

describe("auditMemories", () => {
  test("detects expired date-based memories (critical)", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const expired = result.findings.filter((f) => f.category === "expired");
    expect(expired.length).toBeGreaterThan(0);
    const target = expired.find((f) => f.file === "project_expired_reminder.md");
    expect(target).toBeDefined();
    expect(target!.severity).toBe("critical");
    expect(target!.fixType).toBe("auto");
    expect(target!.autoFixable).toBe(true);
  });

  test("detects broken MEMORY.md links (warning)", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const broken = result.findings.filter((f) => f.category === "broken_link");
    expect(broken.length).toBeGreaterThan(0);
    const target = broken.find((f) => f.message.includes("nonexistent_file.md"));
    expect(target).toBeDefined();
    expect(target!.severity).toBe("warning");
    expect(target!.autoFixable).toBe(true);
  });

  test("detects orphan files not in MEMORY.md", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const orphans = result.findings.filter((f) => f.category === "orphan");
    expect(orphans.length).toBeGreaterThan(0);
    const target = orphans.find((f) => f.file === "orphan_file.md");
    expect(target).toBeDefined();
  });

  test("orphan with frontmatter is auto-fixable", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const orphan = result.findings.find((f) => f.category === "orphan" && f.file === "orphan_file.md");
    expect(orphan).toBeDefined();
    // orphan_file.md has frontmatter, so it should be auto-fixable
    expect(orphan!.fixType).toBe("auto");
    expect(orphan!.autoFixable).toBe(true);
  });

  test("detects missing frontmatter (ai_assisted)", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const missing = result.findings.filter((f) => f.category === "missing_frontmatter");
    expect(missing.length).toBeGreaterThan(0);
    const target = missing.find((f) => f.file === "no_frontmatter.md");
    expect(target).toBeDefined();
    expect(target!.severity).toBe("warning");
    expect(target!.fixType).toBe("ai_assisted");
    expect(target!.autoFixable).toBe(false);
  });

  test("detects stale file paths in content (ai_assisted)", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const stalePaths = result.findings.filter((f) => f.category === "stale_path");
    expect(stalePaths.length).toBeGreaterThan(0);
    const target = stalePaths.find((f) => f.message.includes("/tmp/nonexistent-project-path-abc123"));
    expect(target).toBeDefined();
    expect(target!.fixType).toBe("ai_assisted");
    expect(target!.autoFixable).toBe(false);
  });

  test("detects duplicate memory names across projects", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const dupes = result.findings.filter((f) => f.category === "duplicate");
    expect(dupes.length).toBeGreaterThan(0);
    // "User profile" exists in both project-alpha and project-gamma
    const projects = new Set(dupes.map((f) => f.project));
    expect(projects.has("project-alpha")).toBe(true);
    expect(projects.has("project-gamma")).toBe(true);
  });

  test("respects age threshold for staleness", () => {
    // ageThreshold: 0 — all project/reference files (even 0-day-old fixture files) should be flagged
    const result = auditMemories({ projectsBase: FIXTURES_BASE, ageThreshold: 0 });
    const stale = result.findings.filter((f) => f.category === "stale");
    expect(stale.length).toBeGreaterThan(0);
    for (const f of stale) {
      expect(f.severity).toBe("info");
      expect(f.fixType).toBe("ai_assisted");
    }
  });

  test("summary counts match findings", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const totalFromBySeverity = Object.values(result.summary.bySeverity).reduce((a, b) => a + b, 0);
    expect(totalFromBySeverity).toBe(result.summary.issuesFound);
    expect(result.summary.issuesFound).toBe(result.findings.length);
    expect(result.summary.totalMemories).toBeGreaterThan(0);
    expect(result.summary.healthy).toBe(
      result.summary.totalMemories - new Set(result.findings.map((f) => f.path)).size,
    );
  });

  test("findings are sorted by severity (critical first)", () => {
    const result = auditMemories({ projectsBase: FIXTURES_BASE });
    const severities = result.findings.map((f) => f.severity);
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });

  test("returns clean result for empty base", () => {
    const result = auditMemories({ projectsBase: "/nonexistent/path/that/does/not/exist" });
    expect(result.findings).toHaveLength(0);
    expect(result.summary.totalMemories).toBe(0);
    expect(result.summary.healthy).toBe(0);
    expect(result.summary.issuesFound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchMemories
// ---------------------------------------------------------------------------

describe("searchMemories", () => {
  test("finds matches across memory files", () => {
    const results = searchMemories("engineer", { projectsBase: FIXTURES_BASE });
    expect(results.length).toBeGreaterThan(0);
  });

  test("returns line numbers for matches", () => {
    const results = searchMemories("engineer", { projectsBase: FIXTURES_BASE });
    for (const r of results) {
      expect(r.line).toBeGreaterThan(0);
    }
  });

  test("includes context lines when requested", () => {
    const results = searchMemories("engineer", { projectsBase: FIXTURES_BASE, context: 1 });
    const withCtx = results.find((r) => r.contextBefore.length > 0 || r.contextAfter.length > 0);
    expect(withCtx).toBeDefined();
  });

  test("filters by type", () => {
    const results = searchMemories("engineer", { projectsBase: FIXTURES_BASE, typeFilter: "user" });
    for (const r of results) {
      expect(r.type).toBe("user");
    }
  });

  test("filters by project", () => {
    const results = searchMemories("engineer", { projectsBase: FIXTURES_BASE, projectFilter: "alpha" });
    for (const r of results) {
      expect(r.project).toBe("project-alpha");
    }
  });

  test("respects limit", () => {
    const results = searchMemories("e", { projectsBase: FIXTURES_BASE, limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("returns empty array for no matches", () => {
    const results = searchMemories("xyzzy_this_string_does_not_exist_anywhere", { projectsBase: FIXTURES_BASE });
    expect(results).toHaveLength(0);
  });

  test("is case-insensitive", () => {
    const lower = searchMemories("engineer", { projectsBase: FIXTURES_BASE });
    const upper = searchMemories("ENGINEER", { projectsBase: FIXTURES_BASE });
    expect(lower.length).toBe(upper.length);
  });

  test("escapes regex special characters in query", () => {
    // This should not crash — the query is treated as a literal string
    expect(() => searchMemories("(a+)+$", { projectsBase: FIXTURES_BASE })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("CLI", () => {
  test("scan outputs JSON with projects_scanned = 4 and memories array", () => {
    const proc = spawnSync("bun", ["run", CLI_PATH, "scan", "--projects-base", FIXTURES_BASE], {
      encoding: "utf-8",
    });
    expect(proc.status).toBe(0);
    const json = JSON.parse(proc.stdout);
    expect(json.projects_scanned).toBe(4);
    expect(Array.isArray(json.memories)).toBe(true);
  });

  test("audit outputs JSON with summary and findings", () => {
    const proc = spawnSync("bun", ["run", CLI_PATH, "audit", "--projects-base", FIXTURES_BASE], {
      encoding: "utf-8",
    });
    expect(proc.status).toBe(0);
    const json = JSON.parse(proc.stdout);
    expect(json).toHaveProperty("summary");
    expect(json).toHaveProperty("findings");
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.summary.total_memories).toBeGreaterThan(0);
  });

  test("search outputs NDJSON (one JSON object per line)", () => {
    const proc = spawnSync("bun", ["run", CLI_PATH, "search", "engineer", "--projects-base", FIXTURES_BASE], {
      encoding: "utf-8",
    });
    expect(proc.status).toBe(0);
    const lines = proc.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj).toHaveProperty("project");
      expect(obj).toHaveProperty("file");
      expect(obj).toHaveProperty("line");
    }
  });

  test("search with no results outputs empty JSON array", () => {
    const proc = spawnSync(
      "bun",
      ["run", CLI_PATH, "search", "xyzzy_this_string_does_not_exist_anywhere", "--projects-base", FIXTURES_BASE],
      { encoding: "utf-8" },
    );
    expect(proc.status).toBe(0);
    const json = JSON.parse(proc.stdout);
    expect(json).toEqual([]);
  });

  test("missing search query exits with code 2", () => {
    const proc = spawnSync("bun", ["run", CLI_PATH, "search", "--projects-base", FIXTURES_BASE], {
      encoding: "utf-8",
    });
    expect(proc.status).toBe(2);
  });

  test("unknown command exits with code 1", () => {
    const proc = spawnSync("bun", ["run", CLI_PATH, "foobar", "--projects-base", FIXTURES_BASE], {
      encoding: "utf-8",
    });
    expect(proc.status).toBe(1);
  });
});
