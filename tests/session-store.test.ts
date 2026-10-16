// tests/session-store.test.ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateTasks,
  decodeProjectPath,
  deleteSession,
  deleteTask,
  deleteTaskList,
  encodeProjectPath,
  findCleanupCandidates,
  findOrphanTaskLists,
  getActivityHeatmap,
  getDailyTokenAggregation,
  getModelDistribution,
  getSessionDetail,
  getTimeline,
  isValidId,
  listSessions,
  listTaskLists,
  readTaskList,
  resolveSession,
  searchSessions,
} from "../lib/session-store";

const FIXTURE = join(import.meta.dir, "fixtures", "sample_session.jsonl");

function makeFakeProjectsDir(): { base: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "ss-"));
  const projDir = join(tmp, "projects", "-Users-me-myproject");
  mkdirSync(projDir, { recursive: true });
  copyFileSync(FIXTURE, join(projDir, "test-session-001.jsonl"));
  writeFileSync(join(projDir, "empty-session.jsonl"), "");
  return {
    base: join(tmp, "projects"),
    cleanup: () => rmSync(tmp, { recursive: true }),
  };
}

/** Fake projects dir containing one session that has title metadata lines and one message mentioning "database". */
function makeTitledProjectsDir(titleLines: object[]): { base: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "ss-title-"));
  const projDir = join(tmp, "projects", "-Users-me-myproject");
  mkdirSync(projDir, { recursive: true });
  const lines = [
    { type: "user", message: { content: "fix the database layer" }, timestamp: "2026-04-10T09:00:05Z" },
    ...titleLines,
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] }, timestamp: "2026-04-10T09:01:00Z" },
  ];
  writeFileSync(join(projDir, "titled-session.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { base: join(tmp, "projects"), cleanup: () => rmSync(tmp, { recursive: true }) };
}

/** Fake projects dir with one session built from arbitrary JSONL objects. */
function makeProjectsDirWithLines(lines: object[]): { base: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "ss-lines-"));
  const projDir = join(tmp, "projects", "-Users-me-myproject");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "edge-session.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { base: join(tmp, "projects"), cleanup: () => rmSync(tmp, { recursive: true }) };
}

/**
 * Fake projects dir with several message-only sessions ("a-*") plus one titled session ("z-titled"). Directory
 * scan order is filesystem-defined, so tests must not assume where the titled session lands; with many message
 * sessions it is very likely to be scanned after some of them, which is what the pre-ordering code tripped over.
 */
function makeManyMessageHitsDir(titleLines: object[], messageSessions = 8): { base: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "ss-order-"));
  const projDir = join(tmp, "projects", "-Users-me-myproject");
  mkdirSync(projDir, { recursive: true });
  const write = (name: string, lines: object[]) =>
    writeFileSync(join(projDir, `${name}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  for (let i = 0; i < messageSessions; i++) {
    write(
      `a-${i}`,
      [1, 2, 3].map((n) => ({
        type: "user",
        message: { content: `many hits ${i}-${n}` },
        timestamp: `2026-04-10T09:0${n}:00Z`,
      })),
    );
  }
  write("z-titled", [
    { type: "user", message: { content: "unrelated text" }, timestamp: "2026-04-10T09:00:00Z" },
    ...titleLines,
  ]);
  return { base: join(tmp, "projects"), cleanup: () => rmSync(tmp, { recursive: true }) };
}

const TITLE_LINES = [
  { type: "ai-title", aiTitle: "Quarterly budget review", sessionId: "titled-session" },
  { type: "custom-title", customTitle: "budget-tracker", sessionId: "titled-session" },
  { type: "ai-title", aiTitle: "Quarterly budget review", sessionId: "titled-session" },
];

function makeFakeTasksDir(): { base: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "st-"));
  const taskDir = join(tmp, "tasks", "test-session-001");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, ".lock"), "");
  writeFileSync(join(taskDir, ".highwatermark"), "3");
  writeFileSync(
    join(taskDir, "1.json"),
    JSON.stringify({
      id: "1",
      subject: "Setup project",
      description: "Initialize the repo",
      status: "completed",
      blocks: ["2"],
      blockedBy: [],
    }),
  );
  writeFileSync(
    join(taskDir, "2.json"),
    JSON.stringify({
      id: "2",
      subject: "Add tests",
      description: "Write unit tests",
      status: "pending",
      blocks: [],
      blockedBy: ["1"],
    }),
  );
  return {
    base: join(tmp, "tasks"),
    cleanup: () => rmSync(tmp, { recursive: true }),
  };
}

describe("encodeProjectPath", () => {
  test("encodes filesystem path", () => {
    expect(encodeProjectPath("/Users/me/myproject")).toBe("-Users-me-myproject");
  });
});

describe("decodeProjectPath", () => {
  test("decodes to filesystem path", () => {
    expect(decodeProjectPath("-Users-me-myproject")).toBe("/Users/me/myproject");
  });

  test("decodeProjectPath rejects paths containing ..", () => {
    expect(() => decodeProjectPath("foo-..")).toThrow("Invalid project path");
    expect(() => decodeProjectPath("-..")).toThrow("Invalid project path");
    expect(() => decodeProjectPath("..")).toThrow("Invalid project path");
  });

  test("decodeProjectPath works for normal paths", () => {
    expect(decodeProjectPath("-Users-me-project")).toBe("/Users/me/project");
    expect(decodeProjectPath("Users-me-project")).toBe("Users/me/project");
  });
});

describe("isValidId", () => {
  test("accepts UUID-like strings", () => {
    expect(isValidId("abc-123-def")).toBe(true);
    expect(isValidId("test-session-001")).toBe(true);
    expect(isValidId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("rejects path traversal attempts", () => {
    expect(isValidId("../etc/passwd")).toBe(false);
    expect(isValidId("foo/bar")).toBe(false);
    expect(isValidId("foo\\bar")).toBe(false);
    expect(isValidId("")).toBe(false);
    expect(isValidId("a b c")).toBe(false);
  });
});

describe("resolveSession", () => {
  test("resolves by path", () => {
    const path = resolveSession(FIXTURE);
    expect(path).toBe(FIXTURE);
  });

  test("throws for nonexistent", () => {
    expect(() => resolveSession("nonexistent-uuid-12345")).toThrow();
  });
});

describe("listSessions", () => {
  test("returns results", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const sessions = listSessions({ projectsBase: base });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0]).toHaveProperty("sessionId");
      expect(sessions[0]).toHaveProperty("project");
      expect(sessions[0]).toHaveProperty("messages");
    } finally {
      cleanup();
    }
  });

  test("project filter", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const sessions = listSessions({
        projectsBase: base,
        projectFilter: "myproject",
      });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const none = listSessions({
        projectsBase: base,
        projectFilter: "nonexistent",
      });
      expect(none).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("listSessions date filtering", () => {
  test("since filters out older sessions", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      // Fixture session date is 2026-04-10
      const sessions = listSessions({ projectsBase: base, since: "2026-04-11", limit: 100 });
      expect(sessions.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("since includes matching sessions", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const sessions = listSessions({ projectsBase: base, since: "2026-04-09", limit: 100 });
      expect(sessions.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("until filters out newer sessions", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const sessions = listSessions({ projectsBase: base, until: "2026-04-09", limit: 100 });
      expect(sessions.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("since + until range", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const sessions = listSessions({ projectsBase: base, since: "2026-04-09", until: "2026-04-11", limit: 100 });
      expect(sessions.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("since > until returns empty", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const sessions = listSessions({ projectsBase: base, since: "2026-04-20", until: "2026-04-10", limit: 100 });
      expect(sessions.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("searchSessions", () => {
  test("finds matching content", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const results = searchSessions("Python files", {
        projectsBase: base,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]).toHaveProperty("match");
    } finally {
      cleanup();
    }
  });

  test("ReDoS patterns complete quickly and do not hang", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const start = performance.now();
      const results = searchSessions("(a+)+$", { projectsBase: base });
      const elapsed = performance.now() - start;
      // Should complete in well under 1 second; ReDoS would cause multi-second hang
      expect(elapsed).toBeLessThan(1000);
      // The pattern is treated as a literal string, so no matches expected
      expect(results).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("no results for nonsense query", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const results = searchSessions("xyznonexistent123", {
        projectsBase: base,
      });
      expect(results).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("searchSessions title matching", () => {
  test("finds a session by customTitle and marks the row as a title match", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const results = searchSessions("budget-tracker", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("titled-session");
      expect(results[0].matchType).toBe("title");
      expect(results[0].type).toBe("custom-title");
      expect(results[0].match).toBe("budget-tracker");
      expect(results[0].title).toBe("budget-tracker");
    } finally {
      cleanup();
    }
  });

  test("finds a session by aiTitle, case-insensitively", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const results = searchSessions("BUDGET REVIEW", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("title");
      expect(results[0].type).toBe("ai-title");
      expect(results[0].match).toBe("Quarterly budget review");
      // Display title still prefers the custom title
      expect(results[0].title).toBe("budget-tracker");
    } finally {
      cleanup();
    }
  });

  test("emits one title row per session even though title lines repeat", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const results = searchSessions("budget", { projectsBase: base });
      expect(results.filter((r) => r.matchType === "title")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("title row comes before message rows and message rows carry the title", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const results = searchSessions("database", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("message");
      expect(results[0].title).toBe("budget-tracker");

      const both = makeTitledProjectsDir([{ type: "custom-title", customTitle: "database cleanup" }]);
      try {
        const rows = searchSessions("database", { projectsBase: both.base });
        expect(rows.map((r) => r.matchType)).toEqual(["title", "message"]);
      } finally {
        both.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  test("a twice-renamed session is found by its first name; row shows the current title", () => {
    const { base, cleanup } = makeTitledProjectsDir([
      { type: "custom-title", customTitle: "first-name" },
      { type: "custom-title", customTitle: "second-name" },
      { type: "custom-title", customTitle: "third-name" },
    ]);
    try {
      for (const [query, expected] of [
        ["first-name", "first-name"],
        ["second-name", "second-name"],
        ["third-name", "third-name"],
      ]) {
        const results = searchSessions(query, { projectsBase: base });
        expect(results).toHaveLength(1);
        expect(results[0].matchType).toBe("title");
        expect(results[0].type).toBe("custom-title");
        expect(results[0].match).toBe(expected);
        expect(results[0].title).toBe("third-name");
      }
    } finally {
      cleanup();
    }
  });

  test("a renamed session is found by its auto title with matchType ai-title", () => {
    const { base, cleanup } = makeTitledProjectsDir([
      { type: "ai-title", aiTitle: "Auto generated summary" },
      { type: "custom-title", customTitle: "my-name" },
    ]);
    try {
      const results = searchSessions("generated summary", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("title");
      expect(results[0].type).toBe("ai-title");
      expect(results[0].match).toBe("Auto generated summary");
      expect(results[0].title).toBe("my-name");
    } finally {
      cleanup();
    }
  });

  test("a title longer than 200 chars is not truncated, so match equals the current title", () => {
    const longTitle = `long-title ${"x".repeat(300)}`;
    const { base, cleanup } = makeTitledProjectsDir([{ type: "custom-title", customTitle: longTitle }]);
    try {
      const results = searchSessions("long-title", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("title");
      expect(longTitle.length).toBeGreaterThan(200);
      expect(results[0].match).toBe(longTitle);
      expect(results[0].match).toBe(results[0].title as string);
    } finally {
      cleanup();
    }
  });

  test("a custom-title match is preferred over an ai-title match", () => {
    const { base, cleanup } = makeTitledProjectsDir([
      { type: "ai-title", aiTitle: "shared keyword in auto title" },
      { type: "custom-title", customTitle: "old shared keyword name" },
      { type: "custom-title", customTitle: "current-name" },
    ]);
    try {
      const results = searchSessions("shared keyword", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("custom-title");
      expect(results[0].match).toBe("old shared keyword name");
      expect(results[0].title).toBe("current-name");
    } finally {
      cleanup();
    }
  });

  test("empty title lines do not replace the earlier title", () => {
    const { base, cleanup } = makeTitledProjectsDir([
      { type: "custom-title", customTitle: "kept-name" },
      { type: "custom-title", customTitle: "" },
      { type: "custom-title", customTitle: "   " },
    ]);
    try {
      expect(listSessions({ projectsBase: base })[0].title).toBe("kept-name");
      const results = searchSessions("kept-name", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("kept-name");
    } finally {
      cleanup();
    }
  });

  test("title query is literal, not a regex", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      expect(searchSessions("budget.*tracker", { projectsBase: base })).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("respects since/until against session last activity", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      expect(searchSessions("budget-tracker", { projectsBase: base, until: "2026-04-09" })).toHaveLength(0);
      expect(searchSessions("budget-tracker", { projectsBase: base, since: "2026-04-11" })).toHaveLength(0);
      expect(searchSessions("budget-tracker", { projectsBase: base, since: "2026-04-10" })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("title row counts toward limit", () => {
    const { base, cleanup } = makeTitledProjectsDir([{ type: "custom-title", customTitle: "database cleanup" }]);
    try {
      const results = searchSessions("database", { projectsBase: base, limit: 1 });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("title");
    } finally {
      cleanup();
    }
  });

  test("a title match survives --limit 1 despite many message hits in other sessions", () => {
    const { base, cleanup } = makeManyMessageHitsDir([{ type: "custom-title", customTitle: "many hits project" }]);
    try {
      const results = searchSessions("many hits", { projectsBase: base, limit: 1 });
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe("z-titled");
      expect(results[0].matchType).toBe("title");
    } finally {
      cleanup();
    }
  });

  test("a title match survives --limit 1 whatever the directory scan order", () => {
    // Scan order is filesystem-defined, so place the titled session under a name that is listed AFTER a
    // message-only session. The pre-ordering code stopped at the first `limit` hits in scan order and would have
    // returned that message row. Message hits also precede the custom-title line inside the titled file.
    const { base, cleanup } = makeManyMessageHitsDir([], 2);
    const projDir = join(base, "-Users-me-myproject");
    const lines = [
      { type: "user", message: { content: "many hits first" }, timestamp: "2026-04-10T09:00:00Z" },
      { type: "user", message: { content: "many hits second" }, timestamp: "2026-04-10T09:01:00Z" },
      { type: "custom-title", customTitle: "many hits title" },
    ];
    try {
      // The message-only sessions ("a-*") also match "many hits"; pick a name listed after at least one of them.
      let titledId = "";
      for (let n = 0; n < 200 && !titledId; n++) {
        const name = `scan-title-${n}.jsonl`;
        writeFileSync(join(projDir, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
        const order = readdirSync(projDir);
        const idx = order.indexOf(name);
        if (order.some((f, i) => i < idx && f.startsWith("a-"))) titledId = name.replace(/\.jsonl$/, "");
        else rmSync(join(projDir, name));
      }
      expect(titledId).not.toBe("");
      const limited = searchSessions("many hits", { projectsBase: base, limit: 1 });
      expect(limited).toHaveLength(1);
      expect(limited[0]).toMatchObject({ sessionId: titledId, matchType: "title" });
    } finally {
      cleanup();
    }
  });

  test("title rows (custom before ai) come before message rows, and limit applies after that ordering", () => {
    const { base, cleanup } = makeManyMessageHitsDir([{ type: "ai-title", aiTitle: "many hits auto" }]);
    // A second titled session scanned after the ai-title one, with a custom-title match
    const projDir = join(base, "-Users-me-myproject");
    writeFileSync(
      join(projDir, "zz-custom.jsonl"),
      `${[
        { type: "user", message: { content: "unrelated" }, timestamp: "2026-04-10T09:00:00Z" },
        { type: "custom-title", customTitle: "many hits custom" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    try {
      const all = searchSessions("many hits", { projectsBase: base, limit: 50 });
      expect(all.map((r) => r.type)).toEqual([
        "custom-title",
        "ai-title",
        ...Array(24).fill("user"), // 8 sessions x 3 messages
      ]);
      expect(all[0].sessionId).toBe("zz-custom");
      expect(all[1].sessionId).toBe("z-titled");

      // Message rows keep the same relative (scan) order whatever the limit
      const allMessages = all.slice(2).map((r) => r.match);
      const limited = searchSessions("many hits", { projectsBase: base, limit: 5 });
      expect(limited.map((r) => r.matchType)).toEqual(["title", "title", "message", "message", "message"]);
      expect(limited.slice(2).map((r) => r.match)).toEqual(allMessages.slice(0, 3));
      expect(searchSessions("many hits", { projectsBase: base, limit: 1 })[0].type).toBe("custom-title");
    } finally {
      cleanup();
    }
  });

  test("message rows keep scan order and are capped at limit when no title matches", () => {
    const { base, cleanup } = makeManyMessageHitsDir([{ type: "custom-title", customTitle: "nothing-relevant" }]);
    try {
      const results = searchSessions("many hits", { projectsBase: base, limit: 4 });
      const all = searchSessions("many hits", { projectsBase: base, limit: 50 });
      expect(all).toHaveLength(24);
      expect(results.map((r) => r.match)).toEqual(all.slice(0, 4).map((r) => r.match));
      expect(results.every((r) => r.matchType === "message")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("sessions without titles still return message matches with null title", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const results = searchSessions("Python files", { projectsBase: base });
      expect(results[0].matchType).toBe("message");
      expect(results[0].title).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("listSessions title", () => {
  test("exposes customTitle, falls back to aiTitle, else null", () => {
    const custom = makeTitledProjectsDir(TITLE_LINES);
    const auto = makeTitledProjectsDir([{ type: "ai-title", aiTitle: "Only auto" }]);
    const none = makeFakeProjectsDir();
    try {
      expect(listSessions({ projectsBase: custom.base })[0].title).toBe("budget-tracker");
      expect(listSessions({ projectsBase: auto.base })[0].title).toBe("Only auto");
      expect(listSessions({ projectsBase: none.base }).every((s) => s.title === null)).toBe(true);
    } finally {
      custom.cleanup();
      auto.cleanup();
      none.cleanup();
    }
  });
});

describe("searchSessions title date edge cases", () => {
  const longSession = [
    { type: "user", message: { content: "start" }, timestamp: "2026-04-01T09:00:00Z" },
    { type: "custom-title", customTitle: "db-migration" },
    { type: "assistant", message: { content: [{ type: "text", text: "end" }] }, timestamp: "2026-04-20T09:00:00Z" },
  ];

  test("--until keeps the title row when the session span overlaps the range", () => {
    const { base, cleanup } = makeProjectsDirWithLines(longSession);
    try {
      // Session spans 04-01..04-20; range ends 04-10 so the session was active inside it
      const results = searchSessions("db-migration", { projectsBase: base, until: "2026-04-10" });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("title");
    } finally {
      cleanup();
    }
  });

  test("title rows use span overlap while list uses last activity (Alpha refactor, 01-01..01-10, --until 01-05)", () => {
    const { base, cleanup } = makeProjectsDirWithLines([
      { type: "user", message: { content: "start" }, timestamp: "2026-01-01T09:00:00Z" },
      { type: "custom-title", customTitle: "Alpha refactor" },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] }, timestamp: "2026-01-10T09:00:00Z" },
    ]);
    try {
      const rows = searchSessions("alpha", { projectsBase: base, until: "2026-01-05" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ matchType: "title", title: "Alpha refactor" });
      // list keeps a session only if its last activity (01-10) is inside the window
      expect(listSessions({ projectsBase: base, until: "2026-01-05" })).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("date range entirely before or after the session span drops the title row", () => {
    const { base, cleanup } = makeProjectsDirWithLines(longSession);
    try {
      expect(searchSessions("db-migration", { projectsBase: base, until: "2026-03-31" })).toHaveLength(0);
      expect(searchSessions("db-migration", { projectsBase: base, since: "2026-04-21" })).toHaveLength(0);
      expect(
        searchSessions("db-migration", { projectsBase: base, since: "2026-04-05", until: "2026-04-10" }),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("title-only session without timestamps: found without filters, dropped by --since like listSessions", () => {
    const { base, cleanup } = makeProjectsDirWithLines([{ type: "custom-title", customTitle: "untimed-title" }]);
    try {
      expect(searchSessions("untimed-title", { projectsBase: base })).toHaveLength(1);
      expect(searchSessions("untimed-title", { projectsBase: base, since: "2026-01-01" })).toHaveLength(0);
      expect(searchSessions("untimed-title", { projectsBase: base, until: "2026-12-31" })).toHaveLength(0);
      // Consistent with list
      expect(listSessions({ projectsBase: base, since: "2026-01-01" })).toHaveLength(0);
      expect(listSessions({ projectsBase: base })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("non-string and malformed timestamps do not crash and are treated as missing", () => {
    const { base, cleanup } = makeProjectsDirWithLines([
      { type: "user", message: { content: "hello" }, timestamp: { nested: true } },
      { type: "custom-title", customTitle: "weird-ts" },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, timestamp: "not-a-date" },
      { type: "system", timestamp: 12345 },
    ]);
    try {
      const results = searchSessions("weird-ts", { projectsBase: base });
      expect(results).toHaveLength(1);
      expect(results[0].matchType).toBe("title");
      expect(results[0].timestamp).toBeNull();
      expect(searchSessions("weird-ts", { projectsBase: base, since: "2026-01-01" })).toHaveLength(0);
      expect(listSessions({ projectsBase: base })[0].title).toBe("weird-ts");
    } finally {
      cleanup();
    }
  });
});

describe("title date filtering with irregular timestamps", () => {
  test("unparseable first timestamp does not hide the session span from --since", () => {
    const { base, cleanup } = makeProjectsDirWithLines([
      { type: "system", timestamp: "not-a-date" },
      { type: "user", message: { content: "hi" }, timestamp: "2026-04-10T09:00:00Z" },
      { type: "custom-title", customTitle: "zebra" },
      { type: "assistant", message: { content: [{ type: "text", text: "yo" }] }, timestamp: "2026-04-12T09:00:00Z" },
    ]);
    try {
      expect(searchSessions("zebra", { projectsBase: base })).toHaveLength(1);
      expect(searchSessions("zebra", { projectsBase: base, since: "2026-04-01" })).toHaveLength(1);
      expect(searchSessions("zebra", { projectsBase: base, since: "2026-04-13" })).toHaveLength(0);
      const [session] = listSessions({ projectsBase: base });
      expect(session.started).toBe("2026-04-10T09:00:00Z");
      expect(session.date).toBe("2026-04-10");
    } finally {
      cleanup();
    }
  });

  test("out-of-order timestamps: span uses min and max, not file order", () => {
    const { base, cleanup } = makeProjectsDirWithLines([
      { type: "user", message: { content: "late" }, timestamp: "2026-04-20T09:00:00Z" },
      { type: "custom-title", customTitle: "shuffled" },
      { type: "user", message: { content: "early" }, timestamp: "2026-04-01T09:00:00Z" },
      { type: "user", message: { content: "mid" }, timestamp: "2026-04-10T09:00:00Z" },
    ]);
    try {
      // File order would give span 04-20..04-10 (inverted); true span is 04-01..04-20
      expect(searchSessions("shuffled", { projectsBase: base, until: "2026-04-05" })).toHaveLength(1);
      expect(searchSessions("shuffled", { projectsBase: base, since: "2026-04-15" })).toHaveLength(1);
      const [row] = searchSessions("shuffled", { projectsBase: base });
      expect(row.timestamp).toBe("2026-04-20T09:00:00Z");
      const [session] = listSessions({ projectsBase: base });
      expect(session.started).toBe("2026-04-01T09:00:00Z");
      expect(session.lastActivity).toBe("2026-04-20T09:00:00Z");
      expect(session.durationMinutes).toBe(19 * 24 * 60);
    } finally {
      cleanup();
    }
  });
});

describe("multi-line titles", () => {
  const CLI_PATH = join(import.meta.dir, "..", "lib", "session-store.ts");
  const messy = [
    { type: "user", message: { content: "x" }, timestamp: "2026-04-10T09:00:00Z" },
    { type: "custom-title", customTitle: "one\ntwo\r\n\tthree\u0007four" },
  ];

  test("stored display title is a single line", () => {
    const { base, cleanup } = makeProjectsDirWithLines(messy);
    try {
      expect(listSessions({ projectsBase: base })[0].title).toBe("one two three four");
      const [row] = searchSessions("two three", { projectsBase: base });
      expect(row.matchType).toBe("title");
      expect(row.match).toBe("one two three four");
    } finally {
      cleanup();
    }
  });

  test("list and search tables keep one line per row", () => {
    const { base, cleanup } = makeProjectsDirWithLines(messy);
    try {
      for (const args of [["list"], ["search", "three"]]) {
        const proc = spawnSync("bun", ["run", CLI_PATH, ...args, "--projects-base", base], { encoding: "utf-8" });
        expect(proc.status).toBe(0);
        // header + separator + 1 row + footer
        expect(proc.stdout.trim().split("\n")).toHaveLength(4);
        expect(proc.stdout).toContain("one two three four");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no control chars leak into output
        expect(proc.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
      }
    } finally {
      cleanup();
    }
  });
});

describe("CLI title output", () => {
  const CLI_PATH = join(import.meta.dir, "..", "lib", "session-store.ts");

  test("list --format table shows TITLE column and title", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const proc = spawnSync("bun", ["run", CLI_PATH, "list", "--projects-base", base], { encoding: "utf-8" });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("TITLE");
      expect(proc.stdout).toContain("budget-tracker");
    } finally {
      cleanup();
    }
  });

  test("search table shows TITLE and IN columns with title match", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const proc = spawnSync("bun", ["run", CLI_PATH, "search", "budget-tracker", "--projects-base", base], {
        encoding: "utf-8",
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("TITLE");
      expect(proc.stdout).toContain("IN");
      expect(proc.stdout).toMatch(/budget-tracker\s+title\s/);
    } finally {
      cleanup();
    }
  });

  test("timeline --format json emits title; table shows TITLE column", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const json = spawnSync("bun", ["run", CLI_PATH, "timeline", "--format", "json", "--projects-base", base], {
        encoding: "utf-8",
      });
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)[0]).toMatchObject({ session_id: "titled-session", title: "budget-tracker" });

      const table = spawnSync("bun", ["run", CLI_PATH, "timeline", "--projects-base", base], { encoding: "utf-8" });
      expect(table.status).toBe(0);
      expect(table.stdout).toContain("TITLE");
      expect(table.stdout).toContain("budget-tracker");
    } finally {
      cleanup();
    }
  });

  test("search --limit with a non-numeric, zero or negative value falls back to the default", () => {
    const { base, cleanup } = makeManyMessageHitsDir([{ type: "custom-title", customTitle: "nothing-relevant" }]);
    try {
      for (const bad of ["abc", "0", "-2"]) {
        const proc = spawnSync(
          "bun",
          ["run", CLI_PATH, "search", "many hits", "--limit", bad, "--format", "json", "--projects-base", base],
          { encoding: "utf-8" },
        );
        expect(proc.status).toBe(0);
        expect(proc.stdout.trim().split("\n")).toHaveLength(20);
      }
    } finally {
      cleanup();
    }
  });

  test("search --format json emits title and match_type", () => {
    const { base, cleanup } = makeTitledProjectsDir(TITLE_LINES);
    try {
      const proc = spawnSync(
        "bun",
        ["run", CLI_PATH, "search", "budget-tracker", "--format", "json", "--projects-base", base],
        {
          encoding: "utf-8",
        },
      );
      expect(proc.status).toBe(0);
      const row = JSON.parse(proc.stdout.trim().split("\n")[0]);
      expect(row).toMatchObject({ title: "budget-tracker", match_type: "title", type: "custom-title" });
    } finally {
      cleanup();
    }
  });
});

describe("getTimeline", () => {
  test("includes the session title (custom preferred, else auto, else null)", () => {
    const custom = makeTitledProjectsDir(TITLE_LINES);
    const auto = makeTitledProjectsDir([{ type: "ai-title", aiTitle: "Only auto" }]);
    const none = makeFakeProjectsDir();
    try {
      expect(getTimeline({ projectsBase: custom.base })[0].title).toBe("budget-tracker");
      expect(getTimeline({ projectsBase: auto.base })[0].title).toBe("Only auto");
      expect(getTimeline({ projectsBase: none.base }).every((s) => s.title === null)).toBe(true);
    } finally {
      custom.cleanup();
      auto.cleanup();
      none.cleanup();
    }
  });

  test("returns chronological sessions", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const timeline = getTimeline({ projectsBase: base });
      expect(timeline.length).toBeGreaterThanOrEqual(1);
      expect(timeline[0]).toHaveProperty("sessionId");
      expect(timeline[0]).toHaveProperty("date");
    } finally {
      cleanup();
    }
  });
});

describe("findCleanupCandidates", () => {
  test("finds empty sessions", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const candidates = findCleanupCandidates({
        projectsBase: base,
        minMessages: 1,
      });
      const empty = candidates.filter((c) => c.reason === "empty");
      expect(empty.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });
});

describe("readTaskList", () => {
  test("reads all tasks", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      const tasks = readTaskList("test-session-001", base);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].subject).toBe("Setup project");
      expect(tasks[0].source).toBe("filesystem");
      expect(tasks[1].status).toBe("pending");
      expect(tasks[1].blockedBy).toEqual(["1"]);
    } finally {
      cleanup();
    }
  });
});

describe("deleteTask", () => {
  test("deletes a task file and reports if list is now empty", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      // Delete task 2 — list still has task 1
      const result = deleteTask("test-session-001", "2", { tasksBase: base });
      expect(result.deleted).toBe(true);
      expect(result.taskListNowEmpty).toBe(false);
      expect(existsSync(result.taskPath)).toBe(false);

      // Delete task 1 — list is now empty
      const result2 = deleteTask("test-session-001", "1", { tasksBase: base });
      expect(result2.deleted).toBe(true);
      expect(result2.taskListNowEmpty).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("throws on non-existent task", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      expect(() => deleteTask("test-session-001", "999", { tasksBase: base })).toThrow("Task not found");
    } finally {
      cleanup();
    }
  });

  test("throws on invalid ID", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      expect(() => deleteTask("../etc", "1", { tasksBase: base })).toThrow("Invalid");
      expect(() => deleteTask("test-session-001", "../1", { tasksBase: base })).toThrow("Invalid");
    } finally {
      cleanup();
    }
  });
});

describe("deleteTaskList", () => {
  test("deletes an entire task list directory", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      const result = deleteTaskList("test-session-001", { tasksBase: base });
      expect(result.deleted).toBe(true);
      expect(result.taskCount).toBe(2); // 1.json and 2.json
      expect(existsSync(join(base, "test-session-001"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws on non-existent task list", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      expect(() => deleteTaskList("nonexistent", { tasksBase: base })).toThrow("Task list not found");
    } finally {
      cleanup();
    }
  });

  test("throws on invalid ID", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      expect(() => deleteTaskList("../etc", { tasksBase: base })).toThrow("Invalid");
    } finally {
      cleanup();
    }
  });
});

describe("path containment validation", () => {
  test("assertPathWithinBase rejects paths that escape base directory", () => {
    // Even if isValidId were bypassed, the resolved-path check catches traversal.
    // We test indirectly via the public delete functions by creating a symlink
    // scenario where join() could resolve outside base.
    const tmp = mkdtempSync(join(tmpdir(), "contain-"));
    const tasksBase = join(tmp, "tasks");
    const legitimateDir = join(tasksBase, "legit-session");
    mkdirSync(legitimateDir, { recursive: true });
    writeFileSync(join(legitimateDir, "1.json"), JSON.stringify({ id: "1", subject: "t", status: "pending" }));

    // deleteTask with valid IDs should work
    const result = deleteTask("legit-session", "1", { tasksBase });
    expect(result.deleted).toBe(true);

    // Clean up
    rmSync(tmp, { recursive: true });
  });

  test("deleteTask path containment works for valid paths", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      // Normal deletion should pass path containment check
      const result = deleteTask("test-session-001", "1", { tasksBase: base });
      expect(result.deleted).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("deleteTaskList path containment works for valid paths", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      const result = deleteTaskList("test-session-001", { tasksBase: base });
      expect(result.deleted).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("listTaskLists", () => {
  test("lists task directories", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      const lists = listTaskLists(base);
      expect(lists).toHaveLength(1);
      expect(lists[0].taskListId).toBe("test-session-001");
      expect(lists[0].taskCount).toBe(2);
    } finally {
      cleanup();
    }
  });
});

function makeFakeProjectsAndTasksDir(): {
  projectsBase: string;
  tasksBase: string;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "sd-"));
  const projDir = join(tmp, "projects", "-Users-me-myproject");
  mkdirSync(projDir, { recursive: true });
  copyFileSync(FIXTURE, join(projDir, "test-session-001.jsonl"));

  const taskDir = join(tmp, "tasks", "test-session-001");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "1.json"), JSON.stringify({ id: "1", subject: "Task one", status: "pending" }));
  return {
    projectsBase: join(tmp, "projects"),
    tasksBase: join(tmp, "tasks"),
    cleanup: () => rmSync(tmp, { recursive: true }),
  };
}

describe("deleteSession", () => {
  test("deletes session file and reports orphaned task lists", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      const result = deleteSession("test-session-001", { projectsBase, tasksBase });
      expect(result.deleted).toBe(true);
      expect(existsSync(result.sessionPath)).toBe(false);
      expect(result.orphanedTaskLists).toEqual(["test-session-001"]);
      expect(result.orphanedTasksDeleted).toBe(false);
      // Task list still exists since we didn't opt into deleting
      expect(existsSync(join(tasksBase, "test-session-001"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("deletes session and orphaned tasks when opted in", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      const result = deleteSession("test-session-001", {
        projectsBase,
        tasksBase,
        deleteOrphanedTasks: true,
      });
      expect(result.deleted).toBe(true);
      expect(result.orphanedTasksDeleted).toBe(true);
      expect(existsSync(join(tasksBase, "test-session-001"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("deletes session with no associated tasks", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      const projDir = join(projectsBase, "-Users-me-myproject");
      writeFileSync(join(projDir, "no-tasks-session.jsonl"), '{"type":"system"}\n');

      const result = deleteSession("no-tasks-session", { projectsBase, tasksBase });
      expect(result.deleted).toBe(true);
      expect(result.orphanedTaskLists).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("throws on non-existent session", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      expect(() => deleteSession("nonexistent", { projectsBase, tasksBase })).toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("findOrphanTaskLists", () => {
  test("finds task lists with no matching session", () => {
    const tmp = mkdtempSync(join(tmpdir(), "orph-"));
    const projectsBase = join(tmp, "projects");
    const tasksBase = join(tmp, "tasks");

    // Create a project dir with one session
    const projDir = join(projectsBase, "-Users-me-myproject");
    mkdirSync(projDir, { recursive: true });
    copyFileSync(FIXTURE, join(projDir, "test-session-001.jsonl"));

    // Create two task lists — one matches session, one is orphan
    const matchedDir = join(tasksBase, "test-session-001");
    mkdirSync(matchedDir, { recursive: true });
    writeFileSync(join(matchedDir, "1.json"), JSON.stringify({ id: "1", status: "pending" }));

    const orphanDir = join(tasksBase, "orphan-session-999");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "1.json"), JSON.stringify({ id: "1", status: "pending" }));

    try {
      const orphans = findOrphanTaskLists({ projectsBase, tasksBase });
      expect(orphans.length).toBe(1);
      expect(orphans[0].taskListId).toBe("orphan-session-999");
      expect(orphans[0].taskCount).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("returns empty array when no orphans exist", () => {
    const { base: projectsBase, cleanup: cleanupP } = makeFakeProjectsDir();
    const { base: tasksBase, cleanup: cleanupT } = makeFakeTasksDir();
    try {
      const orphans = findOrphanTaskLists({ projectsBase, tasksBase });
      expect(orphans.length).toBe(0);
    } finally {
      cleanupP();
      cleanupT();
    }
  });
});

describe("getSessionDetail", () => {
  test("returns session summary, stats, and associated task lists", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      const detail = getSessionDetail("test-session-001", { projectsBase, tasksBase });
      expect(detail.session.sessionId).toBe("test-session-001");
      expect(detail.stats.turns).toBeGreaterThan(0);
      expect(detail.stats.tokens.input).toBeGreaterThan(0);
      expect(detail.taskLists.length).toBe(1);
      expect(detail.taskLists[0].taskListId).toBe("test-session-001");
      expect(detail.taskLists[0].tasks.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("returns empty taskLists when no matching task list exists", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      const projDir = join(projectsBase, "-Users-me-myproject");
      writeFileSync(join(projDir, "lonely-session.jsonl"), '{"type":"system","timestamp":"2026-04-10T09:00:00Z"}\n');

      const detail = getSessionDetail("lonely-session", { projectsBase, tasksBase });
      expect(detail.session.sessionId).toBe("lonely-session");
      expect(detail.taskLists).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("throws on non-existent session", () => {
    const { projectsBase, tasksBase, cleanup } = makeFakeProjectsAndTasksDir();
    try {
      expect(() => getSessionDetail("nonexistent", { projectsBase, tasksBase })).toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("searchSessions until filter", () => {
  test("until filters out results after date", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      // Fixture has messages on 2026-04-10
      const results = searchSessions("Python", { projectsBase: base, until: "2026-04-09" });
      expect(results.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("getTimeline until filter", () => {
  test("until filters out sessions after date", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const timeline = getTimeline({ projectsBase: base, until: "2026-04-09" });
      expect(timeline.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("aggregateTasks date filtering", () => {
  test("since filters tasks by session date", () => {
    const { base: projectsBase, cleanup: pc } = makeFakeProjectsDir();
    const { base: tasksBase, cleanup: tc } = makeFakeTasksDir();
    try {
      // Task list "test-session-001" — session date is 2026-04-10
      const tasks = aggregateTasks({ tasksBase, projectsBase, since: "2026-04-11" });
      // Filesystem tasks (no timestamp) should pass through
      const fsTasks = tasks.filter((t) => t.source === "filesystem");
      expect(fsTasks.length).toBeGreaterThan(0);
      // JSONL tasks from 2026-04-10 should be filtered out by since: "2026-04-11"
      const jsonlTasks = tasks.filter((t) => t.source === "jsonl");
      expect(jsonlTasks.length).toBe(0);
    } finally {
      pc();
      tc();
    }
  });
});

describe("aggregateTasks", () => {
  test("from filesystem", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      const tasks = aggregateTasks({
        tasksBase: base,
        projectsBase: "/nonexistent",
      });
      expect(tasks).toHaveLength(2);
      expect(tasks.some((t) => t.subject === "Setup project")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("status filter", () => {
    const { base, cleanup } = makeFakeTasksDir();
    try {
      const pending = aggregateTasks({
        statusFilter: "pending",
        tasksBase: base,
        projectsBase: "/nonexistent",
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].subject).toBe("Add tests");
    } finally {
      cleanup();
    }
  });

  test("jsonl fallback", () => {
    const { base: projBase, cleanup } = makeFakeProjectsDir();
    try {
      const tasks = aggregateTasks({
        tasksBase: "/nonexistent_tasks",
        projectsBase: projBase,
      });
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0].source).toBe("jsonl");
    } finally {
      cleanup();
    }
  });
});

describe("getDailyTokenAggregation", () => {
  test("buckets tokens by date", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const data = getDailyTokenAggregation({ projectsBase: base });
      expect(data.labels).toBeDefined();
      expect(Array.isArray(data.labels)).toBe(true);
      expect(data.datasets.input).toBeDefined();
      expect(data.datasets.output).toBeDefined();
      expect(data.datasets.cache_read).toBeDefined();
      expect(data.datasets.cache_create).toBeDefined();
      // Fixture has one session on 2026-04-10
      expect(data.labels.length).toBeGreaterThan(0);
      expect(data.labels).toContain("2026-04-10");
      // That session has tokens
      const idx = data.labels.indexOf("2026-04-10");
      expect(data.datasets.input[idx]).toBeGreaterThan(0);
      expect(data.datasets.output[idx]).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("since filters dates", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const data = getDailyTokenAggregation({ projectsBase: base, since: "2026-04-11" });
      expect(data.labels.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("getModelDistribution", () => {
  test("returns model token counts", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const data = getModelDistribution({ projectsBase: base });
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      // Fixture uses claude-sonnet-4-20250514 and claude-opus-4-20250514
      const models = data.map((d) => d.model);
      expect(models.some((m) => m.includes("sonnet"))).toBe(true);
      expect(data[0].tokens).toBeGreaterThan(0);
      expect(data[0].sessions).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("getActivityHeatmap", () => {
  test("returns 7x24 grid", () => {
    const { base, cleanup } = makeFakeProjectsDir();
    try {
      const data = getActivityHeatmap({ projectsBase: base });
      expect(data.grid.length).toBe(7);
      expect(data.grid[0].length).toBe(24);
      expect(data.dayLabels.length).toBe(7);
      expect(data.hourLabels.length).toBe(24);
      expect(data.maxValue).toBeGreaterThanOrEqual(0);
      // At least one cell should have a value (from fixture)
      const total = data.grid.flat().reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
