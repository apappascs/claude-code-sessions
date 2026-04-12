// ui/server.ts

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getMessagesPaginated, getStats } from "../lib/session-parser";
import {
  aggregateTasks,
  deleteSession,
  deleteTask,
  deleteTaskList,
  findCleanupCandidates,
  findOrphanTaskLists,
  getSessionDetail,
  getTimeline,
  isValidId,
  listSessions,
  listTaskLists,
  resolveSession,
  searchSessions,
} from "../lib/session-store";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface ServerOptions {
  projectsBase?: string;
  tasksBase?: string;
  publicDir?: string;
  port?: number;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

export function createHandler(opts: ServerOptions = {}) {
  const projectsBase = opts.projectsBase || join(homedir(), ".claude", "projects");
  const tasksBase = opts.tasksBase || join(homedir(), ".claude", "tasks");
  const publicDir = opts.publicDir || join(import.meta.dir, "public");

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── API routes ──
    if (path.startsWith("/api/")) {
      try {
        return routeApi(req.method, path, url.searchParams, projectsBase, tasksBase);
      } catch (e: any) {
        console.error("API error:", e);
        return errorResponse(e.message || "Internal error", 500);
      }
    }

    // ── Static files ──
    const decodedPath = decodeURIComponent(path);
    const filePath = decodedPath === "/" ? join(publicDir, "index.html") : join(publicDir, decodedPath);

    // Path traversal protection: reject requests that escape publicDir
    const resolvedPublic = resolve(publicDir);
    const resolvedFile = resolve(filePath);
    if (!resolvedFile.startsWith(`${resolvedPublic}/`) && resolvedFile !== resolvedPublic) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      statSync(filePath);
    } catch {
      // SPA fallback — serve index.html for unknown paths
      const indexPath = join(publicDir, "index.html");
      try {
        const content = readFileSync(indexPath);
        return new Response(content, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    const ext = `.${filePath.split(".").pop()}`;
    const contentType = MIME[ext] || "application/octet-stream";
    const content = readFileSync(filePath);
    return new Response(content, {
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache",
      },
    });
  };
}

function routeApi(
  method: string,
  path: string,
  params: URLSearchParams,
  projectsBase: string,
  tasksBase: string,
): Response {
  // GET /api/sessions
  if (path === "/api/sessions" && method === "GET") {
    const sessions = listSessions({
      projectsBase,
      projectFilter: params.get("project") || undefined,
      sort: (params.get("sort") as "recency" | "size" | "duration") || "recency",
      limit: parseInt(params.get("limit") || "20", 10),
    });
    // Remap camelCase → snake_case to match CLI output and test expectations
    const out = sessions.map((s) => ({
      session_id: s.sessionId,
      project: s.project,
      date: s.date,
      started: s.started,
      last_activity: s.lastActivity,
      messages: s.messages,
      duration_minutes: s.durationMinutes,
      size_bytes: s.sizeBytes,
      path: s.path,
    }));
    return jsonResponse(out);
  }

  // GET /api/sessions/stats?path=...
  if (path === "/api/sessions/stats" && method === "GET") {
    const sessionPath = params.get("path");
    if (!sessionPath) return errorResponse("Missing 'path' parameter", 400);
    const stats = getStats(sessionPath);
    return jsonResponse(stats);
  }

  // GET /api/search?query=...
  if (path === "/api/search" && method === "GET") {
    const query = params.get("query");
    if (!query) return errorResponse("Missing 'query' parameter", 400);
    const results = searchSessions(query, {
      projectsBase,
      projectFilter: params.get("project") || undefined,
      since: params.get("since") || undefined,
      limit: parseInt(params.get("limit") || "20", 10),
      context: parseInt(params.get("context") || "1", 10),
    });
    // Remap camelCase → snake_case
    const out = results.map((r) => ({
      session_id: r.sessionId,
      project: r.project,
      timestamp: r.timestamp,
      type: r.type,
      match: r.match,
      context_before: r.contextBefore,
      context_after: r.contextAfter,
    }));
    return jsonResponse(out);
  }

  // GET /api/tasks
  if (path === "/api/tasks" && method === "GET") {
    const tasks = aggregateTasks({
      tasksBase,
      projectsBase,
      statusFilter: params.get("status") || "all",
      taskListId: params.get("task_list") || undefined,
    });
    return jsonResponse(tasks);
  }

  // GET /api/tasks/lists
  if (path === "/api/tasks/lists" && method === "GET") {
    const lists = listTaskLists(tasksBase);
    return jsonResponse(lists);
  }

  // GET /api/dashboard/stats
  if (path === "/api/dashboard/stats" && method === "GET") {
    const allSessions = listSessions({ projectsBase, sort: "recency", limit: 9999 });
    const projects = new Set(allSessions.map((s) => s.project));
    const pendingTasks = aggregateTasks({ tasksBase, projectsBase, statusFilter: "pending" });
    const now = Date.now();
    const recentCount = allSessions.filter((s) => {
      if (!s.lastActivity) return false;
      return now - new Date(s.lastActivity).getTime() < 7 * 24 * 60 * 60 * 1000;
    }).length;
    return jsonResponse({
      totalSessions: allSessions.length,
      totalProjects: projects.size,
      pendingTasks: pendingTasks.length,
      recentSessions7d: recentCount,
    });
  }

  // GET /api/timeline
  if (path === "/api/timeline" && method === "GET") {
    const timeline = getTimeline({
      projectsBase,
      projectFilter: params.get("project") || undefined,
      since: params.get("since") || undefined,
    });
    // Remap camelCase → snake_case
    const out = timeline.map((s) => ({
      session_id: s.sessionId,
      project: s.project,
      date: s.date,
      started: s.started,
      last_activity: s.lastActivity,
      messages: s.messages,
      duration_minutes: s.durationMinutes,
      size_bytes: s.sizeBytes,
      path: s.path,
    }));
    return jsonResponse(out);
  }

  // GET /api/cleanup
  if (path === "/api/cleanup" && method === "GET") {
    const candidates = findCleanupCandidates({
      projectsBase,
      olderThan: params.get("older_than") || undefined,
      minMessages: parseInt(params.get("min_messages") || "3", 10),
    });
    // Remap camelCase → snake_case
    const out = candidates.map((c) => ({
      path: c.path,
      session_id: c.sessionId,
      project: c.project,
      reason: c.reason,
      messages: c.messages,
      age_days: c.ageDays,
      size_bytes: c.sizeBytes,
    }));
    return jsonResponse(out);
  }

  // GET /api/sessions/:id/messages (must come before :id match)
  const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    const sessionId = messagesMatch[1];
    if (!isValidId(sessionId)) return errorResponse("Invalid session ID", 400);
    try {
      const sessionPath = resolveSession(sessionId, { projectsBase });
      const result = getMessagesPaginated(sessionPath, {
        offset: parseInt(params.get("offset") || "0", 10),
        limit: parseInt(params.get("limit") || "100", 10),
        includeTools: params.get("include_tools") === "true",
      });
      return jsonResponse(result);
    } catch {
      return errorResponse("Session not found", 404);
    }
  }

  // GET /api/sessions/:id (must come AFTER /api/sessions/stats and messages)
  const sessionDetailMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionDetailMatch && method === "GET" && sessionDetailMatch[1] !== "stats") {
    const sessionId = sessionDetailMatch[1];
    if (!isValidId(sessionId)) return errorResponse("Invalid session ID", 400);
    try {
      const detail = getSessionDetail(sessionId, { projectsBase, tasksBase });
      const sessionPath = resolveSession(sessionId, { projectsBase });
      const { total: transcriptTotal } = getMessagesPaginated(sessionPath, {
        offset: 0,
        limit: 0,
      });
      return jsonResponse({
        session: {
          session_id: detail.session.sessionId,
          project: detail.session.project,
          date: detail.session.date,
          started: detail.session.started,
          last_activity: detail.session.lastActivity,
          messages: detail.session.messages,
          duration_minutes: detail.session.durationMinutes,
          size_bytes: detail.session.sizeBytes,
          path: detail.session.path,
        },
        stats: detail.stats,
        transcript_total: transcriptTotal,
        task_lists: detail.taskLists.map((tl) => ({
          task_list_id: tl.taskListId,
          tasks: tl.tasks,
        })),
      });
    } catch {
      return errorResponse("Session not found", 404);
    }
  }

  // DELETE /api/sessions/:id
  if (sessionDetailMatch && method === "DELETE") {
    const sessionId = sessionDetailMatch[1];
    if (!isValidId(sessionId)) return errorResponse("Invalid session ID", 400);
    try {
      const deleteTasks = params.get("delete_tasks") === "true";
      const result = deleteSession(sessionId, {
        projectsBase,
        tasksBase,
        deleteOrphanedTasks: deleteTasks,
      });
      return jsonResponse({
        deleted: result.deleted,
        session_path: result.sessionPath,
        orphaned_task_lists: result.orphanedTaskLists,
        orphaned_tasks_deleted: result.orphanedTasksDeleted,
      });
    } catch {
      return errorResponse("Session not found", 404);
    }
  }

  // DELETE /api/tasks/:taskListId/:taskId
  const taskDeleteMatch = path.match(/^\/api\/tasks\/([^/]+)\/([^/]+)$/);
  if (taskDeleteMatch && method === "DELETE") {
    const [, taskListId, taskId] = taskDeleteMatch;
    if (!isValidId(taskListId)) return errorResponse("Invalid task list ID", 400);
    if (!isValidId(taskId)) return errorResponse("Invalid task ID", 400);
    const result = deleteTask(taskListId, taskId, { tasksBase });
    return jsonResponse({
      deleted: result.deleted,
      task_path: result.taskPath,
      task_list_now_empty: result.taskListNowEmpty,
    });
  }

  // DELETE /api/tasks/:taskListId
  const taskListDeleteMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskListDeleteMatch && method === "DELETE") {
    const taskListId = taskListDeleteMatch[1];
    if (!isValidId(taskListId)) return errorResponse("Invalid task list ID", 400);
    const result = deleteTaskList(taskListId, { tasksBase });
    return jsonResponse({
      deleted: result.deleted,
      path: result.path,
      task_count: result.taskCount,
    });
  }

  // GET /api/tasks/orphans
  if (path === "/api/tasks/orphans" && method === "GET") {
    const orphans = findOrphanTaskLists({ projectsBase, tasksBase });
    return jsonResponse(
      orphans.map((o) => ({
        task_list_id: o.taskListId,
        task_count: o.taskCount,
        last_modified: o.lastModified,
        path: o.path,
      })),
    );
  }

  return errorResponse("Not found", 404);
}

// ── Start server when run directly ──
if (import.meta.main) {
  const port = parseInt(Bun.env.PORT || "3000", 10);
  const handler = createHandler();

  const server = Bun.serve({
    port,
    fetch: handler,
  });

  console.log(`\n  claude-code-sessions UI`);
  console.log(`  → http://localhost:${server.port}\n`);
}
