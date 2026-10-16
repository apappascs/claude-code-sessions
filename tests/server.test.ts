// tests/server.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "sample_session.jsonl");

// biome-ignore lint/complexity/noBannedTypes: dynamic import test helper
let createHandler: Function;
let tmpDir: string;
let projectsBase: string;
let tasksBase: string;

beforeAll(async () => {
  const mod = await import("../ui/server");
  createHandler = mod.createHandler;

  tmpDir = mkdtempSync(join(tmpdir(), "srv-"));
  projectsBase = join(tmpDir, "projects");
  tasksBase = join(tmpDir, "tasks");

  const projDir = join(projectsBase, "-Users-me-myproject");
  mkdirSync(projDir, { recursive: true });
  copyFileSync(FIXTURE, join(projDir, "test-session-001.jsonl"));

  const taskDir = join(tasksBase, "test-session-001");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "1.json"),
    JSON.stringify({
      id: "1",
      subject: "Setup project",
      description: "Init repo",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }),
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true });
});

async function request(path: string): Promise<Response> {
  const handler = createHandler({ projectsBase, tasksBase });
  return handler(new Request(`http://localhost${path}`));
}

async function requestWithMethod(method: string, path: string): Promise<Response> {
  const handler = createHandler({ projectsBase, tasksBase });
  return handler(new Request(`http://localhost${path}`, { method }));
}

describe("API routes", () => {
  test("GET /api/sessions returns JSON array", async () => {
    const res = await request("/api/sessions?limit=10");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]).toHaveProperty("session_id");
  });

  test("GET /api/sessions/stats returns stats object", async () => {
    const path = join(projectsBase, "-Users-me-myproject", "test-session-001.jsonl");
    const res = await request(`/api/sessions/stats?path=${encodeURIComponent(path)}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("turns");
    expect(data).toHaveProperty("tokens");
  });

  test("GET /api/search returns results", async () => {
    const res = await request(`/api/search?query=${encodeURIComponent("Python files")}&limit=5`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /api/search matches session titles and /api/sessions exposes them", async () => {
    const file = join(projectsBase, "-Users-me-myproject", "titled-session.jsonl");
    writeFileSync(
      file,
      `${[
        { type: "user", message: { content: "hello" }, timestamp: "2026-04-10T09:00:00Z" },
        { type: "custom-title", customTitle: "budget-tracker" },
        { type: "ai-title", aiTitle: "Quarterly budget review" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    try {
      const search = await (await request("/api/search?query=budget-tracker")).json();
      expect(search).toHaveLength(1);
      expect(search[0]).toMatchObject({ session_id: "titled-session", match_type: "title", title: "budget-tracker" });

      const sessions = await (await request("/api/sessions?limit=10")).json();
      const titled = sessions.find((s: { session_id: string }) => s.session_id === "titled-session");
      expect(titled.title).toBe("budget-tracker");

      const detail = await (await request("/api/sessions/titled-session")).json();
      expect(detail.session.title).toBe("budget-tracker");

      const timeline = await (await request("/api/timeline")).json();
      const timelineRow = timeline.find((s: { session_id: string }) => s.session_id === "titled-session");
      expect(timelineRow.title).toBe("budget-tracker");
    } finally {
      rmSync(file);
    }
  });

  test("GET /api/search lists title matches before message matches so limit=1 returns the title row", async () => {
    const dir = join(projectsBase, "-Users-me-myproject");
    const jsonl = (lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    const userLine = (text: string) => ({
      type: "user",
      message: { content: text },
      timestamp: "2026-04-10T09:00:00Z",
    });
    const extra = Array.from({ length: 3 }, (_, i) => join(dir, `msg-hits-${i}.jsonl`));
    for (const f of extra) writeFileSync(f, jsonl([userLine("list the Python files")]));

    // Directory scan order is filesystem-defined. Try names for the titled file until a message-only file is
    // listed before it, so the pre-ordering code (which stopped at the first `limit` hits in scan order) would
    // have returned a message row. Message hits also precede the custom-title line inside the titled file.
    const titledLines = jsonl([
      userLine("list the Python files"),
      userLine("more Python files please"),
      { type: "custom-title", customTitle: "Python files cleanup" },
    ]);
    let file = "";
    for (let n = 0; n < 200 && !file; n++) {
      const candidate = join(dir, `zz-title-${n}.jsonl`);
      writeFileSync(candidate, titledLines);
      const order = readdirSync(dir);
      const titledIdx = order.indexOf(`zz-title-${n}.jsonl`);
      if (extra.some((f) => order.indexOf(f.slice(dir.length + 1)) < titledIdx)) file = candidate;
      else rmSync(candidate);
    }
    expect(file).not.toBe("");
    const titledId = file.slice(dir.length + 1).replace(/\.jsonl$/, "");
    try {
      const limited = await (await request(`/api/search?query=${encodeURIComponent("Python files")}&limit=1`)).json();
      expect(limited).toHaveLength(1);
      expect(limited[0]).toMatchObject({ session_id: titledId, match_type: "title" });

      const all = await (await request(`/api/search?query=${encodeURIComponent("Python files")}&limit=20`)).json();
      expect(all[0]).toMatchObject({ session_id: titledId, match_type: "title" });
      expect(all.slice(1).every((r: { match_type: string }) => r.match_type === "message")).toBe(true);
    } finally {
      if (file) rmSync(file);
      for (const f of extra) rmSync(f);
    }
  });

  test("GET /api/search falls back to the default limit for a non-numeric, zero or negative limit", async () => {
    const q = encodeURIComponent("Python files");
    const baseline = await (await request(`/api/search?query=${q}&limit=20`)).json();
    expect(baseline.length).toBeGreaterThanOrEqual(1);
    for (const bad of ["abc", "0", "-3", ""]) {
      const res = await request(`/api/search?query=${q}&limit=${bad}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(baseline);
    }
  });

  test("GET /api/search finds a session by an earlier title and shows the current one", async () => {
    const file = join(projectsBase, "-Users-me-myproject", "renamed-session.jsonl");
    writeFileSync(
      file,
      `${[
        { type: "user", message: { content: "hello" }, timestamp: "2026-04-10T09:00:00Z" },
        { type: "custom-title", customTitle: "early-name" },
        { type: "custom-title", customTitle: "late-name" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    try {
      const search = await (await request("/api/search?query=early-name")).json();
      expect(search).toHaveLength(1);
      expect(search[0]).toMatchObject({
        session_id: "renamed-session",
        match_type: "title",
        type: "custom-title",
        match: "early-name",
        title: "late-name",
      });
    } finally {
      rmSync(file);
    }
  });

  test("index.html renders titles via escaped x-text bindings only (no x-html)", async () => {
    const html = await (await request("/")).text();
    expect(html).toContain("badge--title");
    expect(html).toContain('x-text="s.title');
    expect(html).toContain("'Current title: ' + r.title");
    // The query is regex-escaped and matched literally, so the UI must not advertise regex support
    expect(html).toContain("(literal text)");
    expect(html).not.toContain("supports regex");
    expect(html).toContain("r.match_type === 'title'");
    // Titles come from JSONL; x-text escapes, x-html would not
    expect(html).not.toContain("x-html");
  });

  test("GET /api/tasks returns tasks", async () => {
    const res = await request("/api/tasks");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /api/tasks/lists returns task lists", async () => {
    const res = await request("/api/tasks/lists");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /api/dashboard/stats returns aggregate stats", async () => {
    const res = await request("/api/dashboard/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("totalSessions");
    expect(data).toHaveProperty("totalProjects");
    expect(data).toHaveProperty("pendingTasks");
  });

  test("GET / serves index.html", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /api/unknown returns 404", async () => {
    const res = await request("/api/unknown-route");
    expect(res.status).toBe(404);
  });
});

describe("New GET API routes", () => {
  test("GET /api/sessions/:id returns session detail", async () => {
    const res = await request("/api/sessions/test-session-001");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("session");
    expect(data).toHaveProperty("stats");
    expect(data).toHaveProperty("task_lists");
    expect(data.session.session_id).toBe("test-session-001");
    expect(data.stats.tokens.input).toBeGreaterThan(0);
  });

  test("GET /api/sessions/:id returns 404 for unknown session", async () => {
    const res = await request("/api/sessions/nonexistent-session-999");
    expect(res.status).toBe(404); // resolveSession throws
  });

  test("GET /api/sessions/:id/messages returns paginated messages", async () => {
    const res = await request("/api/sessions/test-session-001/messages?limit=2&offset=0");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("messages");
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("hasMore");
    expect(data.messages.length).toBeLessThanOrEqual(2);
  });

  test("GET /api/tasks/orphans returns orphan list", async () => {
    const res = await request("/api/tasks/orphans");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("DELETE API routes", () => {
  test("DELETE /api/tasks/:listId/:taskId deletes a task", async () => {
    const sacrificialDir = join(tasksBase, "delete-test-list");
    mkdirSync(sacrificialDir, { recursive: true });
    writeFileSync(
      join(sacrificialDir, "99.json"),
      JSON.stringify({ id: "99", subject: "To delete", status: "pending" }),
    );
    writeFileSync(join(sacrificialDir, "100.json"), JSON.stringify({ id: "100", subject: "Keep", status: "pending" }));

    const res = await requestWithMethod("DELETE", "/api/tasks/delete-test-list/99");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
    expect(data.task_list_now_empty).toBe(false);
  });

  test("DELETE /api/tasks/:listId deletes a task list", async () => {
    const sacrificialDir = join(tasksBase, "delete-list-test");
    mkdirSync(sacrificialDir, { recursive: true });
    writeFileSync(join(sacrificialDir, "1.json"), JSON.stringify({ id: "1", subject: "Gone", status: "pending" }));

    const res = await requestWithMethod("DELETE", "/api/tasks/delete-list-test");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
  });

  test("DELETE /api/sessions/:id deletes a session", async () => {
    const projDir = join(projectsBase, "-Users-me-myproject");
    writeFileSync(join(projDir, "delete-me.jsonl"), '{"type":"system"}\n');

    const res = await requestWithMethod("DELETE", "/api/sessions/delete-me");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
  });

  test("DELETE /api/sessions/:id?delete_tasks=true also deletes tasks", async () => {
    const projDir = join(projectsBase, "-Users-me-myproject");
    writeFileSync(join(projDir, "cascade-me.jsonl"), '{"type":"system"}\n');
    const taskDir = join(tasksBase, "cascade-me");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "1.json"), JSON.stringify({ id: "1", status: "pending" }));

    const res = await requestWithMethod("DELETE", "/api/sessions/cascade-me?delete_tasks=true");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
    expect(data.orphaned_tasks_deleted).toBe(true);
  });

  test("DELETE with invalid ID returns 400", async () => {
    const res = await requestWithMethod("DELETE", "/api/sessions/bad..id");
    expect(res.status).toBe(400);
  });
});

describe("Path traversal protection", () => {
  test("GET with encoded dot-dot traversal returns 403", async () => {
    // %2e%2e%2f is ../ percent-encoded — URL parser keeps it literal,
    // but decodeURIComponent resolves it to ../ which escapes publicDir
    const publicDir = mkdtempSync(join(tmpdir(), "pub-"));
    writeFileSync(join(publicDir, "index.html"), "<html>ok</html>");
    const handler = createHandler({ projectsBase, tasksBase, publicDir });

    const res = await handler(new Request("http://localhost/%2e%2e%2f%2e%2e%2fetc%2fpasswd"));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe("Forbidden");

    rmSync(publicDir, { recursive: true });
  });

  test("GET with encoded slash traversal returns 403", async () => {
    // %2f is / percent-encoded — URL parser keeps it literal in pathname,
    // but decodeURIComponent + join resolves it as a real path separator
    const publicDir = mkdtempSync(join(tmpdir(), "pub-"));
    writeFileSync(join(publicDir, "index.html"), "<html>ok</html>");
    const handler = createHandler({ projectsBase, tasksBase, publicDir });

    const res = await handler(new Request("http://localhost/css%2f..%2f..%2f..%2f..%2fetc%2fpasswd"));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe("Forbidden");

    rmSync(publicDir, { recursive: true });
  });

  test("GET for valid static file still works", async () => {
    const publicDir = mkdtempSync(join(tmpdir(), "pub-"));
    writeFileSync(join(publicDir, "index.html"), "<html>hello</html>");
    const handler = createHandler({ projectsBase, tasksBase, publicDir });

    const res = await handler(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("<html>hello</html>");

    rmSync(publicDir, { recursive: true });
  });
});

describe("chart API endpoints", () => {
  test("GET /api/charts/daily-tokens returns chart data", async () => {
    const res = await request("/api/charts/daily-tokens?since=2026-04-01");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.labels).toBeDefined();
    expect(data.datasets).toBeDefined();
    expect(data.datasets.input).toBeDefined();
    expect(data.datasets.output).toBeDefined();
    expect(data.datasets.cache_read).toBeDefined();
    expect(data.datasets.cache_create).toBeDefined();
  });

  test("GET /api/charts/model-distribution returns model data", async () => {
    const res = await request("/api/charts/model-distribution");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0].model).toBeDefined();
      expect(data[0].tokens).toBeDefined();
      expect(data[0].sessions).toBeDefined();
    }
  });

  test("GET /api/charts/activity-heatmap returns grid", async () => {
    const res = await request("/api/charts/activity-heatmap");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.grid.length).toBe(7);
    expect(data.grid[0].length).toBe(24);
    expect(data.dayLabels.length).toBe(7);
    expect(data.hourLabels.length).toBe(24);
  });
});

describe("date param passthrough", () => {
  test("GET /api/sessions with since param", async () => {
    const res = await request("/api/sessions?since=2026-04-09&limit=10");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // Fixture session is from 2026-04-10, so it should be included
    expect(data.length).toBeGreaterThan(0);
  });

  test("GET /api/sessions with since param filters correctly", async () => {
    const res = await request("/api/sessions?since=2026-04-11&limit=10");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(0);
  });

  test("GET /api/sessions with until param", async () => {
    const res = await request("/api/sessions?until=2026-04-09&limit=10");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(0);
  });

  test("GET /api/dashboard/stats with since param", async () => {
    const res = await request("/api/dashboard/stats?since=2026-04-09");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalSessions).toBeGreaterThan(0);
  });
});
