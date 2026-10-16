# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Search now also matches session titles (`customTitle` and `aiTitle`); title hits appear as rows with `match_type: "title"`
- Session `title` (custom title preferred, else auto title) in `list` and `search` output, `/api/sessions`, `/api/sessions/:id`, and `/api/search`
- Earlier titles stay searchable: every distinct custom/auto title in a session matches (custom preferred); the row shows the current `title` and the matched text in `match`
- `title` in `timeline` output and `/api/timeline`

### Changed

- Title rows count toward `--limit`/`limit`, so a search can return fewer message rows than before when titles also match
- Search lists title matches first (custom-title, then ai-title), then message matches; `--limit`/`limit` is applied after that ordering, so a title match is never hidden by message hits in earlier-scanned sessions (CLI, `/api/search`)

## [0.1.0] - 2026-04-13

### Added

- 11 skills for session intelligence: list, search, stats, detail, diff, timeline, resume, tasks, export, cleanup, delete
- Web dashboard with 5 views: Dashboard, Sessions, Search, Tasks, and Session Detail
- CLI tools for single-session parsing and cross-session operations
- Full-text search across all Claude Code sessions
- Task management with orphan detection and cleanup
- Session export to markdown and plain text formats
- OKLCH design token system with light and dark theme support
- Zero runtime dependencies (Bun built-in APIs only)
