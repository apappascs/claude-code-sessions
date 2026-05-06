// lib/memory-scanner.ts
/**
 * Memory scanning, auditing, and search across Claude Code projects.
 *
 * Scans ~/.claude/projects/{project}/memory/ to discover, health-check, and search memory files.
 *
 * Usage as CLI:
 *   bun run lib/memory-scanner.ts scan [--type TYPE] [--project FILTER] [--format table|json]
 *   bun run lib/memory-scanner.ts audit [--age-threshold N] [--projects-base PATH]
 *   bun run lib/memory-scanner.ts search "<query>" [--type TYPE] [--project FILTER] [--context N] [--limit N]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { formatTable, toJson, toNdjson, truncate } from "./formatters";

const DEFAULT_PROJECTS_BASE = join(homedir(), ".claude", "projects");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Frontmatter {
  name: string | null;
  description: string | null;
  type: string | null;
  body: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference" | "unknown";

export interface MemoryFile {
  project: string;
  projectReadable: string;
  file: string;
  path: string;
  name: string | null;
  type: MemoryType;
  description: string | null;
  ageDays: number;
  sizeBytes: number;
  hasFrontmatter: boolean;
  indexed: boolean;
}

export interface ScanResult {
  projectsScanned: number;
  projectsWithMemories: number;
  totalMemories: number;
  byType: Record<string, number>;
  memories: MemoryFile[];
}

export type FindingSeverity = "critical" | "warning" | "info";

export type FindingCategory =
  | "expired"
  | "broken_link"
  | "orphan"
  | "missing_frontmatter"
  | "stale"
  | "index_mismatch"
  | "stale_path"
  | "duplicate";

export type FixType = "auto" | "ai_assisted";

export interface AuditFinding {
  severity: FindingSeverity;
  category: FindingCategory;
  fixType: FixType;
  file: string;
  project: string;
  path: string;
  message: string;
  suggestion: string;
  autoFixable: boolean;
  aiAction?: string;
}

export interface AuditResult {
  summary: {
    totalMemories: number;
    healthy: number;
    issuesFound: number;
    bySeverity: Record<FindingSeverity, number>;
  };
  findings: AuditFinding[];
}

export interface MemorySearchResult {
  project: string;
  file: string;
  path: string;
  type: MemoryType;
  line: number;
  match: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface ScanOptions {
  projectsBase?: string;
  typeFilter?: string;
  projectFilter?: string;
}

export interface AuditOptions {
  projectsBase?: string;
  ageThreshold?: number;
}

export interface SearchOptions {
  projectsBase?: string;
  typeFilter?: string;
  projectFilter?: string;
  context?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

/**
 * Parse YAML-like frontmatter between --- delimiters.
 * Extracts name, description, and type fields.
 * Returns body without frontmatter. If no frontmatter, all fields are null and body is original content.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const fm: Frontmatter = { name: null, description: null, type: null, body: content };

  // Must start with ---
  if (!content.startsWith("---")) {
    return fm;
  }

  // Find the closing ---
  const afterOpen = content.slice(3);
  const closeIdx = afterOpen.indexOf("\n---");
  if (closeIdx === -1) {
    return fm;
  }

  const yamlBlock = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx + 4); // skip \n---

  // Parse the YAML block line by line (simple key: value)
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "name") fm.name = value || null;
    else if (key === "description") fm.description = value || null;
    else if (key === "type") fm.type = value || null;
  }

  // Strip leading newline from body if present
  fm.body = body.startsWith("\n") ? body.slice(1) : body;

  return fm;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an encoded project directory name to a human-readable path.
 * Strips the leading dash and replaces remaining dashes with slashes.
 */
export function readableProjectName(encoded: string): string {
  const stripped = encoded.startsWith("-") ? encoded.slice(1) : encoded;
  return stripped.replace(/-/g, "/");
}

/**
 * Parse MEMORY.md in a memory directory.
 * Returns a set of linked filenames and ordered entry list.
 */
export function parseMemoryIndex(memoryDir: string): { linked: Set<string>; entries: string[] } {
  const indexPath = join(memoryDir, "MEMORY.md");
  const linked = new Set<string>();
  const entries: string[] = [];

  if (!existsSync(indexPath)) {
    return { linked, entries };
  }

  let content: string;
  try {
    content = readFileSync(indexPath, "utf-8");
  } catch {
    return { linked, entries };
  }

  // Match markdown links: [...](target.md)
  const linkPattern = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
  let match = linkPattern.exec(content);
  while (match !== null) {
    const target = match[2];
    linked.add(target);
    entries.push(target);
    match = linkPattern.exec(content);
  }

  return { linked, entries };
}

/**
 * Recursively collect all .md files in a directory, excluding MEMORY.md.
 */
export function collectMemoryFiles(memoryDir: string): string[] {
  const results: string[] = [];

  if (!existsSync(memoryDir)) return results;

  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name as string;
      const fullPath = join(dir, name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && name.endsWith(".md") && name !== "MEMORY.md") {
        results.push(fullPath);
      }
    }
  }

  walk(memoryDir);
  return results;
}

/**
 * Type guard: checks if a string is a valid MemoryType.
 */
export function isValidMemoryType(type: string | null): type is MemoryType {
  return type === "user" || type === "feedback" || type === "project" || type === "reference";
}

// ---------------------------------------------------------------------------
// scanMemories
// ---------------------------------------------------------------------------

/**
 * Scan projectsBase for all project dirs, find memory/ subdirs,
 * read each .md file (not MEMORY.md), parse frontmatter, check if indexed.
 * Supports type and project filtering.
 */
export function scanMemories(opts: ScanOptions = {}): ScanResult {
  const base = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;

  const result: ScanResult = {
    projectsScanned: 0,
    projectsWithMemories: 0,
    totalMemories: 0,
    byType: {},
    memories: [],
  };

  if (!existsSync(base)) return result;

  const now = Date.now();

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    // Project filter: check against both encoded name and readable name
    if (opts.projectFilter) {
      const filter = opts.projectFilter.toLowerCase();
      const readable = readableProjectName(entry.name).toLowerCase();
      if (!entry.name.toLowerCase().includes(filter) && !readable.includes(filter)) {
        continue;
      }
    }

    result.projectsScanned++;

    const memoryDir = join(base, entry.name, "memory");
    if (!existsSync(memoryDir)) continue;

    const { linked } = parseMemoryIndex(memoryDir);
    const files = collectMemoryFiles(memoryDir);

    if (files.length === 0) continue;

    result.projectsWithMemories++;

    for (const filePath of files) {
      const fileName = basename(filePath);

      let content: string;
      let sizeBytes: number;
      let mtimeMs: number;

      try {
        const stat = statSync(filePath);
        sizeBytes = stat.size;
        mtimeMs = stat.mtimeMs;
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const ageDays = Math.floor((now - mtimeMs) / (1000 * 60 * 60 * 24));
      const fm = parseFrontmatter(content);
      const hasFrontmatter = fm.name !== null || fm.description !== null || fm.type !== null;
      const memType: MemoryType = isValidMemoryType(fm.type) ? fm.type : "unknown";

      // Type filter
      if (opts.typeFilter && memType !== opts.typeFilter) {
        continue;
      }

      const indexed = linked.has(fileName);

      result.memories.push({
        project: entry.name,
        projectReadable: readableProjectName(entry.name),
        file: fileName,
        path: filePath,
        name: fm.name,
        type: memType,
        description: fm.description,
        ageDays,
        sizeBytes,
        hasFrontmatter,
        indexed,
      });

      result.totalMemories++;
      result.byType[memType] = (result.byType[memType] ?? 0) + 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// auditMemories helpers
// ---------------------------------------------------------------------------

function findExpiredDates(content: string): Date[] {
  const dates: Date[] = [];
  const isoPattern = /\b(\d{4}-\d{2}-\d{2})\b/g;
  for (const m of content.matchAll(isoPattern)) {
    const d = new Date(`${m[1]}T00:00:00`);
    if (!Number.isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

function extractAbsolutePaths(content: string): string[] {
  const paths: string[] = [];
  const pathPattern = /(\/(?:Users|home|tmp|var|etc|opt)\/[^\s"'`),;>\]]+)/g;
  for (const m of content.matchAll(pathPattern)) {
    const p = m[1].replace(/[.,:]+$/, "");
    paths.push(p);
  }
  return [...new Set(paths)];
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------
// auditMemories
// ---------------------------------------------------------------------------

/**
 * Run 8 health checks across all memories and return an AuditResult.
 */
export function auditMemories(opts: AuditOptions = {}): AuditResult {
  const base = opts.projectsBase ?? DEFAULT_PROJECTS_BASE;
  const ageThreshold = opts.ageThreshold ?? 60;
  const now = new Date();

  const findings: AuditFinding[] = [];

  // Collect all projects
  if (!existsSync(base)) {
    return {
      summary: { totalMemories: 0, healthy: 0, issuesFound: 0, bySeverity: { critical: 0, warning: 0, info: 0 } },
      findings: [],
    };
  }

  const projectDirs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name as string);

  // --- Check 1 & 2: Broken links and orphans (per project) ---
  // Build full memory inventory first for duplicate detection
  const allMemories: MemoryFile[] = scanMemories({ projectsBase: base }).memories;

  for (const project of projectDirs) {
    const memoryDir = join(base, project, "memory");
    if (!existsSync(memoryDir)) continue;

    const { linked, entries } = parseMemoryIndex(memoryDir);

    // Check 1: Broken links — MEMORY.md links to files that don't exist
    for (const linkedFile of entries) {
      const linkedPath = join(memoryDir, linkedFile);
      if (!existsSync(linkedPath)) {
        findings.push({
          severity: "warning",
          category: "broken_link",
          fixType: "auto",
          file: linkedFile,
          project,
          path: linkedPath,
          message: `MEMORY.md links to ${linkedFile} which does not exist`,
          suggestion: `Remove the broken link to ${linkedFile} from MEMORY.md`,
          autoFixable: true,
        });
      }
    }

    // Check 2: Orphan files — .md files not in MEMORY.md
    const allFiles = collectMemoryFiles(memoryDir);
    for (const filePath of allFiles) {
      const fileName = basename(filePath);
      if (!linked.has(fileName)) {
        let content = "";
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          // ignore
        }
        const fm = parseFrontmatter(content);
        const hasFm = fm.name !== null || fm.description !== null || fm.type !== null;
        const fixType: FixType = hasFm ? "auto" : "ai_assisted";
        const entry: AuditFinding = {
          severity: "warning",
          category: "orphan",
          fixType,
          file: fileName,
          project,
          path: filePath,
          message: `${fileName} exists in memory directory but is not indexed in MEMORY.md`,
          suggestion: `Add ${fileName} to MEMORY.md index`,
          autoFixable: hasFm,
        };
        if (!hasFm) {
          entry.aiAction = `Read ${fileName}, generate appropriate frontmatter, then add to MEMORY.md`;
        }
        findings.push(entry);
      }
    }
  }

  // --- Per-memory checks (checks 3-7) ---
  for (const mem of allMemories) {
    let content = "";
    try {
      content = readFileSync(mem.path, "utf-8");
    } catch {
      continue;
    }

    // Check 3: Missing frontmatter
    if (!mem.hasFrontmatter) {
      findings.push({
        severity: "warning",
        category: "missing_frontmatter",
        fixType: "ai_assisted",
        file: mem.file,
        project: mem.project,
        path: mem.path,
        message: `${mem.file} has no YAML frontmatter`,
        suggestion: "Add frontmatter with name, description, and type fields",
        autoFixable: false,
        aiAction: `Read ${mem.file} and generate appropriate frontmatter (name, description, type)`,
      });
    }

    // Check 4: Expired dates — project/reference/unknown files where ALL ISO dates are in the past
    if (mem.type === "project" || mem.type === "reference" || mem.type === "unknown") {
      const dates = findExpiredDates(content);
      if (dates.length > 0 && dates.every((d) => d < now)) {
        const oldest = dates.reduce((a, b) => (a < b ? a : b));
        findings.push({
          severity: "critical",
          category: "expired",
          fixType: "auto",
          file: mem.file,
          project: mem.project,
          path: mem.path,
          message: `${mem.file} contains dates that have all passed (oldest: ${oldest.toISOString().slice(0, 10)})`,
          suggestion: "Delete or update this memory — it references past dates",
          autoFixable: true,
        });
      }
    }

    // Check 5: Stale file paths — absolute paths that don't exist on disk
    const absPaths = extractAbsolutePaths(content);
    const missingPaths = absPaths.filter((p) => !existsSync(p));
    if (missingPaths.length > 0) {
      findings.push({
        severity: "info",
        category: "stale_path",
        fixType: "ai_assisted",
        file: mem.file,
        project: mem.project,
        path: mem.path,
        message: `${mem.file} references ${missingPaths.length} path(s) that do not exist: ${missingPaths.slice(0, 3).join(", ")}`,
        suggestion: "Update or remove references to missing paths",
        autoFixable: false,
        aiAction: `Verify and update the following paths in ${mem.file}: ${missingPaths.join(", ")}`,
      });
    }

    // Check 6: Age-based staleness — project/reference files older than or equal to ageThreshold
    if (mem.type === "project" || mem.type === "reference") {
      if (mem.ageDays >= ageThreshold) {
        findings.push({
          severity: "info",
          category: "stale",
          fixType: "ai_assisted",
          file: mem.file,
          project: mem.project,
          path: mem.path,
          message: `${mem.file} is ${mem.ageDays} days old (threshold: ${ageThreshold} days)`,
          suggestion: "Review and update or remove this memory",
          autoFixable: false,
          aiAction: `Review ${mem.file} for relevance and update or remove if outdated`,
        });
      }
    }

    // Check 7: Index mismatch — MEMORY.md description differs from frontmatter description
    if (mem.hasFrontmatter && mem.description !== null && mem.indexed) {
      const memoryDir = join(base, mem.project, "memory");
      const indexPath = join(memoryDir, "MEMORY.md");
      let indexContent = "";
      try {
        indexContent = readFileSync(indexPath, "utf-8");
      } catch {
        continue;
      }
      // Pattern: [anything](filename) — description
      const escapedFile = mem.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const descPattern = new RegExp(`\\[[^\\]]*\\]\\(${escapedFile}\\)\\s*—\\s*(.+)`, "m");
      const descMatch = descPattern.exec(indexContent);
      if (descMatch) {
        const indexDesc = descMatch[1].trim();
        if (indexDesc !== mem.description.trim()) {
          findings.push({
            severity: "info",
            category: "index_mismatch",
            fixType: "auto",
            file: mem.file,
            project: mem.project,
            path: mem.path,
            message: `MEMORY.md description for ${mem.file} differs from frontmatter: "${indexDesc}" vs "${mem.description}"`,
            suggestion: `Update MEMORY.md entry for ${mem.file} to match frontmatter description`,
            autoFixable: true,
          });
        }
      }
    }
  }

  // Check 8: Duplicate names — same name (case-insensitive) across different projects
  const nameToFiles = new Map<string, { file: string; project: string; path: string }[]>();
  for (const mem of allMemories) {
    if (mem.name === null) continue;
    const key = mem.name.toLowerCase();
    if (!nameToFiles.has(key)) nameToFiles.set(key, []);
    nameToFiles.get(key)!.push({ file: mem.file, project: mem.project, path: mem.path });
  }
  for (const [, group] of nameToFiles) {
    if (group.length < 2) continue;
    // Only flag if from different projects
    const projects = new Set(group.map((g) => g.project));
    if (projects.size < 2) continue;
    for (const entry of group) {
      findings.push({
        severity: "info",
        category: "duplicate",
        fixType: "ai_assisted",
        file: entry.file,
        project: entry.project,
        path: entry.path,
        message: `Duplicate memory name found across ${projects.size} projects: "${allMemories.find((m) => m.project === entry.project && m.file === entry.file)?.name}"`,
        suggestion: "Merge or differentiate these memories",
        autoFixable: false,
        aiAction: `Review duplicates and merge into a single memory or rename to disambiguate`,
      });
    }
  }

  // Sort by severity: critical first, then warning, then info
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // Summary
  const filesWithFindings = new Set(findings.map((f) => f.path));
  const totalMemories = allMemories.length;
  const healthy = totalMemories - filesWithFindings.size;
  const bySeverity: Record<FindingSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity]++;

  return {
    summary: {
      totalMemories,
      healthy: Math.max(0, healthy),
      issuesFound: findings.length,
      bySeverity,
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// searchMemories
// ---------------------------------------------------------------------------

/**
 * Search memory file contents using a case-insensitive regex query.
 */
export function searchMemories(query: string, opts: SearchOptions = {}): MemorySearchResult[] {
  const contextLines = opts.context ?? 0;
  const limit = opts.limit ?? 50;

  // Escape regex special characters to prevent ReDoS
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "i");

  const scanResult = scanMemories({
    projectsBase: opts.projectsBase,
    typeFilter: opts.typeFilter,
    projectFilter: opts.projectFilter,
  });

  const results: MemorySearchResult[] = [];

  outer: for (const mem of scanResult.memories) {
    let lines: string[];
    try {
      lines = readFileSync(mem.path, "utf-8").split("\n");
    } catch {
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      if (!pattern.test(lines[i])) continue;

      const ctxBefore: string[] = [];
      const ctxAfter: string[] = [];

      if (contextLines > 0) {
        for (let j = Math.max(0, i - contextLines); j < i; j++) {
          ctxBefore.push(truncate(lines[j], 100));
        }
        for (let j = i + 1; j < Math.min(lines.length, i + 1 + contextLines); j++) {
          ctxAfter.push(truncate(lines[j], 100));
        }
      }

      results.push({
        project: mem.project,
        file: mem.file,
        path: mem.path,
        type: mem.type,
        line: i + 1,
        match: truncate(lines[i], 200),
        contextBefore: ctxBefore,
        contextAfter: ctxAfter,
      });

      if (results.length >= limit) break outer;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = Bun.argv.slice(2);

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

  function exitWithError(err: unknown, code: number): never {
    process.stderr.write(`${JSON.stringify({ error: String(err), code })}\n`);
    process.exit(code);
  }

  const projectsBase = getFlag("--projects-base");
  const command = args.find((a) => !a.startsWith("-"));

  try {
    if (!command) {
      process.stderr.write("Usage: bun run lib/memory-scanner.ts <scan|audit|search> ...\n");
      process.exit(1);
    }

    if (command === "scan") {
      const typeFilter = getFlag("--type");
      const projectFilter = getFlag("--project");
      const format = getFlag("--format") ?? "json";
      const scanResult = scanMemories({ projectsBase, typeFilter, projectFilter });

      if (format === "table") {
        console.log(
          formatTable(
            scanResult.memories.map((m) => ({
              project: m.project,
              file: m.file,
              type: m.type,
              age_days: m.ageDays,
              indexed: m.indexed ? "yes" : "no",
            })),
            [
              { key: "project", header: "PROJECT" },
              { key: "file", header: "FILE" },
              { key: "type", header: "TYPE" },
              { key: "age_days", header: "AGE" },
              { key: "indexed", header: "INDEXED" },
            ],
          ),
        );
      } else {
        const out = {
          projects_scanned: scanResult.projectsScanned,
          projects_with_memories: scanResult.projectsWithMemories,
          total_memories: scanResult.totalMemories,
          by_type: scanResult.byType,
          memories: scanResult.memories.map((m) => ({
            project: m.project,
            project_readable: m.projectReadable,
            file: m.file,
            path: m.path,
            name: m.name,
            type: m.type,
            description: m.description,
            age_days: m.ageDays,
            size_bytes: m.sizeBytes,
            has_frontmatter: m.hasFrontmatter,
            indexed: m.indexed,
          })),
        };
        console.log(toJson(out));
      }
    } else if (command === "audit") {
      const ageThreshold = getFlagInt("--age-threshold", 60);
      const auditResult = auditMemories({ projectsBase, ageThreshold });

      const out = {
        summary: {
          total_memories: auditResult.summary.totalMemories,
          healthy: auditResult.summary.healthy,
          issues_found: auditResult.summary.issuesFound,
          by_severity: auditResult.summary.bySeverity,
        },
        findings: auditResult.findings.map((f) => ({
          severity: f.severity,
          category: f.category,
          fix_type: f.fixType,
          file: f.file,
          project: f.project,
          path: f.path,
          message: f.message,
          suggestion: f.suggestion,
          auto_fixable: f.autoFixable,
          ...(f.aiAction !== undefined ? { ai_action: f.aiAction } : {}),
        })),
      };
      console.log(toJson(out));
    } else if (command === "search") {
      const cmdIdx = args.indexOf("search");
      const query = args[cmdIdx + 1];
      if (!query || query.startsWith("-")) exitWithError("Missing search query", 2);

      const typeFilter = getFlag("--type");
      const projectFilter = getFlag("--project");
      const contextLines = getFlagInt("--context", 0);
      const limit = getFlagInt("--limit", 20);

      const results = searchMemories(query, {
        projectsBase,
        typeFilter,
        projectFilter,
        context: contextLines,
        limit,
      });

      const out = results.map((r) => ({
        project: r.project,
        file: r.file,
        path: r.path,
        type: r.type,
        line: r.line,
        match: r.match,
        context_before: r.contextBefore,
        context_after: r.contextAfter,
      }));

      console.log(out.length > 0 ? toNdjson(out) : toJson([]));
    } else {
      exitWithError(`Unknown command: ${command}`, 1);
    }
  } catch (err) {
    exitWithError(err, 3);
  }
}
