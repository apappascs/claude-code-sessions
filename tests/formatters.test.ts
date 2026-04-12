// tests/formatters.test.ts
import { describe, expect, test } from "bun:test";
import { formatDuration, formatSize, parseTimestamp, toJson, toNdjson, truncate } from "../lib/formatters";

describe("toJson", () => {
  test("compact serialization", () => {
    const result = toJson({ a: 1, b: "hello" });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ a: 1, b: "hello" });
    expect(result).not.toContain("\n");
  });

  test("handles null values", () => {
    const result = toJson({ a: null });
    expect(JSON.parse(result)).toEqual({ a: null });
  });

  test("handles Date objects", () => {
    const d = new Date("2026-04-10T09:00:00Z");
    const result = toJson({ ts: d });
    const parsed = JSON.parse(result);
    expect(parsed.ts).toContain("2026");
  });

  test("handles Set objects", () => {
    const result = toJson({ items: new Set(["b", "a", "c"]) });
    const parsed = JSON.parse(result);
    expect(parsed.items).toEqual(["a", "b", "c"]);
  });
});

describe("toNdjson", () => {
  test("produces newline-delimited json", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = toNdjson(items);
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ id: 1 });
    expect(JSON.parse(lines[2])).toEqual({ id: 3 });
  });

  test("returns empty string for empty array", () => {
    expect(toNdjson([])).toBe("");
  });
});

describe("truncate", () => {
  test("short string unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  test("long string truncated with ellipsis", () => {
    const result = truncate("a".repeat(200), 50);
    expect(result).toHaveLength(53); // 50 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  test("exact length unchanged", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("formatDuration", () => {
  test("seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  test("minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  test("hours and minutes", () => {
    expect(formatDuration(3661)).toBe("1h 1m");
  });

  test("zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("formatSize", () => {
  test("bytes", () => {
    expect(formatSize(500)).toBe("500 B");
  });

  test("kilobytes", () => {
    expect(formatSize(2048)).toBe("2.0 KB");
  });

  test("megabytes", () => {
    expect(formatSize(5_242_880)).toBe("5.0 MB");
  });

  test("zero bytes", () => {
    expect(formatSize(0)).toBe("0 B");
  });
});

describe("parseTimestamp", () => {
  test("epoch milliseconds", () => {
    const d = parseTimestamp(1712739600000);
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  test("epoch seconds", () => {
    const d = parseTimestamp(1712739600);
    expect(d).toBeInstanceOf(Date);
  });

  test("ISO string", () => {
    const d = parseTimestamp("2026-04-10T09:00:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
  });

  test("null returns null", () => {
    expect(parseTimestamp(null)).toBeNull();
  });

  test("undefined returns null", () => {
    expect(parseTimestamp(undefined)).toBeNull();
  });
});
