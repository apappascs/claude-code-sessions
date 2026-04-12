// lib/session-parser.ts
/**
 * Core JSONL parser for Claude Code sessions.
 *
 * Reads a single session JSONL file and provides structured data extraction.
 *
 * Usage as CLI:
 *   bun run lib/session-parser.ts stats <session.jsonl>
 *   bun run lib/session-parser.ts tasks <session.jsonl>
 *   bun run lib/session-parser.ts export <session.jsonl> [--format md|txt] [--include-tools] [--output FILE]
 *   bun run lib/session-parser.ts resume <session.jsonl>
 *   bun run lib/session-parser.ts diff <session-a.jsonl> <session-b.jsonl>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseTimestamp, toJson, truncate } from "./formatters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  type: string;
  timestamp: string | null;
  uuid: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>;
}

export interface ParsedSession {
  session_id: string;
  path: string;
  message_count: number;
  messages_by_type: Record<string, ParsedMessage[]>;
  messages: ParsedMessage[];
  first_timestamp: string | null;
  last_timestamp: string | null;
}

export interface SessionStats {
  session_id: string;
  turns: number;
  user_messages: number;
  assistant_messages: number;
  duration_minutes: number;
  models: Record<string, number>;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_create: number;
  };
  tools: Record<string, number>;
  first_message: string | null;
  last_message: string | null;
  cwd: string | null;
  is_resumed: boolean;
}

export interface TaskEntry {
  action: "create" | "update";
  description?: string;
  subject?: string;
  task_id?: string;
  status?: string;
  session_id: string | null;
  timestamp: string | null;
}

export interface MessageEntry {
  type: string;
  timestamp: string | null;
  uuid: string | null;
  text?: string;
  tools?: string[];
  toolDetails?: { name: string; input: string }[];
  model?: string;
}

export interface ResumeData {
  session_id: string;
  project: string;
  date_range: string;
  branch: string;
  files_modified: string[];
  last_user_messages: string[];
  tool_calls_summary: Record<string, number>;
  tasks: TaskEntry[];
  git_commits: string[];
}

export interface DiffData {
  id: string;
  date: string | null;
  messages: number;
  files: string[];
  branches: string[];
  tools: Record<string, number>;
  first_user_messages: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a JSONL file line by line, skipping malformed lines.
 * Logs a warning to stderr for each skipped line.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readLines(path: string): Record<string, any>[] {
  const content = readFileSync(path, "utf-8");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Record<string, any>[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      process.stderr.write(`${JSON.stringify({ warning: `Skipped malformed line ${i + 1}`, file: path })}\n`);
    }
  }

  return results;
}

/**
 * Extract text content from a user message object.
 * Handles string, dict, and array content formats.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractUserText(msgObj: Record<string, any>): string {
  let content = msgObj.message ?? "";

  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    content = content.content ?? "";
  }

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "object" && part !== null && part.type === "text") {
        parts.push(String(part.text ?? "").trim());
      }
    }
    return parts.join(" ");
  }

  return "";
}

/**
 * Check if a user message is a system/command injection, not real user input.
 */
export function isSystemMessage(text: string): boolean {
  return text.startsWith("<local-command") || text.startsWith("<command-name>");
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Parse a full session JSONL into structured data.
 */
export function parseSession(path: string): ParsedSession {
  const messagesByType: Record<string, ParsedMessage[]> = {};
  const allMessages: ParsedMessage[] = [];
  let sessionId: string | null = null;
  const timestamps: string[] = [];

  for (const obj of readLines(path)) {
    const msgType: string | undefined = obj.type;
    if (msgType == null) continue;

    if (sessionId === null) {
      sessionId = obj.sessionId ?? null;
    }

    const ts: string | null = obj.timestamp ?? null;
    if (ts) {
      timestamps.push(ts);
    }

    const entry: ParsedMessage = {
      type: msgType,
      timestamp: ts,
      uuid: obj.uuid ?? null,
      raw: obj,
    };

    allMessages.push(entry);
    if (!messagesByType[msgType]) {
      messagesByType[msgType] = [];
    }
    messagesByType[msgType].push(entry);
  }

  // Derive session_id from filename stem if not found in data
  const stem = basename(path).replace(/\.[^.]+$/, "");

  return {
    session_id: sessionId ?? stem,
    path,
    message_count: allMessages.length,
    messages_by_type: messagesByType,
    messages: allMessages,
    first_timestamp: timestamps.length > 0 ? timestamps[0] : null,
    last_timestamp: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
  };
}

/**
 * Extract token usage, model distribution, tool counts, and duration.
 */
export function getStats(path: string): SessionStats {
  const tokenCounts = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
  const models: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  let userCount = 0;
  let assistantCount = 0;
  let isResumed = false;
  const timestamps: string[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;

  for (const obj of readLines(path)) {
    const msgType: string | undefined = obj.type;
    const ts: string | undefined = obj.timestamp;
    if (ts) timestamps.push(ts);
    if (sessionId === null) {
      sessionId = obj.sessionId ?? null;
    }
    if (cwd === null && obj.cwd) {
      cwd = obj.cwd;
    }

    if (msgType === "user") {
      const text = extractUserText(obj);
      if (text && !isSystemMessage(text)) {
        userCount++;
      }
    } else if (msgType === "assistant") {
      assistantCount++;
      const msg = obj.message ?? {};

      // Resumed session detection.
      // Claude Code's --resume/--continue creates a NEW JSONL file with no standard
      // metadata linking back to the parent session (no resumed_from, no parent_session_id).
      // We detect resumed sessions heuristically using three signals (in order of reliability):
      //
      // 1. (Used here) An assistant message with model:"<synthetic>", isApiErrorMessage:false,
      //    and content text "No response requested." — a resume bridge message injected by
      //    Claude Code to maintain message chain continuity.
      // 2. A type:"last-prompt" entry with lastPrompt:"continue" — written when the user
      //    runs `claude --continue`.
      // 3. The startup triplet (custom-title + agent-name + permission-mode) appearing
      //    mid-file rather than only at the start — indicates a CLI reconnection.
      //
      // Signal #1 is the most reliable and sufficient on its own.
      if (msg.model === "<synthetic>" && !msg.isApiErrorMessage) {
        const resumeContent = msg.content ?? [];
        if (Array.isArray(resumeContent)) {
          for (const block of resumeContent) {
            if (
              typeof block === "object" &&
              block !== null &&
              block.type === "text" &&
              block.text === "No response requested."
            ) {
              isResumed = true;
            }
          }
        }
      }

      const model: string = msg.model ?? "unknown";
      models[model] = (models[model] ?? 0) + 1;

      const usage = msg.usage ?? {};
      tokenCounts.input += usage.input_tokens ?? 0;
      tokenCounts.output += usage.output_tokens ?? 0;
      tokenCounts.cache_read += usage.cache_read_input_tokens ?? 0;
      tokenCounts.cache_create += usage.cache_creation_input_tokens ?? 0;

      const content = msg.content ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && block.type === "tool_use") {
            const toolName: string = block.name ?? "unknown";
            toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
          }
        }
      }
    }
  }

  // Duration
  let durationMinutes = 0;
  let firstTsStr: string | null = null;
  let lastTsStr: string | null = null;

  if (timestamps.length > 0) {
    firstTsStr = String(timestamps[0]);
    lastTsStr = String(timestamps[timestamps.length - 1]);
    const firstDt = parseTimestamp(timestamps[0]);
    const lastDt = parseTimestamp(timestamps[timestamps.length - 1]);
    if (firstDt && lastDt) {
      durationMinutes = Math.round(((lastDt.getTime() - firstDt.getTime()) / 60000) * 10) / 10;
    }
  }

  // Sort tools by count descending (matching Python's Counter.most_common())
  const sortedTools = Object.fromEntries(Object.entries(toolCounts).sort(([, a], [, b]) => b - a));

  const stem = basename(path).replace(/\.[^.]+$/, "");

  return {
    session_id: sessionId ?? stem,
    turns: userCount + assistantCount,
    user_messages: userCount,
    assistant_messages: assistantCount,
    duration_minutes: durationMinutes,
    models,
    tokens: tokenCounts,
    tools: sortedTools,
    first_message: firstTsStr,
    last_message: lastTsStr,
    cwd,
    is_resumed: isResumed,
  };
}

/**
 * Extract tasks from TaskCreate/TaskUpdate tool_use blocks.
 */
export function getTasks(path: string): TaskEntry[] {
  const tasks: TaskEntry[] = [];

  for (const obj of readLines(path)) {
    if (obj.type !== "assistant") continue;
    const content = obj.message?.content ?? [];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== "object" || block === null || block.type !== "tool_use") continue;
      const name: string = block.name ?? "";
      const inp = block.input ?? {};

      if (name === "TaskCreate") {
        tasks.push({
          action: "create",
          description: inp.description ?? "",
          subject: inp.subject ?? "",
          session_id: obj.sessionId ?? null,
          timestamp: obj.timestamp ?? null,
        });
      } else if (name === "TaskUpdate") {
        tasks.push({
          action: "update",
          task_id: inp.taskId,
          status: inp.status ?? "",
          session_id: obj.sessionId ?? null,
          timestamp: obj.timestamp ?? null,
        });
      }
    }
  }

  return tasks;
}

/**
 * Get messages, optionally filtered by type.
 */
export function getMessages(path: string, typeFilter?: string): MessageEntry[] {
  const messages: MessageEntry[] = [];

  for (const obj of readLines(path)) {
    const msgType: string | undefined = obj.type;
    if (typeFilter && msgType !== typeFilter) continue;
    if (msgType !== "user" && msgType !== "assistant" && msgType !== "system") continue;

    const entry: MessageEntry = {
      type: msgType,
      timestamp: obj.timestamp ?? null,
      uuid: obj.uuid ?? null,
    };

    if (msgType === "user") {
      entry.text = extractUserText(obj);
      if (!entry.text) continue;
    } else if (msgType === "assistant") {
      const msg = obj.message ?? {};
      const textParts: string[] = [];
      const toolNames: string[] = [];
      const content = msg.content ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null) {
            if (block.type === "text") {
              textParts.push(block.text ?? "");
            } else if (block.type === "tool_use") {
              toolNames.push(block.name ?? "");
            }
          }
        }
      }
      entry.text = textParts.join(" ");
      entry.tools = toolNames;
      entry.model = msg.model ?? "unknown";
    }

    messages.push(entry);
  }

  return messages;
}

/**
 * Get paginated messages from a session.
 * Optionally includes tool call details (name + truncated input).
 */
export function getMessagesPaginated(
  path: string,
  opts?: {
    offset?: number;
    limit?: number;
    typeFilter?: string;
    includeTools?: boolean;
  },
): {
  messages: MessageEntry[];
  total: number;
  hasMore: boolean;
  offset: number;
} {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 100;
  const includeTools = opts?.includeTools ?? false;

  const allMessages: MessageEntry[] = [];

  for (const obj of readLines(path)) {
    const msgType: string | undefined = obj.type;
    if (opts?.typeFilter && msgType !== opts.typeFilter) continue;
    if (msgType !== "user" && msgType !== "assistant" && msgType !== "system") continue;

    const entry: MessageEntry = {
      type: msgType,
      timestamp: obj.timestamp ?? null,
      uuid: obj.uuid ?? null,
    };

    if (msgType === "user") {
      entry.text = extractUserText(obj);
      // Skip tool_result-only messages (system-injected, not real user input)
      if (!entry.text) continue;
    } else if (msgType === "assistant") {
      const msg = obj.message ?? {};
      const textParts: string[] = [];
      const toolNames: string[] = [];
      const toolDetailsList: { name: string; input: string }[] = [];
      const content = msg.content ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null) {
            if (block.type === "text") {
              textParts.push(block.text ?? "");
            } else if (block.type === "tool_use") {
              toolNames.push(block.name ?? "");
              if (includeTools) {
                toolDetailsList.push({
                  name: block.name ?? "unknown",
                  input: truncate(JSON.stringify(block.input ?? {}), 200),
                });
              }
            }
          }
        }
      }
      entry.text = textParts.join(" ");
      entry.tools = toolNames;
      if (includeTools && toolDetailsList.length > 0) {
        entry.toolDetails = toolDetailsList;
      }
      entry.model = msg.model ?? "unknown";
    }

    allMessages.push(entry);
  }

  const total = allMessages.length;
  const paged = allMessages.slice(offset, offset + limit);

  return {
    messages: paged,
    total,
    hasMore: offset + limit < total,
    offset,
  };
}

/**
 * Export session as clean markdown or plain text transcript.
 */
export function exportTranscript(path: string, format: "md" | "txt" = "md", includeTools: boolean = true): string {
  const messages = getMessages(path);
  const lines: string[] = [];

  if (format === "md") {
    lines.push("# Session Transcript\n");
  }

  for (const msg of messages) {
    let ts = msg.timestamp ?? "";
    if (typeof ts === "string" && ts.length > 16) {
      ts = ts.slice(0, 16);
    }

    if (msg.type === "user") {
      const text = msg.text ?? "";
      if (isSystemMessage(text)) continue;
      if (format === "md") {
        lines.push(`## User (${ts})\n`);
        lines.push(`${text}\n`);
      } else {
        lines.push(`[${ts}] User: ${text}\n`);
      }
    } else if (msg.type === "assistant") {
      const text = msg.text ?? "";
      const toolList = msg.tools ?? [];
      const model = msg.model ?? "";

      if (format === "md") {
        lines.push(`## Assistant (${ts}) [${model}]\n`);
        if (text) {
          lines.push(`${text}\n`);
        }
        if (includeTools && toolList.length > 0) {
          lines.push(`*Tools used: ${toolList.join(", ")}*\n`);
        }
      } else {
        lines.push(`[${ts}] Assistant [${model}]: ${text}`);
        if (includeTools && toolList.length > 0) {
          lines.push(`  Tools: ${toolList.join(", ")}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Extract data needed to resume/continue a past session.
 */
export function getResumeData(path: string): ResumeData {
  const stats = getStats(path);
  const tasks = getTasks(path);
  const files = new Set<string>();
  const branches = new Set<string>();
  const lastUserMessages: string[] = [];
  const gitCommits: string[] = [];

  for (const obj of readLines(path)) {
    const msgType: string | undefined = obj.type;
    const branch: string | undefined = obj.gitBranch;
    if (branch) {
      branches.add(branch);
    }

    if (msgType === "user") {
      const text = extractUserText(obj);
      if (text && !isSystemMessage(text)) {
        lastUserMessages.push(truncate(text, 300));
      }
    } else if (msgType === "assistant") {
      const content = obj.message?.content ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && block.type === "tool_use") {
            const inp = block.input ?? {};
            const fp: string = inp.file_path ?? "";
            if (fp) {
              files.add(fp);
            }
            const name: string = block.name ?? "";
            if (name === "Bash") {
              const cmd: string = inp.command ?? "";
              if (cmd.includes("git commit")) {
                gitCommits.push(truncate(cmd, 200));
              }
            }
          }
        }
      }
    }
  }

  const sortedBranches = [...branches].sort();

  return {
    session_id: stats.session_id,
    project: dirname(path),
    date_range: `${stats.first_message} - ${stats.last_message}`,
    branch: sortedBranches.length > 0 ? sortedBranches[sortedBranches.length - 1] : "unknown",
    files_modified: [...files].sort(),
    last_user_messages: lastUserMessages.slice(-5),
    tool_calls_summary: stats.tools,
    tasks,
    git_commits: gitCommits,
  };
}

/**
 * Extract data from a single session for diffing against another.
 */
export function getDiffData(path: string): DiffData {
  const stats = getStats(path);
  const files = new Set<string>();
  const branches = new Set<string>();
  const firstUserMessages: string[] = [];

  for (const obj of readLines(path)) {
    const branch: string | undefined = obj.gitBranch;
    if (branch) {
      branches.add(branch);
    }

    if (obj.type === "user") {
      const text = extractUserText(obj);
      if (text && !isSystemMessage(text) && firstUserMessages.length < 3) {
        firstUserMessages.push(truncate(text, 200));
      }
    } else if (obj.type === "assistant") {
      const content = obj.message?.content ?? [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && block.type === "tool_use") {
            const fp: string = block.input?.file_path ?? "";
            if (fp) {
              files.add(fp);
            }
          }
        }
      }
    }
  }

  return {
    id: stats.session_id,
    date: stats.first_message,
    messages: stats.turns,
    files: [...files].sort(),
    branches: [...branches].sort(),
    tools: stats.tools,
    first_user_messages: firstUserMessages,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const command = args[0];

  function exitWithError(err: unknown, code: number): never {
    process.stderr.write(`${JSON.stringify({ error: String(err), code })}\n`);
    process.exit(code);
  }

  try {
    if (!command) {
      process.stderr.write("Usage: bun run lib/session-parser.ts <stats|tasks|export|resume|diff|messages> ...\n");
      process.exit(1);
    }

    if (command === "stats") {
      const sessionPath = args[1];
      if (!sessionPath) exitWithError("Missing session path", 2);
      console.log(toJson(getStats(sessionPath)));
    } else if (command === "tasks") {
      const sessionPath = args[1];
      if (!sessionPath) exitWithError("Missing session path", 2);
      console.log(toJson(getTasks(sessionPath)));
    } else if (command === "export") {
      const sessionPath = args[1];
      if (!sessionPath) exitWithError("Missing session path", 2);

      let format: "md" | "txt" = "md";
      let includeTools = true;
      let outputFile: string | null = null;

      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--format" && args[i + 1]) {
          const fmt = args[++i];
          if (fmt === "md" || fmt === "txt") format = fmt;
        } else if (args[i] === "--include-tools") {
          includeTools = true;
        } else if (args[i] === "--no-include-tools") {
          includeTools = false;
        } else if (args[i] === "--output" && args[i + 1]) {
          outputFile = args[++i];
        }
      }

      const transcript = exportTranscript(sessionPath, format, includeTools);
      if (outputFile) {
        writeFileSync(outputFile, transcript);
        console.log(
          JSON.stringify({
            status: "ok",
            path: outputFile,
            lines: transcript.trimEnd().split("\n").length,
          }),
        );
      } else {
        console.log(transcript);
      }
    } else if (command === "resume") {
      const sessionPath = args[1];
      if (!sessionPath) exitWithError("Missing session path", 2);
      console.log(toJson(getResumeData(sessionPath)));
    } else if (command === "diff") {
      const sessionA = args[1];
      const sessionB = args[2];
      if (!sessionA || !sessionB) exitWithError("Missing session paths", 2);

      const dataA = getDiffData(sessionA);
      const dataB = getDiffData(sessionB);
      const filesA = new Set(dataA.files);
      const filesB = new Set(dataB.files);

      const result = {
        session_a: dataA,
        session_b: dataB,
        files_added: [...filesB].filter((f) => !filesA.has(f)).sort(),
        files_dropped: [...filesA].filter((f) => !filesB.has(f)).sort(),
        files_common: [...filesA].filter((f) => filesB.has(f)).sort(),
      };
      console.log(toJson(result));
    } else if (command === "messages") {
      const sessionPath = args[1];
      if (!sessionPath) exitWithError("Missing session path", 2);

      let offset = 0;
      let limit = 100;
      let includeTools = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--offset" && args[i + 1]) {
          offset = parseInt(args[++i], 10) || 0;
        } else if (args[i] === "--limit" && args[i + 1]) {
          limit = parseInt(args[++i], 10) || 100;
        } else if (args[i] === "--include-tools") {
          includeTools = true;
        }
      }

      const result = getMessagesPaginated(sessionPath, { offset, limit, includeTools });
      console.log(toJson(result));
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
