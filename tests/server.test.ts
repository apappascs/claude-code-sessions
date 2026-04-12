// tests/server.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
