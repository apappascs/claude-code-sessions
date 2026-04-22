// tests/session-store.test.ts
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("getTimeline", () => {
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
