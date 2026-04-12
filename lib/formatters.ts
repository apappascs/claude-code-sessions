// lib/formatters.ts

/**
 * Shared output helpers for claude-code-sessions plugin.
 * All formatters output JSON-compatible data.
 */

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Set) {
    return [...value].sort();
  }
  return value;
}

/** Compact JSON serialization. Handles Date and Set. */
export function toJson(obj: unknown): string {
  return JSON.stringify(obj, jsonReplacer);
}

/** Newline-delimited JSON for streaming results. */
export function toNdjson(items: unknown[]): string {
  if (items.length === 0) return "";
  return `${items.map((item) => toJson(item)).join("\n")}\n`;
}

/** Truncate text with ellipsis if over maxLen. */
export function truncate(text: string, maxLen: number = 200): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

/** Human-readable duration from seconds. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) {
    return secs === 0 ? `${minutes}m` : `${minutes}m ${secs}s`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/** Human-readable file size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse a timestamp from session JSONL. Handles epoch ms, epoch s, ISO strings. */
export function parseTimestamp(ts: string | number | null | undefined): Date | null {
  if (ts == null) return null;
  try {
    if (typeof ts === "number") {
      return ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
    }
    const str = String(ts).replace("Z", "+00:00");
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}
