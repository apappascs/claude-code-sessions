// lib/session-store.ts
/**
 * Session discovery and cross-session operations.
 *
 * Scans ~/.claude/projects/ to find, list, search, and analyze sessions.
 *
 * Usage as CLI:
 *   bun run lib/session-store.ts list [--project FILTER] [--sort recency|size|duration] [--limit N]
 *   bun run lib/session-store.ts search "<query>" [--project FILTER] [--since DATE] [--limit N] [--context N]
 *   bun run lib/session-store.ts timeline [--project FILTER] [--since DATE]
 *   bun run lib/session-store.ts cleanup [--older-than 30d] [--min-messages N]
 *   bun run lib/session-store.ts tasks [--status pending|completed|in_progress|all] [--task-list ID]
 *   bun run lib/session-store.ts task-lists
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseDateBoundary, parseTimestamp, toJson, toNdjson, truncate } from "./formatters";
import { extractUserText, getStats, getTasks, type SessionStats } from "./session-parser";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PROJECTS_BASE = join(homedir(), ".claude", "projects");
export const DEFAULT_TASKS_BASE = join(homedir(), ".claude", "tasks");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  project: string;
  date: string | null;
  started: string | null;
  lastActivity: string | null;
  messages: number;
  durationMinutes: number;
  sizeBytes: number;
  path: string;
}

export interface SearchResult {
  sessionId: string;
  project: string;
  timestamp: string | null;
  type: string | null;
  match: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface CleanupCandidate {
  path: string;
  sessionId: string;
  project: string;
  reason: "empty" | "tiny" | "old";
  messages: number;
  ageDays: number;
  sizeBytes: number;
}

export interface TaskEntry {
  id?: string;
  subject?: string;
  description?: string;
  status?: string;
  blocks?: string[];
  blockedBy?: string[];
  taskListId?: string;
  source?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface TaskListEntry {
  taskListId: string;
  taskCount: number;
  lastModified: string;
  highwatermark: number | null;
}

// ---------------------------------------------------------------------------
// Path encoding/decoding
// ---------------------------------------------------------------------------

/** Encode a filesystem path to Claude's project directory name. */
export function encodeProjectPath(path: string): string {
  return path.replace(/\//g, "-");
}

/** Decode a Claude project directory name back to a filesystem path. */
export function decodeProjectPath(encoded: string): string {
  let decoded: string;
  if (encoded.startsWith("-")) {
    decoded = `/${encoded.slice(1).replace(/-/g, "/")}`;
  } else {
    decoded = encoded.replace(/-/g, "/");
  }
  if (decoded.includes("..")) {
    throw new Error("Invalid project path");
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// ID validation
// ---------------------------------------------------------------------------

const VALID_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate that an ID is safe for path construction (no traversal). */
export function isValidId(id: string): boolean {
  return id.length > 0 && VALID_ID_RE.test(id);
}

/** Verify a resolved path stays within the expected base directory. */
function assertPathWithinBase(targetPath: string, baseDir: string): void {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);
  if (!resolvedTarget.startsWith(`${resolvedBase}/`) && resolvedTarget !== resolvedBase) {
    throw new Error("Path traversal detected");
  }
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

export interface ResolveSessionOptions {
  cwd?: string;
  projectsBase?: string;
}

/**
 * Resolve a session identifier to a JSONL file path.
 *
 * Resolution chain:
 * 1. Full path to .jsonl → use directly
 * 2. UUID → search projects for matching filename
 * 3. undefined → most recent .jsonl in cwd's project dir
 *
 * Throws an Error instead of calling process.exit (CLI catches and exits with code 2).
 */
export function resolveSession(identifier?: string, opts: ResolveSessionOptions = {}): string {
  const base = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;

  // 1. Full path
  if (identifier && (identifier.endsWith(".jsonl") || identifier.includes("/"))) {
    if (existsSync(identifier)) {
      return identifier;
    }
    throw new Error(`Session file not found: ${identifier}`);
  }

  // 2. UUID search
  if (identifier) {
    if (existsSync(base)) {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(base, entry.name, `${identifier}.jsonl`);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    throw new Error(`No session found with ID: ${identifier}. Run session-list to see available sessions.`);
  }

  // 3. Most recent in cwd project
  if (opts.cwd) {
    const encoded = encodeProjectPath(opts.cwd);
    const projDir = join(base, encoded);
    if (existsSync(projDir)) {
      const jsonlFiles = readdirSync(projDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(projDir, e.name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (jsonlFiles.length > 0) {
        return jsonlFiles[0];
      }
    }
  }

  throw new Error("No session specified and could not find current session. Provide a session ID or path.");
}

// ---------------------------------------------------------------------------
// Session summary (private helper)
// ---------------------------------------------------------------------------

function getSessionSummary(sessionPath: string): SessionSummary | null {
  let size: number;
  try {
    size = statSync(sessionPath).size;
  } catch {
    return null;
  }

  const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
  const parentName = basename(sessionPath.slice(0, sessionPath.length - basename(sessionPath).length - 1));

  if (size === 0) {
    return {
      sessionId,
      project: decodeProjectPath(parentName),
      date: null,
      started: null,
      lastActivity: null,
      messages: 0,
      durationMinutes: 0,
      sizeBytes: 0,
      path: sessionPath,
    };
  }

  let msgCount = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  try {
    const content = readFileSync(sessionPath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      msgCount++;
      const ts = obj.timestamp as string | undefined;
      if (ts) {
        if (firstTs === null) firstTs = ts;
        lastTs = ts;
      }
    }
  } catch {
    return null;
  }

  let durationMinutes = 0;
  let dateStr: string | null = null;

  if (firstTs) {
    const firstDt = parseTimestamp(firstTs);
    const lastDt = parseTimestamp(lastTs);
    if (firstDt) {
      dateStr = firstDt.toISOString().slice(0, 10);
    }
    if (firstDt && lastDt) {
      durationMinutes = Math.round(((lastDt.getTime() - firstDt.getTime()) / 60000) * 10) / 10;
    }
  }

  return {
    sessionId,
    project: decodeProjectPath(parentName),
    date: dateStr,
    started: firstTs,
    lastActivity: lastTs,
    messages: msgCount,
    durationMinutes,
    sizeBytes: size,
    path: sessionPath,
  };
}

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

export interface ListSessionsOptions {
  projectFilter?: string;
  sort?: "recency" | "size" | "duration";
  limit?: number;
  since?: string;
  until?: string;
  projectsBase?: string;
}

/** List all sessions, optionally filtered and sorted. */
export function listSessions(opts: ListSessionsOptions = {}): SessionSummary[] {
  const base = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const sort = opts.sort ?? "recency";
  const limit = opts.limit ?? 20;

  if (!existsSync(base)) return [];

  const sessions: SessionSummary[] = [];

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (opts.projectFilter && !entry.name.toLowerCase().includes(opts.projectFilter.toLowerCase())) {
      continue;
    }
    const projDir = join(base, entry.name);
    for (const file of readdirSync(projDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const summary = getSessionSummary(join(projDir, file.name));
      if (summary) {
        sessions.push(summary);
      }
    }
  }

  // Date filtering
  const sinceDt = opts.since ? parseDateBoundary(opts.since) : null;
  const untilDt = opts.until ? parseDateBoundary(opts.until) : null;

  const filtered = sessions.filter((s) => {
    const ts = parseTimestamp(s.lastActivity ?? s.started);
    if (!ts) return !sinceDt && !untilDt; // keep sessions with no timestamp only if no filter
    if (sinceDt && ts < sinceDt) return false;
    if (untilDt && ts > untilDt) return false;
    return true;
  });

  if (sort === "recency") {
    filtered.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  } else if (sort === "size") {
    filtered.sort((a, b) => b.sizeBytes - a.sizeBytes);
  } else if (sort === "duration") {
    filtered.sort((a, b) => b.durationMinutes - a.durationMinutes);
  }

  return filtered.slice(0, limit);
}

// ---------------------------------------------------------------------------
// searchSessions
// ---------------------------------------------------------------------------

export interface SearchSessionsOptions {
  projectFilter?: string;
  since?: string;
  until?: string;
  limit?: number;
  context?: number;
  projectsBase?: string;
}

/** Search across all sessions for matching content. */
export function searchSessions(query: string, opts: SearchSessionsOptions = {}): SearchResult[] {
  const base = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const limit = opts.limit ?? 20;
  const contextLines = opts.context ?? 0;

  if (!existsSync(base)) return [];

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "i");

  const sinceDt = opts.since ? parseDateBoundary(opts.since) : null;
  const untilDt = opts.until ? parseDateBoundary(opts.until) : null;

  const results: SearchResult[] = [];

  outer: for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (opts.projectFilter && !entry.name.toLowerCase().includes(opts.projectFilter.toLowerCase())) {
      continue;
    }

    const projDir = join(base, entry.name);
    for (const file of readdirSync(projDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      const jsonlPath = join(projDir, file.name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const linesData: Record<string, any>[] = [];

      try {
        const content = readFileSync(jsonlPath, "utf-8");
        for (const rawLine of content.split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            linesData.push(JSON.parse(line));
          } catch {}
        }
      } catch {
        continue;
      }

      for (let i = 0; i < linesData.length; i++) {
        const obj = linesData[i];

        if (sinceDt || untilDt) {
          const ts = parseTimestamp(obj.timestamp);
          if (ts) {
            if (sinceDt && ts < sinceDt) continue;
            if (untilDt && ts > untilDt) continue;
          }
        }

        let searchable = "";
        if (obj.type === "user") {
          searchable = extractUserText(obj);
        } else if (obj.type === "assistant") {
          const content = obj.message?.content ?? [];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === "object" && block !== null && block.type === "text") {
                searchable += `${block.text ?? ""} `;
              }
            }
          }
        }

        if (!searchable || !pattern.test(searchable)) continue;

        const ctxBefore: string[] = [];
        const ctxAfter: string[] = [];

        if (contextLines > 0) {
          for (let j = Math.max(0, i - contextLines); j < i; j++) {
            const prev = linesData[j];
            if (prev.type === "user") {
              ctxBefore.push(truncate(extractUserText(prev), 100));
            }
          }
          for (let j = i + 1; j < Math.min(linesData.length, i + 1 + contextLines); j++) {
            const nxt = linesData[j];
            if (nxt.type === "user") {
              ctxAfter.push(truncate(extractUserText(nxt), 100));
            }
          }
        }

        results.push({
          sessionId: basename(jsonlPath).replace(/\.jsonl$/, ""),
          project: decodeProjectPath(entry.name),
          timestamp: obj.timestamp ?? null,
          type: obj.type ?? null,
          match: truncate(searchable.trim(), 200),
          contextBefore: ctxBefore,
          contextAfter: ctxAfter,
        });

        if (results.length >= limit) break outer;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// getTimeline
// ---------------------------------------------------------------------------

export interface GetTimelineOptions {
  projectFilter?: string;
  since?: string;
  until?: string;
  projectsBase?: string;
}

/** Chronological list of sessions for a project. */
export function getTimeline(opts: GetTimelineOptions = {}): SessionSummary[] {
  const sessions = listSessions({
    projectFilter: opts.projectFilter,
    sort: "recency",
    limit: 1000,
    since: opts.since,
    until: opts.until,
    projectsBase: opts.projectsBase,
  });

  sessions.reverse();
  return sessions;
}

// ---------------------------------------------------------------------------
// findCleanupCandidates
// ---------------------------------------------------------------------------

export interface FindCleanupCandidatesOptions {
  olderThan?: string;
  minMessages?: number;
  projectsBase?: string;
}

/** Find sessions that are candidates for cleanup. */
export function findCleanupCandidates(opts: FindCleanupCandidatesOptions = {}): CleanupCandidate[] {
  const base = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const minMessages = opts.minMessages ?? 3;

  if (!existsSync(base)) return [];

  let maxAgeDays: number | null = null;
  if (opts.olderThan) {
    const m = opts.olderThan.match(/^(\d+)d$/);
    if (m) {
      maxAgeDays = parseInt(m[1], 10);
    }
  }

  const candidates: CleanupCandidate[] = [];
  const now = Date.now();

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = join(base, entry.name);

    for (const file of readdirSync(projDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      const jsonlPath = join(projDir, file.name);
      const summary = getSessionSummary(jsonlPath);
      if (!summary) continue;

      let fileMtime: number;
      try {
        fileMtime = statSync(jsonlPath).mtimeMs;
      } catch {
        continue;
      }

      const ageDays = Math.floor((now - fileMtime) / (1000 * 60 * 60 * 24));

      let reason: "empty" | "tiny" | "old" | null = null;
      if (summary.sizeBytes === 0) {
        reason = "empty";
      } else if (summary.messages < minMessages) {
        reason = "tiny";
      } else if (maxAgeDays !== null && ageDays > maxAgeDays) {
        reason = "old";
      }

      if (reason) {
        candidates.push({
          path: jsonlPath,
          sessionId: summary.sessionId,
          project: summary.project,
          reason,
          messages: summary.messages,
          ageDays,
          sizeBytes: summary.sizeBytes,
        });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// readTaskList
// ---------------------------------------------------------------------------

/**
 * Read all tasks from a single task list directory.
 * Skips .lock, .highwatermark, and any non-JSON-task files.
 */
export function readTaskList(taskListId: string, tasksBase?: string): TaskEntry[] {
  const base = tasksBase ?? DEFAULT_TASKS_BASE;
  const taskDir = join(base, taskListId);

  if (!existsSync(taskDir)) return [];

  const tasks: TaskEntry[] = [];

  const files = readdirSync(taskDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();

  for (const fileName of files) {
    const taskPath = join(taskDir, fileName);
    try {
      const raw = readFileSync(taskPath, "utf-8");
      const task: TaskEntry = JSON.parse(raw);
      task.taskListId = taskListId;
      task.source = "filesystem";
      tasks.push(task);
    } catch {}
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// deleteTask
// ---------------------------------------------------------------------------

export interface DeleteTaskResult {
  deleted: boolean;
  taskPath: string;
  taskListNowEmpty: boolean;
}

/**
 * Delete a single task JSON file from a task list.
 * Throws if ID is invalid or task doesn't exist.
 */
export function deleteTask(taskListId: string, taskId: string, opts?: { tasksBase?: string }): DeleteTaskResult {
  if (!isValidId(taskListId)) throw new Error(`Invalid task list ID: ${taskListId}`);
  if (!isValidId(taskId)) throw new Error(`Invalid task ID: ${taskId}`);

  const base = opts?.tasksBase ?? DEFAULT_TASKS_BASE;
  const taskPath = join(base, taskListId, `${taskId}.json`);
  assertPathWithinBase(taskPath, base);

  if (!existsSync(taskPath)) {
    throw new Error(`Task not found: ${taskListId}/${taskId}`);
  }

  unlinkSync(taskPath);

  // Check if any .json tasks remain
  const taskDir = join(base, taskListId);
  const remaining = readdirSync(taskDir, { withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith(".json"),
  ).length;

  return { deleted: true, taskPath, taskListNowEmpty: remaining === 0 };
}

// ---------------------------------------------------------------------------
// deleteTaskList
// ---------------------------------------------------------------------------

/**
 * Delete an entire task list directory.
 * Throws if ID is invalid or directory doesn't exist.
 */
export function deleteTaskList(
  taskListId: string,
  opts?: { tasksBase?: string },
): { deleted: boolean; path: string; taskCount: number } {
  if (!isValidId(taskListId)) throw new Error(`Invalid task list ID: ${taskListId}`);

  const base = opts?.tasksBase ?? DEFAULT_TASKS_BASE;
  const taskDir = join(base, taskListId);
  assertPathWithinBase(taskDir, base);

  if (!existsSync(taskDir)) {
    throw new Error(`Task list not found: ${taskListId}`);
  }

  const taskCount = readdirSync(taskDir, { withFileTypes: true }).filter(
    (e) => e.isFile() && e.name.endsWith(".json"),
  ).length;

  rmSync(taskDir, { recursive: true });

  return { deleted: true, path: taskDir, taskCount };
}

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

export interface DeleteSessionResult {
  deleted: boolean;
  sessionPath: string;
  orphanedTaskLists: string[];
  orphanedTasksDeleted: boolean;
}

/**
 * Delete a session JSONL file. Finds any matching task lists and optionally
 * deletes them too. Uses resolveSession() to find the file.
 */
export function deleteSession(
  sessionId: string,
  opts?: {
    projectsBase?: string;
    tasksBase?: string;
    deleteOrphanedTasks?: boolean;
  },
): DeleteSessionResult {
  if (!isValidId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);

  const projectsBase = opts?.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const tasksBase = opts?.tasksBase ?? DEFAULT_TASKS_BASE;

  // Find the session file
  const sessionPath = resolveSession(sessionId, { projectsBase });
  assertPathWithinBase(sessionPath, projectsBase);

  // Check for matching task lists
  const orphanedTaskLists: string[] = [];
  if (existsSync(tasksBase)) {
    const taskDir = join(tasksBase, sessionId);
    if (existsSync(taskDir)) {
      orphanedTaskLists.push(sessionId);
    }
  }

  // Delete the session file
  unlinkSync(sessionPath);

  // Optionally delete orphaned task lists
  let orphanedTasksDeleted = false;
  if (opts?.deleteOrphanedTasks && orphanedTaskLists.length > 0) {
    for (const listId of orphanedTaskLists) {
      deleteTaskList(listId, { tasksBase });
    }
    orphanedTasksDeleted = true;
  }

  return { deleted: true, sessionPath, orphanedTaskLists, orphanedTasksDeleted };
}

// ---------------------------------------------------------------------------
// findOrphanTaskLists
// ---------------------------------------------------------------------------

export interface OrphanTaskList {
  taskListId: string;
  taskCount: number;
  lastModified: string;
  path: string;
}

/**
 * Find task lists that have no matching session JSONL file across any project.
 */
export function findOrphanTaskLists(opts?: { projectsBase?: string; tasksBase?: string }): OrphanTaskList[] {
  const projectsBase = opts?.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const tasksBase = opts?.tasksBase ?? DEFAULT_TASKS_BASE;

  if (!existsSync(tasksBase)) return [];

  // Collect all session IDs across all projects
  const allSessionIds = new Set<string>();
  if (existsSync(projectsBase)) {
    for (const projEntry of readdirSync(projectsBase, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const projDir = join(projectsBase, projEntry.name);
      for (const file of readdirSync(projDir, { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith(".jsonl")) {
          allSessionIds.add(file.name.replace(/\.jsonl$/, ""));
        }
      }
    }
  }

  // Check each task list against the session set
  const orphans: OrphanTaskList[] = [];
  for (const entry of readdirSync(tasksBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (allSessionIds.has(entry.name)) continue;

    const taskDir = join(tasksBase, entry.name);
    const taskCount = readdirSync(taskDir, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.endsWith(".json"),
    ).length;

    if (taskCount === 0) continue;

    const mtime = new Date(statSync(taskDir).mtimeMs).toISOString();
    orphans.push({
      taskListId: entry.name,
      taskCount,
      lastModified: mtime,
      path: taskDir,
    });
  }

  return orphans;
}

// ---------------------------------------------------------------------------
// getSessionDetail
// ---------------------------------------------------------------------------

export interface SessionDetail {
  session: SessionSummary;
  stats: SessionStats;
  taskLists: { taskListId: string; tasks: TaskEntry[] }[];
}

/**
 * Get detailed session info: summary, stats (tokens, tools, models),
 * and associated task lists with their tasks.
 */
export function getSessionDetail(
  sessionId: string,
  opts?: { projectsBase?: string; tasksBase?: string },
): SessionDetail {
  if (!isValidId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);

  const projectsBase = opts?.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const tasksBase = opts?.tasksBase ?? DEFAULT_TASKS_BASE;

  // Resolve session path
  const sessionPath = resolveSession(sessionId, { projectsBase });

  // Get session summary
  const summary = getSessionSummary(sessionPath);
  if (!summary) throw new Error(`Could not read session: ${sessionId}`);

  // Get detailed stats (tokens, models, tools)
  const stats = getStats(sessionPath);

  // Find associated task lists
  const taskLists: { taskListId: string; tasks: TaskEntry[] }[] = [];
  if (existsSync(tasksBase)) {
    const taskDir = join(tasksBase, sessionId);
    if (existsSync(taskDir)) {
      const tasks = readTaskList(sessionId, tasksBase);
      taskLists.push({ taskListId: sessionId, tasks });
    }
  }

  // Fallback: extract tasks from JSONL if none found in filesystem
  if (taskLists.length === 0 || taskLists.every((tl) => tl.tasks.length === 0)) {
    try {
      const rawTasks = getTasks(sessionPath);
      if (rawTasks.length > 0) {
        const created = new Map<string, TaskEntry>();
        const merged: TaskEntry[] = [];
        let nextId = 1;
        for (const t of rawTasks) {
          const entry = t as TaskEntry;
          entry.taskListId = sessionId;
          entry.source = "jsonl";
          if (t.action === "create") {
            const id = String(nextId++);
            entry.id = id;
            entry.task_id = id;
            created.set(id, entry);
            merged.push(entry);
          } else if (t.action === "update" && t.task_id && created.has(t.task_id)) {
            if (t.status) created.get(t.task_id)!.status = t.status;
          }
        }
        if (merged.length > 0) {
          // Replace empty filesystem task list or add new one
          const existingIdx = taskLists.findIndex((tl) => tl.taskListId === sessionId);
          if (existingIdx >= 0) {
            taskLists[existingIdx].tasks = merged;
          } else {
            taskLists.push({ taskListId: sessionId, tasks: merged });
          }
        }
      }
    } catch {
      // Ignore — JSONL parsing errors shouldn't break session detail
    }
  }

  return { session: summary, stats, taskLists };
}

// ---------------------------------------------------------------------------
// listTaskLists
// ---------------------------------------------------------------------------

/** List all task lists in ~/.claude/tasks/. */
export function listTaskLists(tasksBase?: string): TaskListEntry[] {
  const base = tasksBase ?? DEFAULT_TASKS_BASE;

  if (!existsSync(base)) return [];

  const result: TaskListEntry[] = [];

  const entries = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const taskDir = join(base, entry.name);
    const taskCount = readdirSync(taskDir, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.endsWith(".json"),
    ).length;

    if (taskCount === 0) continue;

    const hwmPath = join(taskDir, ".highwatermark");
    let highwatermark: number | null = null;
    if (existsSync(hwmPath)) {
      try {
        highwatermark = parseInt(readFileSync(hwmPath, "utf-8").trim(), 10);
        if (Number.isNaN(highwatermark)) highwatermark = null;
      } catch {
        // ignore
      }
    }

    const mtime = new Date(statSync(taskDir).mtimeMs).toISOString();

    result.push({
      taskListId: entry.name,
      taskCount,
      lastModified: mtime,
      highwatermark,
    });
  }

  result.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return result;
}

// ---------------------------------------------------------------------------
// aggregateTasks
// ---------------------------------------------------------------------------

export interface AggregateTasksOptions {
  statusFilter?: string;
  taskListId?: string;
  since?: string;
  until?: string;
  tasksBase?: string;
  projectsBase?: string;
}

/**
 * Aggregate tasks from the Tasks filesystem (primary) and session JSONL (fallback).
 */
export function aggregateTasks(opts: AggregateTasksOptions = {}): TaskEntry[] {
  const tBase = opts.tasksBase ?? DEFAULT_TASKS_BASE;
  const allTasks: TaskEntry[] = [];

  // Primary: Read from ~/.claude/tasks/
  if (opts.taskListId) {
    allTasks.push(...readTaskList(opts.taskListId, tBase));
  } else if (existsSync(tBase)) {
    for (const entry of readdirSync(tBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      allTasks.push(...readTaskList(entry.name, tBase));
    }
  }

  // Fallback: Read from session JSONL (for older sessions)
  const pBase = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;
  if (existsSync(pBase)) {
    const knownIds = new Set(allTasks.map((t) => t.taskListId));
    for (const entry of readdirSync(pBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projDir = join(pBase, entry.name);
      for (const file of readdirSync(projDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const stem = file.name.replace(/\.jsonl$/, "");
        if (knownIds.has(stem)) continue;
        try {
          const rawTasks = getTasks(join(projDir, file.name));
          // Merge JSONL task events: apply updates to their creates
          const created = new Map<string, TaskEntry>();
          const merged: TaskEntry[] = [];
          let nextId = 1;
          for (const t of rawTasks) {
            const entry = t as TaskEntry;
            entry.taskListId = stem;
            entry.source = "jsonl";
            if (t.action === "create") {
              const id = String(nextId++);
              entry.id = id;
              entry.task_id = id;
              if (!entry.status) entry.status = "pending";
              created.set(id, entry);
              merged.push(entry);
            } else if (t.action === "update" && t.task_id && created.has(t.task_id)) {
              // Fold status update into original create
              if (t.status) created.get(t.task_id)!.status = t.status;
            }
            // Skip orphan updates (no matching create)
          }
          allTasks.push(...merged);
        } catch {}
      }
    }
  }

  // Exclude tasks with invalid/missing status (e.g. "deleted", undefined from JSONL)
  const validStatuses = new Set(["in_progress", "pending", "completed"]);
  const validTasks = allTasks.filter((t) => t.status && validStatuses.has(t.status));

  // Date filtering (applies to JSONL-sourced tasks with timestamps)
  const sinceDt = opts.since ? parseDateBoundary(opts.since) : null;
  const untilDt = opts.until ? parseDateBoundary(opts.until) : null;

  let dateFiltered = validTasks;
  if (sinceDt || untilDt) {
    dateFiltered = validTasks.filter((t) => {
      const ts = parseTimestamp(t.timestamp);
      if (!ts) return true; // filesystem tasks without timestamps pass through
      if (sinceDt && ts < sinceDt) return false;
      if (untilDt && ts > untilDt) return false;
      return true;
    });
  }

  const statusFilter = opts.statusFilter ?? "all";
  if (statusFilter !== "all") {
    return dateFiltered.filter((t) => t.status === statusFilter);
  }

  return dateFiltered;
}

// ---------------------------------------------------------------------------
// Chart aggregation: daily tokens
// ---------------------------------------------------------------------------

export interface DailyTokenAggregationOptions {
  since?: string;
  until?: string;
  projectFilter?: string;
  projectsBase?: string;
}

export interface DailyTokenData {
  labels: string[];
  datasets: {
    input: number[];
    output: number[];
    cache_read: number[];
    cache_create: number[];
  };
}

export function getDailyTokenAggregation(opts: DailyTokenAggregationOptions = {}): DailyTokenData {
  const sessions = listSessions({
    projectsBase: opts.projectsBase,
    projectFilter: opts.projectFilter,
    since: opts.since,
    until: opts.until,
    sort: "recency",
    limit: 9999,
  });

  const buckets = new Map<string, { input: number; output: number; cache_read: number; cache_create: number }>();

  for (const s of sessions) {
    if (!s.date) continue;
    try {
      const stats = getStats(s.path);
      const existing = buckets.get(s.date) ?? { input: 0, output: 0, cache_read: 0, cache_create: 0 };
      existing.input += stats.tokens.input;
      existing.output += stats.tokens.output;
      existing.cache_read += stats.tokens.cache_read;
      existing.cache_create += stats.tokens.cache_create;
      buckets.set(s.date, existing);
    } catch {}
  }

  const labels = [...buckets.keys()].sort();
  return {
    labels,
    datasets: {
      input: labels.map((d) => buckets.get(d)!.input),
      output: labels.map((d) => buckets.get(d)!.output),
      cache_read: labels.map((d) => buckets.get(d)!.cache_read),
      cache_create: labels.map((d) => buckets.get(d)!.cache_create),
    },
  };
}

// ---------------------------------------------------------------------------
// Chart aggregation: model distribution
// ---------------------------------------------------------------------------

export interface ModelDistributionOptions {
  since?: string;
  until?: string;
  projectFilter?: string;
  projectsBase?: string;
}

export interface ModelDistributionEntry {
  model: string;
  tokens: number;
  sessions: number;
}

export function getModelDistribution(opts: ModelDistributionOptions = {}): ModelDistributionEntry[] {
  const sessions = listSessions({
    projectsBase: opts.projectsBase,
    projectFilter: opts.projectFilter,
    sort: "recency",
    limit: 9999,
  });

  const modelMap = new Map<string, { tokens: number; sessions: Set<string> }>();

  for (const s of sessions) {
    try {
      const stats = getStats(s.path);
      const totalTokens =
        stats.tokens.input + stats.tokens.output + stats.tokens.cache_read + stats.tokens.cache_create;

      for (const [model, count] of Object.entries(stats.models)) {
        if (model === "unknown" || model === "<synthetic>") continue;
        const existing = modelMap.get(model) ?? { tokens: 0, sessions: new Set<string>() };
        // Distribute tokens proportionally by message count per model
        const totalMsgs = Object.values(stats.models).reduce((a, b) => a + b, 0);
        const proportion = totalMsgs > 0 ? count / totalMsgs : 0;
        existing.tokens += Math.round(totalTokens * proportion);
        existing.sessions.add(s.sessionId);
        modelMap.set(model, existing);
      }
    } catch {}
  }

  const entries: ModelDistributionEntry[] = [...modelMap.entries()]
    .map(([model, data]) => ({ model, tokens: data.tokens, sessions: data.sessions.size }))
    .sort((a, b) => b.tokens - a.tokens);

  // Group models with <3% share into "Other"
  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  if (totalTokens === 0) return entries;

  const threshold = totalTokens * 0.03;
  const main: ModelDistributionEntry[] = [];
  let otherTokens = 0;

  for (const entry of entries) {
    if (entry.tokens >= threshold) {
      main.push(entry);
    } else {
      otherTokens += entry.tokens;
    }
  }

  if (otherTokens > 0) {
    main.push({ model: "Other", tokens: otherTokens, sessions: entries.length - main.length });
  }

  return main;
}

// ---------------------------------------------------------------------------
// Chart aggregation: activity heatmap
// ---------------------------------------------------------------------------

export interface ActivityHeatmapOptions {
  since?: string;
  until?: string;
  projectFilter?: string;
  projectsBase?: string;
}

export interface ActivityHeatmapData {
  grid: number[][];
  maxValue: number;
  dayLabels: string[];
  hourLabels: string[];
}

export function getActivityHeatmap(opts: ActivityHeatmapOptions = {}): ActivityHeatmapData {
  const sessions = listSessions({
    projectsBase: opts.projectsBase,
    projectFilter: opts.projectFilter,
    sort: "recency",
    limit: 9999,
  });

  // 7 rows (Mon=0 .. Sun=6) x 24 cols (hours)
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hourLabels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

  for (const s of sessions) {
    const ts = parseTimestamp(s.started ?? s.lastActivity);
    if (!ts) continue;
    // JS getDay(): 0=Sun, 1=Mon ... 6=Sat → remap to 0=Mon ... 6=Sun
    const jsDay = ts.getDay();
    const day = jsDay === 0 ? 6 : jsDay - 1;
    const hour = ts.getHours();
    grid[day][hour]++;
  }

  const maxValue = Math.max(0, ...grid.flat());

  return { grid, maxValue, dayLabels, hourLabels };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  function exitWithError(err: unknown, code: number): never {
    process.stderr.write(`${JSON.stringify({ error: String(err), code })}\n`);
    process.exit(code);
  }

  function getFlag(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  }

  function getFlagInt(flag: string, def: number): number {
    const v = getFlag(flag);
    if (v === undefined) return def;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? def : n;
  }

  const since = getFlag("--since");
  const until = getFlag("--until");
  const formatFlag = getFlag("--format") ?? (args.includes("--json") ? "json" : "json");

  // Global overrides
  const projectsBase = getFlag("--projects-base");
  const tasksBase = getFlag("--tasks-base");

  const command = args.find((a) => !a.startsWith("-"));

  try {
    if (!command) {
      process.stderr.write(
        "Usage: bun run lib/session-store.ts <list|search|timeline|cleanup|tasks|task-lists|delete-session|delete-task|delete-task-list|orphan-task-lists|session-detail> ...\n",
      );
      process.exit(1);
    }

    if (command === "list") {
      const project = getFlag("--project");
      const sort = (getFlag("--sort") ?? "recency") as "recency" | "size" | "duration";
      const limit = getFlagInt("--limit", 20);
      const sessions = listSessions({ projectFilter: project, sort, limit, since, until, projectsBase });
      // Output with snake_case keys to match Python output
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
      if (formatFlag === "table") {
        const { formatTable, formatDuration, formatSize } = await import("./formatters");
        console.log(
          formatTable(out, [
            { key: "session_id", label: "SESSION ID", width: 12 },
            { key: "project", label: "PROJECT", width: 30 },
            { key: "date", label: "DATE" },
            { key: "messages", label: "MSGS", align: "right" as const },
            {
              key: "duration_minutes",
              label: "DURATION",
              align: "right" as const,
              format: (v: unknown) => formatDuration((v as number) * 60),
            },
            {
              key: "size_bytes",
              label: "SIZE",
              align: "right" as const,
              format: (v: unknown) => formatSize(v as number),
            },
          ]),
        );
      } else {
        console.log(toJson(out));
      }
    } else if (command === "search") {
      // query is the first non-flag arg after "search"
      const cmdIdx = args.indexOf("search");
      const query = args[cmdIdx + 1];
      if (!query || query.startsWith("-")) exitWithError("Missing search query", 2);

      const project = getFlag("--project");
      const limit = getFlagInt("--limit", 20);
      const context = getFlagInt("--context", 0);
      const results = searchSessions(query, {
        projectFilter: project,
        since,
        until,
        limit,
        context,
        projectsBase,
      });
      const out = results.map((r) => ({
        session_id: r.sessionId,
        project: r.project,
        timestamp: r.timestamp,
        type: r.type,
        match: r.match,
        context_before: r.contextBefore,
        context_after: r.contextAfter,
      }));
      if (formatFlag === "table") {
        const { formatTable } = await import("./formatters");
        console.log(
          formatTable(out, [
            { key: "session_id", label: "SESSION ID", width: 12 },
            { key: "project", label: "PROJECT", width: 30 },
            { key: "timestamp", label: "TIMESTAMP", width: 20 },
            { key: "match", label: "MATCH", width: 60 },
          ]),
        );
      } else {
        console.log(out.length > 0 ? toNdjson(out) : toJson([]));
      }
    } else if (command === "timeline") {
      const project = getFlag("--project");
      const timeline = getTimeline({ projectFilter: project, since, until, projectsBase });
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
      if (formatFlag === "table") {
        const { formatTable, formatDuration, formatSize } = await import("./formatters");
        console.log(
          formatTable(out, [
            { key: "session_id", label: "SESSION ID", width: 12 },
            { key: "project", label: "PROJECT", width: 30 },
            { key: "date", label: "DATE" },
            { key: "messages", label: "MSGS", align: "right" as const },
            {
              key: "duration_minutes",
              label: "DURATION",
              align: "right" as const,
              format: (v: unknown) => formatDuration((v as number) * 60),
            },
            {
              key: "size_bytes",
              label: "SIZE",
              align: "right" as const,
              format: (v: unknown) => formatSize(v as number),
            },
          ]),
        );
      } else {
        console.log(toJson(out));
      }
    } else if (command === "cleanup") {
      const olderThan = getFlag("--older-than");
      const minMessages = getFlagInt("--min-messages", 3);
      const candidates = findCleanupCandidates({ olderThan, minMessages, projectsBase });
      const out = candidates.map((c) => ({
        path: c.path,
        session_id: c.sessionId,
        project: c.project,
        reason: c.reason,
        messages: c.messages,
        age_days: c.ageDays,
        size_bytes: c.sizeBytes,
      }));
      const totalSize = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
      console.log(toJson({ candidates: out, total_size_bytes: totalSize, count: candidates.length }));
    } else if (command === "tasks") {
      const status = getFlag("--status") ?? "all";
      const taskListId = getFlag("--task-list");
      const tasks = aggregateTasks({ statusFilter: status, taskListId, since, until, tasksBase, projectsBase });
      const out = tasks.map((t) => ({
        ...t,
        task_list_id: t.taskListId,
        taskListId: undefined,
      }));
      if (formatFlag === "table") {
        const { formatTable } = await import("./formatters");
        console.log(
          formatTable(out, [
            { key: "status", label: "STATUS", width: 12 },
            { key: "subject", label: "SUBJECT", width: 40 },
            { key: "task_list_id", label: "SESSION", width: 12 },
          ]),
        );
      } else {
        console.log(toJson(out));
      }
    } else if (command === "task-lists") {
      const lists = listTaskLists(tasksBase);
      const out = lists.map((l) => ({
        task_list_id: l.taskListId,
        task_count: l.taskCount,
        last_modified: l.lastModified,
        highwatermark: l.highwatermark,
      }));
      console.log(toJson(out));
    } else if (command === "delete-session") {
      const cmdIdx = args.indexOf("delete-session");
      const sessionId = args[cmdIdx + 1];
      if (!sessionId || sessionId.startsWith("-")) exitWithError("Missing session ID", 2);
      const deleteTasks = args.includes("--delete-tasks");
      const result = deleteSession(sessionId, {
        projectsBase,
        tasksBase,
        deleteOrphanedTasks: deleteTasks,
      });
      console.log(
        toJson({
          deleted: result.deleted,
          session_path: result.sessionPath,
          orphaned_task_lists: result.orphanedTaskLists,
          orphaned_tasks_deleted: result.orphanedTasksDeleted,
        }),
      );
    } else if (command === "delete-task") {
      const cmdIdx = args.indexOf("delete-task");
      const taskListId = args[cmdIdx + 1];
      const taskId = args[cmdIdx + 2];
      if (!taskListId || taskListId.startsWith("-")) exitWithError("Missing task list ID", 2);
      if (!taskId || taskId.startsWith("-")) exitWithError("Missing task ID", 2);
      const result = deleteTask(taskListId, taskId, { tasksBase });
      console.log(
        toJson({
          deleted: result.deleted,
          task_path: result.taskPath,
          task_list_now_empty: result.taskListNowEmpty,
        }),
      );
    } else if (command === "delete-task-list") {
      const cmdIdx = args.indexOf("delete-task-list");
      const taskListId = args[cmdIdx + 1];
      if (!taskListId || taskListId.startsWith("-")) exitWithError("Missing task list ID", 2);
      const result = deleteTaskList(taskListId, { tasksBase });
      console.log(
        toJson({
          deleted: result.deleted,
          path: result.path,
          task_count: result.taskCount,
        }),
      );
    } else if (command === "orphan-task-lists") {
      const orphans = findOrphanTaskLists({ projectsBase, tasksBase });
      console.log(
        toJson(
          orphans.map((o) => ({
            task_list_id: o.taskListId,
            task_count: o.taskCount,
            last_modified: o.lastModified,
            path: o.path,
          })),
        ),
      );
    } else if (command === "session-detail") {
      const cmdIdx = args.indexOf("session-detail");
      const sessionId = args[cmdIdx + 1];
      if (!sessionId || sessionId.startsWith("-")) exitWithError("Missing session ID", 2);
      const detail = getSessionDetail(sessionId, { projectsBase, tasksBase });
      console.log(
        toJson({
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
          task_lists: detail.taskLists.map((tl) => ({
            task_list_id: tl.taskListId,
            tasks: tl.tasks,
          })),
        }),
      );
    } else {
      exitWithError(`Unknown command: ${command}`, 3);
    }
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        exitWithError(`File or directory not found: ${err.message}`, 2);
      } else if (code === "EACCES" || code === "EPERM") {
        exitWithError(`Permission denied: ${err.message}`, 2);
      }
    }
    exitWithError(err, 3);
  }
}
