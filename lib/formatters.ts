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

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  width?: number;
  format?: (value: unknown) => string;
}

/** Format an array of objects as a plain-text aligned table. */
export function formatTable(rows: Record<string, unknown>[], columns: TableColumn[]): string {
  // Compute cell values
  const cells: string[][] = rows.map((row) =>
    columns.map((col) => {
      const raw = row[col.key];
      let val = col.format ? col.format(raw) : String(raw ?? "");
      if (col.width && val.length > col.width) {
        val = truncate(val, col.width);
      }
      return val;
    }),
  );

  // Compute column widths
  const widths = columns.map((col, i) => {
    const dataMax = cells.reduce((max, row) => Math.max(max, row[i].length), 0);
    return Math.max(col.label.length, dataMax);
  });

  // Render header
  const header = columns
    .map((col, i) => {
      const w = widths[i];
      return col.align === "right" ? col.label.padStart(w) : col.label.padEnd(w);
    })
    .join("  ");

  // Separator
  const sep = widths.map((w) => "─".repeat(w)).join("──");

  // Data rows
  const dataLines = cells.map((row) =>
    columns
      .map((col, i) => {
        const w = widths[i];
        return col.align === "right" ? row[i].padStart(w) : row[i].padEnd(w);
      })
      .join("  "),
  );

  // Footer
  const footer = `${rows.length} row${rows.length !== 1 ? "s" : ""}`;

  return [header, sep, ...dataLines, footer].join("\n");
}

/**
 * Parse a date range boundary string.
 * Accepts: ISO date ("2026-04-01"), relative shorthand ("7d", "2w", "3m"),
 * or ISO datetime ("2026-04-01T14:00:00Z").
 * Returns a Date or null if unparseable.
 */
export function parseDateBoundary(input: string): Date | null {
  if (!input) return null;

  // Relative: Nd, Nw, Nm
  const relMatch = input.match(/^(\d+)([dwm])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const now = new Date();
    if (unit === "d") {
      now.setDate(now.getDate() - n);
    } else if (unit === "w") {
      now.setDate(now.getDate() - n * 7);
    } else if (unit === "m") {
      now.setMonth(now.getMonth() - n);
    }
    return now;
  }

  // ISO date or datetime
  try {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d;
  } catch {
    // fall through
  }

  return null;
}
