# Analytics Enhancements Design Spec

Three features to add analytics depth to claude-code-sessions: date range filtering across all commands, human-readable table output for CLI, and dashboard charts for token/model/activity visualization.

---

## Table of Contents

1. [Feature 1: Date Range Filtering](#feature-1-date-range-filtering)
2. [Feature 2: Human-Readable Table Output](#feature-2-human-readable-table-output)
3. [Feature 3: Dashboard Charts](#feature-3-dashboard-charts)
4. [Cross-Cutting Concerns](#cross-cutting-concerns)

---

## Feature 1: Date Range Filtering

### Problem

`searchSessions` already accepts a `since` option, but no other store function does. Users cannot filter `listSessions`, `getTimeline`, `aggregateTasks`, or `findCleanupCandidates` by date. The CLI exposes `--since` only on the `search` subcommand. The API has no date filtering at all outside `/api/search`.

### Design

**Shared date parsing helper** in `lib/formatters.ts`:

```typescript
/**
 * Parse a date range boundary.
 * Accepts: ISO date ("2026-04-01"), relative shorthand ("7d", "2w", "3m"),
 * or ISO datetime ("2026-04-01T14:00:00Z").
 * Returns a Date or null if unparseable.
 */
export function parseDateBoundary(input: string): Date | null
```

Relative shorthand rules:
- `Nd` = N days ago from now
- `Nw` = N weeks ago (N * 7 days)
- `Nm` = N months ago (subtract N from month)
- ISO date string = midnight UTC on that date
- ISO datetime = exact timestamp

**Store layer changes** — add `since?: string` and `until?: string` to these option interfaces:

| Function | Options Interface | Current `since` | Add `until` |
|---|---|---|---|
| `listSessions` | `ListSessionsOptions` | no | yes |
| `searchSessions` | `SearchSessionsOptions` | yes (raw `Date` parse) | yes |
| `getTimeline` | `GetTimelineOptions` | yes (raw `Date` parse) | yes |
| `aggregateTasks` | `AggregateTasksOptions` | no | yes |
| `findCleanupCandidates` | `FindCleanupCandidatesOptions` | no (uses `olderThan`) | no (keep `olderThan` pattern) |

Filtering logic: use `parseDateBoundary()` to convert strings to `Date`. Filter sessions by their `lastActivity` (or `started` as fallback). For `searchSessions`, the existing per-message timestamp filter stays; `since`/`until` also applies to the outer session loop for early exit.

**CLI changes** — add `--since` and `--until` flags to all `session-store.ts` subcommands. The flags accept the same formats as `parseDateBoundary`. (`session-parser.ts` operates on a single file, so date filtering does not apply there.)

Affected subcommands:
- `session-store.ts list` — add `--since`, `--until`
- `session-store.ts search` — keep existing `--since`, add `--until`
- `session-store.ts timeline` — keep existing `--since`, add `--until`
- `session-store.ts tasks` — add `--since`, `--until`

**API changes** — pass through `since` and `until` query parameters on these endpoints:

| Endpoint | Params to add |
|---|---|
| `GET /api/sessions` | `since`, `until` |
| `GET /api/search` | `until` (already has `since`) |
| `GET /api/tasks` | `since`, `until` |
| `GET /api/dashboard/stats` | `since`, `until` |

**Skills** — skills that invoke CLI commands (`session-list`, `session-search`, `session-timeline`) gain the flags automatically when the CLI is updated. No SKILL.md changes needed since Claude Code passes through user-provided flags.

### Edge Cases

- `since` > `until`: return empty result set, no error
- Missing `since` or `until`: unbounded on that side (current behavior)
- Invalid date string: silently ignore (treat as no filter), matching current `searchSessions` behavior
- `findCleanupCandidates` keeps its own `--older-than Nd` pattern rather than adopting `since`/`until` — different semantic (age-based threshold vs. date window)

---

## Feature 2: Human-Readable Table Output

### Problem

The CLI outputs JSON by default. This is ideal for piping and skill consumption, but hard to scan visually. Competitors offer formatted table output. Our CLI should support both.

### Design

**New `formatTable()` helper** in `lib/formatters.ts`:

```typescript
interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  width?: number;         // max width, truncate with ellipsis
  format?: (value: unknown) => string;  // custom formatter
}

/**
 * Format an array of objects as a plain-text aligned table.
 * Uses Unicode box-drawing characters for separators.
 * Respects terminal width when available.
 */
export function formatTable(rows: Record<string, unknown>[], columns: TableColumn[]): string
```

Table rendering rules:
- Header row with column labels, separated by `---` line
- Left-align text columns, right-align numeric columns
- Truncate long values with `...` (use existing `truncate()`)
- No color/ANSI codes — keep it simple and pipe-safe
- Summary footer line (e.g., "20 sessions" or "5 results")

**CLI `--format` flag** on all subcommands:
- `--format json` (default, current behavior)
- `--format table` (human-readable)
- `--json` as explicit alias for `--format json` (backward compat)

**Per-subcommand table layouts:**

`list`:
```
SESSION ID     PROJECT              DATE        MSGS   DURATION   SIZE
abc123de       /Users/me/project    2026-04-21  42     1h 23m     2.1 MB
```

`search`:
```
SESSION ID     PROJECT              TIMESTAMP            MATCH
abc123de       /Users/me/project    2026-04-21 14:23     "fix the auth bug in..."
```

`tasks`:
```
STATUS      SUBJECT                          SESSION
pending     Fix login flow                   abc123de
completed   Add unit tests for parser        def456gh
```

`timeline`:
```
DATE         SESSIONS   MESSAGES   DURATION
2026-04-21   3          127        4h 12m
2026-04-20   5          243        6h 45m
```

**No API changes needed** — the API always returns JSON. Table formatting is CLI-only.

---

## Feature 3: Dashboard Charts

### Problem

The dashboard view shows summary stats as text. Users cannot visualize trends (token usage over time, model distribution, activity patterns). Competitors with charts provide significantly better UX for understanding usage patterns.

### Library Choice

**Chart.js via CDN** — matches the existing Alpine.js CDN pattern. No build step, no bundling. Lightweight (~60 KB gzipped). Good Canvas rendering performance.

```html
<script defer src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
```

### Chart Types

Three charts, each with a dedicated API endpoint and aggregation function.

#### Chart 1: Daily Token Timeline (Stacked Bar)

**What it shows:** Daily token usage broken down by type (input, output, cache_read, cache_create) over the last 30 days.

**API endpoint:** `GET /api/charts/daily-tokens?since=30d&until=`

Response:
```json
{
  "labels": ["2026-03-22", "2026-03-23", ...],
  "datasets": {
    "input": [12340, 8920, ...],
    "output": [45600, 32100, ...],
    "cache_read": [8900, 7200, ...],
    "cache_create": [3400, 2800, ...]
  }
}
```

**Store function:** `getDailyTokenAggregation(opts)` in `session-store.ts`

```typescript
interface DailyTokenAggregationOptions {
  since?: string;
  until?: string;
  projectFilter?: string;
  projectsBase?: string;
}

interface DailyTokenData {
  labels: string[];      // ISO date strings
  datasets: {
    input: number[];
    output: number[];
    cache_read: number[];
    cache_create: number[];
  };
}
```

Implementation: iterate all sessions in range, call `getStats()` for each, bucket tokens by the session's date. Sessions spanning midnight count toward their start date.

**Visual design:**

- Stacked vertical bars — token types stack within each day
- Color mapping using OKLCH design tokens:
  - Input tokens: `--accent` (brand ochre) — the primary token type, earns the brand color
  - Output tokens: `--green` — productive output, semantically "success"
  - Cache read: `--text-tertiary` (muted neutral) — passive reuse, low visual weight
  - Cache create: `--amber` — active investment, attention-worthy
- Y-axis: token count, abbreviated (e.g., "12.3k", "1.2M")
- X-axis: date labels, showing day-of-month with month prefix on first occurrence or month boundary
- Bar border: none. Bars sit flush to maintain density
- Grid lines: `--surface-3` (subtle), horizontal only
- Background: transparent (inherits `--surface-0`)
- Tooltip: show exact values per token type for hovered day
- Dual-theme: Chart.js `color` and `borderColor` options read from CSS custom properties at render time. Theme toggle triggers chart re-render with updated colors.

#### Chart 2: Model Distribution (Donut)

**What it shows:** Proportion of token usage by model across the selected time range.

**API endpoint:** `GET /api/charts/model-distribution?since=30d&until=`

Response:
```json
{
  "models": [
    { "model": "claude-opus-4-6", "tokens": 234500, "sessions": 12 },
    { "model": "claude-sonnet-4-6", "tokens": 156200, "sessions": 8 }
  ]
}
```

**Store function:** `getModelDistribution(opts)` in `session-store.ts`

```typescript
interface ModelDistributionOptions {
  since?: string;
  until?: string;
  projectFilter?: string;
  projectsBase?: string;
}

interface ModelDistributionEntry {
  model: string;
  tokens: number;
  sessions: number;
}
```

Implementation: iterate sessions in range, call `getStats()`, accumulate total tokens (all types summed) per model name. Sort descending by token count. Group models with <3% share into "Other".

**Visual design:**

- Donut chart (Chart.js `doughnut` type), cutout ratio 65%
- Center text: total token count, formatted with abbreviation (e.g., "1.2M tokens")
- Color assignment: sequential OKLCH hues starting from hue 85 (brand), stepping by golden angle (~137.5 degrees) to ensure visual separation. Maximum 6 distinct colors; 7th+ segments use `--text-tertiary`
- Segment borders: `--surface-0` (1px) to separate visually without adding decoration
- Legend: positioned below the chart, horizontal layout. Each entry: color swatch (8x8 square, `--radius-sm`) + model name in `--text-secondary` + token count in `--text-tertiary`
- Hover: highlight segment, show model name + exact count + percentage in tooltip
- No drop shadows, no 3D effects, no exploded segments

#### Chart 3: Activity Heatmap (7x24 Grid)

**What it shows:** Session activity concentration by day-of-week and hour-of-day. Reveals when the user is most active with Claude Code.

**API endpoint:** `GET /api/charts/activity-heatmap?since=30d&until=`

Response:
```json
{
  "grid": [
    [0, 0, 0, 0, 0, 1, 3, 5, 8, 12, 10, 7, ...],
    ...
  ],
  "maxValue": 12,
  "dayLabels": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  "hourLabels": ["00", "01", "02", ..., "23"]
}
```

`grid[dayOfWeek][hour]` = number of sessions active during that slot.

**Store function:** `getActivityHeatmap(opts)` in `session-store.ts`

```typescript
interface ActivityHeatmapOptions {
  since?: string;
  until?: string;
  projectFilter?: string;
  projectsBase?: string;
}

interface ActivityHeatmapData {
  grid: number[][];       // 7 rows (Mon-Sun) x 24 cols (hours)
  maxValue: number;
  dayLabels: string[];
  hourLabels: string[];
}
```

Implementation: iterate sessions in range, parse `started` timestamp, map to local day-of-week (0=Mon, 6=Sun) and hour (0-23). Increment grid cell. A session counts once toward its start hour.

**Visual design:**

This chart is rendered as a **custom Canvas element**, not a Chart.js chart type (Chart.js doesn't have a native heatmap). Implementation uses a small rendering function in `app.js` that draws directly to a `<canvas>`.

- Grid: 24 columns (hours) x 7 rows (days), each cell is a rounded rectangle (2px radius)
- Cell size: calculated to fill available width, aspect ratio ~1.6:1 (wider than tall)
- Cell gap: 2px
- Color intensity: linear interpolation from `--surface-2` (zero activity) to `--accent` (max activity). Use 5 discrete steps rather than continuous gradient for readability:
  - 0: `--surface-2`
  - 1-25%: `--accent-subtle`
  - 25-50%: `--accent-muted`
  - 50-75%: `--accent` at 50% opacity
  - 75-100%: `--accent` at full opacity
- Row labels (left): day abbreviations in `--text-secondary`, `--text-sm`, `--font-mono`
- Column labels (top): hour labels (00, 06, 12, 18 only — skip intermediate hours to reduce clutter)
- Hover: show tooltip with "Tuesday 14:00 — 8 sessions"
- No axis lines, no background grid. The cells themselves create the visual structure.

### Dashboard Layout

The charts section appears below the existing dashboard stats on the Dashboard view.

```
+--------------------------------------------------+
|  DASHBOARD STATS (existing)                       |
|  Total Sessions: 142   Active Today: 3   ...      |
+--------------------------------------------------+
|                                                    |
|  +-- Date Range Picker -------------------------+  |
|  |  [7d] [14d] [30d] [90d]                      |  |
|  +----------------------------------------------+  |
|                                                    |
|  +-- Daily Token Usage ---------+  +-- Models --+  |
|  |  [stacked bar chart]         |  |  [donut]   |  |
|  |  ████ ████ ███ ████ ██      |  |   ████     |  |
|  |  ████ ████ ███ ████ ██      |  |  ██████    |  |
|  +------------------------------+  +-----------+  |
|                                                    |
|  +-- Activity Heatmap --------------------------+  |
|  |  Mon  ░░░░░░░░▓▓▓▓▓▓▓▓▒▒░░░░░░              |  |
|  |  Tue  ░░░░░░░▓▓▓▓▓▓▓▓▓▒▒░░░░░░              |  |
|  |  ...                                          |  |
|  +----------------------------------------------+  |
+--------------------------------------------------+
```

**Grid layout:** CSS Grid, 2 columns for the top row (token chart takes ~65% width, donut takes ~35%). Heatmap spans full width below. Single column on viewports < 768px.

**Date range picker:**
- Row of preset buttons: 7d, 14d, 30d, 90d
- "30d" selected by default
- Buttons use `--surface-2` background, `--text-secondary` text. Active button: `--accent-muted` background, `--accent` text
- No custom date inputs in v1 — presets cover the practical range. Custom inputs can be added later if needed.
- Changing the date range re-fetches all three chart endpoints and re-renders
- The date range picker also filters the existing dashboard stats (`/api/dashboard/stats?since=30d`)

**Section headers:**
- Each chart has a header: section title in `--text-sm`, `--weight-semibold`, `--text-secondary`, uppercase tracking
- No borders or cards around charts. Sections separated by `--space-xl` vertical gap
- Headers: "TOKEN USAGE", "MODEL DISTRIBUTION", "ACTIVITY"

**Loading states:**
- While chart data loads, show a skeleton placeholder: `--surface-2` rounded rectangle matching chart dimensions, subtle pulse animation using existing `--transition-slow` timing
- Charts render independently — show each as its data arrives rather than waiting for all three

**Empty states:**
- If no data in range: show centered text "No session data for this period" in `--text-tertiary`, `--text-sm`
- If no tokens but sessions exist: token chart shows empty bars, donut shows "0 tokens" center text

### Frontend Implementation

**Alpine.js store extension:** Add a `charts` store to `app.js`:

```javascript
Alpine.store('charts', {
  range: '30d',
  dailyTokens: null,
  modelDistribution: null,
  activityHeatmap: null,
  loading: { tokens: false, models: false, heatmap: false },

  async setRange(range) { /* update range, refetch all */ },
  async fetchAll() { /* parallel fetch all 3 endpoints */ },
  renderTokenChart(canvas) { /* Chart.js stacked bar */ },
  renderModelChart(canvas) { /* Chart.js donut */ },
  renderHeatmap(canvas) { /* custom canvas rendering */ },
})
```

**Chart.js configuration principles:**
- Disable all default animations (set `animation: false`) — aligns with "unhurried" brand; data appears immediately
- Disable default legend for token chart (use custom inline legend)
- Font family: `--font-mono` for axis labels, `--font-sans` for tooltips
- Tooltip style: `--surface-3` background, `--text-primary` text, `--radius-sm` border radius, no caret/arrow
- Responsive: `true`, maintain aspect ratio: `false` (let CSS grid control dimensions)

**Theme reactivity:** When `toggleTheme()` fires, charts must re-render with updated colors. Store the Chart.js instances and call `.destroy()` + recreate on theme change, reading fresh CSS custom property values via `getComputedStyle()`.

---

## Cross-Cutting Concerns

### Performance

- **`getStats()` is expensive** — it parses entire JSONL files. For chart endpoints covering 30+ days with potentially hundreds of sessions, this could be slow.
- **Mitigation v1:** The API endpoints accept `since`/`until` so only relevant sessions are parsed. The heatmap and model distribution only need timestamps and model names from stats, not full message data.
- **Mitigation v2 (future):** If performance becomes an issue, add a lightweight stats cache (JSON file in `~/.cache/claude-code-sessions/`) that stores per-session token/model summaries. Not in scope for this spec.

### Testing

- `parseDateBoundary()`: unit tests for all formats (ISO date, ISO datetime, relative Nd/Nw/Nm, invalid input, edge cases)
- `formatTable()`: unit tests for alignment, truncation, empty data, single row
- `getDailyTokenAggregation()`: integration test with temp JSONL fixtures, verify bucketing
- `getModelDistribution()`: integration test, verify grouping and "Other" threshold
- `getActivityHeatmap()`: integration test, verify grid dimensions and cell values
- Date filtering on existing functions: add test cases to existing test files
- Server endpoints: add test cases to `tests/server.test.ts` for new chart endpoints and `since`/`until` passthrough
- No frontend tests — visual verification via dev server

### File Changes Summary

| File | Changes |
|---|---|
| `lib/formatters.ts` | Add `parseDateBoundary()`, `formatTable()` |
| `lib/session-store.ts` | Add `since`/`until` to option interfaces; add `getDailyTokenAggregation()`, `getModelDistribution()`, `getActivityHeatmap()` |
| `ui/server.ts` | Add 3 chart endpoints; add `since`/`until` passthrough to existing endpoints |
| `ui/public/index.html` | Add Chart.js CDN script tag; add chart section markup to dashboard view |
| `ui/public/js/app.js` | Add `charts` Alpine store; chart rendering functions; date range picker logic |
| `ui/public/css/components.css` | Chart section layout styles, date picker buttons, skeleton loaders |
| `tests/formatters.test.ts` | Tests for `parseDateBoundary()`, `formatTable()` |
| `tests/session-store.test.ts` | Tests for new aggregation functions, date filtering |
| `tests/server.test.ts` | Tests for chart endpoints, date param passthrough |

### What This Spec Does NOT Include

- **Cost estimation** — explicitly dropped. Too complicated with tiered pricing, batch discounts, Pro/Max subscriptions, fast mode multipliers.
- **AI session summaries** — users can already generate these on-demand via the `session-export` skill. Automatic generation would be expensive and potentially unwanted.
- **Custom date range picker** — preset buttons (7d/14d/30d/90d) cover practical use. Custom inputs deferred to future iteration.
- **Stats caching** — performance optimization deferred until real-world measurement shows it's needed.
- **Export charts as image** — not in scope for v1.
