// tests/session-parser.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportTranscript,
  extractUserText,
  getDiffData,
  getMessages,
  getMessagesPaginated,
  getResumeData,
  getStats,
  getTasks,
  isSystemMessage,
  parseSession,
  readLines,
} from "../lib/session-parser";

const FIXTURE = join(import.meta.dir, "fixtures", "sample_session.jsonl");

describe("parseSession", () => {
  test("returns all messages", () => {
    const result = parseSession(FIXTURE);
    expect(result.session_id).toBe("test-session-001");
    expect(result.message_count).toBeGreaterThan(0);
    expect(result.messages_by_type.user).toBeDefined();
    expect(result.messages_by_type.assistant).toBeDefined();
  });

  test("handles empty file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sp-"));
    const f = join(tmp, "empty.jsonl");
    try {
      writeFileSync(f, "");
      const result = parseSession(f);
      expect(result.message_count).toBe(0);
      expect(result.messages_by_type).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  test("handles corrupted lines", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sp-"));
    const f = join(tmp, "corrupt.jsonl");
    try {
      writeFileSync(
        f,
        '{"type":"user","message":{"content":"hello"},"uuid":"u1","timestamp":"2026-04-10T09:00:00Z","sessionId":"s1"}\n' +
          "this is not json\n" +
          '{"type":"user","message":{"content":"world"},"uuid":"u2","timestamp":"2026-04-10T09:01:00Z","sessionId":"s1"}\n',
      );
      const result = parseSession(f);
      expect(result.messages_by_type.user).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe("getStats", () => {
  test("token counts", () => {
    const stats = getStats(FIXTURE);
    expect(stats.tokens.input).toBeGreaterThan(0);
    expect(stats.tokens.output).toBeGreaterThan(0);
    expect(stats.turns).toBeGreaterThan(0);
  });

  test("model distribution", () => {
    const stats = getStats(FIXTURE);
    expect(stats.models["claude-sonnet-4-20250514"]).toBeDefined();
    expect(stats.models["claude-opus-4-20250514"]).toBeDefined();
  });

  test("tool counts", () => {
    const stats = getStats(FIXTURE);
    expect(stats.tools.Glob).toBeGreaterThanOrEqual(1);
    expect(stats.tools.Edit).toBeGreaterThanOrEqual(1);
    expect(stats.tools.Bash).toBeGreaterThanOrEqual(1);
  });

  test("duration", () => {
    const stats = getStats(FIXTURE);
    expect(stats.duration_minutes).toBeGreaterThan(0);
  });
});

describe("getTasks", () => {
  test("extracts TaskCreate", () => {
    const tasks = getTasks(FIXTURE);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].description).toBe("Add input validation to CLI parser");
  });
});

describe("getMessages", () => {
  test("filter by type", () => {
    const userMsgs = getMessages(FIXTURE, "user");
    expect(userMsgs.every((m) => m.type === "user")).toBe(true);

    const assistantMsgs = getMessages(FIXTURE, "assistant");
    expect(assistantMsgs.every((m) => m.type === "assistant")).toBe(true);
  });

  test("all messages", () => {
    const all = getMessages(FIXTURE);
    const types = new Set(all.map((m) => m.type));
    expect(types.has("user")).toBe(true);
    expect(types.has("assistant")).toBe(true);
  });
});

describe("getMessagesPaginated", () => {
  test("returns first page of messages with total and hasMore", () => {
    const result = getMessagesPaginated(FIXTURE, { offset: 0, limit: 2 });
    expect(result.messages.length).toBe(2);
    expect(result.total).toBeGreaterThan(2);
    expect(result.hasMore).toBe(true);
    expect(result.offset).toBe(0);
  });

  test("returns second page of messages", () => {
    const result = getMessagesPaginated(FIXTURE, { offset: 2, limit: 2 });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.offset).toBe(2);
  });

  test("returns all messages when limit exceeds total", () => {
    const result = getMessagesPaginated(FIXTURE, { offset: 0, limit: 1000 });
    expect(result.hasMore).toBe(false);
    expect(result.messages.length).toBe(result.total);
  });

  test("includes tool details when includeTools is true", () => {
    const withTools = getMessagesPaginated(FIXTURE, { offset: 0, limit: 100, includeTools: true });
    const withoutTools = getMessagesPaginated(FIXTURE, { offset: 0, limit: 100, includeTools: false });

    // Tool-included messages should have toolDetails populated
    const assistantWithTools = withTools.messages.find((m) => m.tools && m.tools.length > 0);
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.toolDetails).toBeDefined();
    expect(assistantWithTools!.toolDetails!.length).toBeGreaterThan(0);

    // Without tools, toolDetails should be undefined
    const assistantWithout = withoutTools.messages.find((m) => m.tools && m.tools.length > 0);
    expect(assistantWithout!.toolDetails).toBeUndefined();
  });
});

describe("exportTranscript", () => {
  test("markdown format", () => {
    const transcript = exportTranscript(FIXTURE, "md");
    expect(transcript).toContain("## User");
    expect(transcript).toContain("list all Python files");
  });

  test("includes tool summary", () => {
    const transcript = exportTranscript(FIXTURE, "md");
    expect(transcript.includes("Glob") || transcript.toLowerCase().includes("glob")).toBe(true);
  });
});

describe("getResumeData", () => {
  test("extracts resume context", () => {
    const data = getResumeData(FIXTURE);
    expect(data.session_id).toBe("test-session-001");
    expect(data.files_modified.length).toBeGreaterThan(0);
    expect(data.last_user_messages.length).toBeGreaterThan(0);
    expect(data.tool_calls_summary).toBeDefined();
  });
});

describe("getDiffData", () => {
  test("extracts diff context", () => {
    const data = getDiffData(FIXTURE);
    expect(data.id).toBeDefined();
    expect(data.files).toBeDefined();
    expect(data.branches).toBeDefined();
    expect(data.tools).toBeDefined();
    expect(data.first_user_messages).toBeDefined();
  });
});

describe("readLines", () => {
  test("parses valid JSONL", () => {
    const lines = readLines(FIXTURE);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toHaveProperty("type");
  });

  test("skips malformed lines", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rl-"));
    const f = join(tmp, "mixed.jsonl");
    try {
      writeFileSync(f, '{"type":"user"}\nnot json\n{"type":"assistant"}\n');
      const lines = readLines(f);
      expect(lines).toHaveLength(2);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe("extractUserText", () => {
  test("extracts from string content", () => {
    const text = extractUserText({ message: { content: "hello world" } });
    expect(text).toBe("hello world");
  });

  test("extracts from string message", () => {
    const text = extractUserText({ message: "hello" });
    expect(text).toBe("hello");
  });

  test("extracts from array content", () => {
    const text = extractUserText({
      message: {
        content: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" },
        ],
      },
    });
    expect(text).toBe("part1 part2");
  });

  test("returns empty for no content", () => {
    expect(extractUserText({})).toBe("");
  });
});

describe("isSystemMessage", () => {
  test("detects local-command messages", () => {
    expect(isSystemMessage("<local-command>foo</local-command>")).toBe(true);
  });

  test("detects command-name messages", () => {
    expect(isSystemMessage("<command-name>bar</command-name>")).toBe(true);
  });

  test("returns false for normal text", () => {
    expect(isSystemMessage("hello world")).toBe(false);
  });
});
