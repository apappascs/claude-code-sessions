# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in claude-code-sessions, please report it responsibly by emailing **apappascs@gmail.com**. Do **not** open a public GitHub issue for security reports.

Include as much detail as possible: steps to reproduce, affected versions, and potential impact.

## What to Report

The following are examples of issues we consider security-relevant:

- Path traversal in static file serving or API routes
- Unintended data exposure from session files (e.g., leaking content outside the expected directories)
- Injection attacks via malformed JSONL parsing
- Cross-site scripting (XSS) in the web dashboard

## Response Timeline

- **Acknowledgment**: Within 48 hours of receiving your report.
- **Assessment**: A preliminary evaluation within 7 days, including severity determination and remediation plan.

## What to Expect

- You will receive credit in the changelog for your discovery, if you wish.
- We follow coordinated disclosure: fixes will be released before any public details are shared.
- We will work with you on an appropriate disclosure timeline.

## Security Design

claude-code-sessions is designed with a minimal attack surface:

- **Read-only access**: The plugin only reads from `~/.claude/projects/` and `~/.claude/tasks/`. It never writes to or modifies session data.
- **Local only**: The web dashboard runs on `localhost:3000` and is not exposed to external networks.
- **Zero runtime dependencies**: No third-party runtime packages that could introduce supply-chain risk.
- **Path traversal protection**: Static file serving and API routes validate paths to prevent directory traversal.
- **ID validation**: Session and task identifiers are validated before use in file operations.
