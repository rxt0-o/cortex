# Cortex

**Persistent memory and autonomous intelligence for Claude Code.**

Cortex gives Claude Code a long-term brain. It tracks every session, remembers every decision, learns from mistakes, and runs autonomous background agents that map your architecture, explain files you open, and extract patterns from your work — all without any manual input.

## Features

| Capability | How |
|---|---|
| **Session Memory** | Every session is automatically summarized and stored with decisions, changes, and learnings. |
| **Context Injection** | Session start: relevant context from past sessions, unfinished items, known errors in changed files. |
| **Autonomous Daemon** | Background process spawns `claude -p` agents to analyze architecture, explain files, and self-improve. |
| **Error Memory** | Remembers every error + fix. Same error again? Instant answer instead of re-debugging. |
| **Regression Guard** | PreToolUse hook blocks changes that would reintroduce known bugs. |
| **Dependency Graph** | Import-based graph: "If you change X, Y and Z are affected." |
| **Hot Zones** | Which files get changed most? Where do bugs originate? Identifies refactoring candidates. |
| **Health Score** | Daily snapshot: error frequency, open TODOs, convention compliance. Trend over time. |
| **Unfinished Business** | Tracks abandoned tasks, reminds you on next session start. |

## Requirements

- **Node.js >= 22** (uses built-in `node:sqlite`)
- **Claude Code CLI** (`claude` command available in PATH)

## Installation

```bash
/plugin marketplace add rxt0-o/cortex
/plugin install cortex@rxt0-o
```

That's it. Cortex automatically registers hooks, the MCP server, and all skills.

**Requirements:** Node.js >= 22, Claude Code CLI

### Manual Installation (alternative)

If you prefer to set up Cortex manually:

```bash
git clone https://github.com/rxt0-o/cortex.git
No build step needed — server/dist/ and daemon/dist/ are pre-built and included in the repo.
```

Add to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-session-start.js", "timeout": 15 }] }],
    "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-pre-tool-use.js", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "Read|Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-post-tool-use.js", "timeout": 10 }] }],
    "PreCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-pre-compact.js", "timeout": 15 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-session-end.js", "timeout": 30 }] }]
  }
}
```

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/server/dist/index.js"]
    }
  }
}
```

---

## How It Works

### Hooks (Synchronous Layer)

Six plain Node.js scripts run as Claude Code hooks. Zero npm dependencies — they only use `node:sqlite` and the Node.js standard library.

| Hook | Trigger | What it does |
|---|---|---|
| `on-session-start.js` | Every session start | Creates DB, injects context, **starts the daemon** |
| `on-pre-tool-use.js` | Before Write/Edit | Pattern enforcer: checks against anti-patterns and regression rules. Can block. |
| `on-post-tool-use.js` | After Read/Write/Edit | Tracks changes, saves diffs, scans imports, queues `file_access` events for daemon |
| `on-pre-compact.js` | Before context compaction | Saves interim session data |
| `on-session-end.js` | Session end | Summarizes session, health snapshot, queues `session_end` event for Learner agent |

### Daemon (Autonomous Layer)

The daemon is a persistent Node.js process that starts automatically on session start (via PID file check) and runs in the background. It polls an event queue (`.claude/cortex-events.jsonl`) every 500ms and dispatches work to three autonomous agents.

```
SessionStart hook
  └─ starts: node daemon/dist/index.js --project <cwd>
               ├─ on startup: Architect Agent
               └─ every 500ms poll:
                    file_access event → Context Agent
                    session_end event → Learner Agent
```

Each agent runs as a separate `claude -p` subprocess (same Claude Code subscription, no extra API costs).

#### Architect Agent

Runs once on daemon start. Reads all known files from the DB (up to 200), asks Claude to map the full-stack architecture (Frontend → Hook → Service → Backend Route → DB table), and saves the result as decisions in the DB.

#### Context Agent

Triggers on every `Read` event (with 60s debounce per file). Queries the DB for known info about the file (type, imports, who imports it, related decisions) and generates a compact 3–4 line summary. The summary is:
- Written to `.claude/cortex-feedback.jsonl`
- Injected into Claude's context via the PostToolUse hook response
- Saved as the file's description in the DB (if empty)

#### Learner Agent

Triggers on `session_end`. Reads files changed in the last 2 hours and the last 8000 characters of the session transcript. Asks Claude to extract:
- **Anti-patterns**: what went wrong and the correct solution
- **Errors**: root cause, fix, prevention rule
- **Architecture updates**: new understanding of file roles

All findings are saved to the DB and used in future sessions.

### MCP Server

A TypeScript MCP server exposes 22 tools for querying and updating the Cortex database. Used by Claude during active sessions.

### Event Queue

Communication between hooks and the daemon uses a simple append-only JSONL file (`.claude/cortex-events.jsonl`). Hooks append events; the daemon reads, processes, and marks them as processed.

```jsonl
{"type":"file_access","file":"/path/to/file.ts","session_id":"abc","ts":"2026-02-21T..."}
{"type":"session_end","session_id":"abc","transcript_path":"/path/to/transcript.jsonl","ts":"..."}
```

---

## Architecture

```
cortex/
├── scripts/                    # Hook scripts (plain JS, zero npm deps)
│   ├── ensure-db.js            # DB init + schema migration
│   ├── on-session-start.js     # Context injection + daemon auto-start
│   ├── on-session-end.js       # Session summary + session_end event
│   ├── on-pre-tool-use.js      # Pattern enforcer (can block)
│   ├── on-post-tool-use.js     # File tracking + file_access events
│   └── on-pre-compact.js       # Interim save before compaction
│
├── daemon/                     # Autonomous background process (TypeScript)
│   ├── src/
│   │   ├── index.ts            # Entry point: PID mgmt, queue polling
│   │   ├── runner.ts           # claude -p subprocess runner (serial queue)
│   │   ├── queue.ts            # JSONL event queue reader/writer
│   │   └── agents/
│   │       ├── architect.ts    # Full-stack architecture mapper
│   │       ├── context.ts      # File-access explainer (debounced)
│   │       └── learner.ts      # Session transcript analyzer
│   └── dist/                   # Pre-built, ready to run
│
├── server/                     # MCP Server (TypeScript)
│   └── src/
│       ├── index.ts            # 22 MCP tools
│       ├── db.ts               # SQLite schema + connection
│       └── modules/            # sessions, decisions, errors, learnings,
│                               # conventions, dependencies, diffs, health,
│                               # project-map, unfinished
│
├── skills/                     # Slash commands for Claude Code
│   ├── cortex-search/
│   ├── cortex-map/
│   ├── cortex-deps/
│   ├── cortex-history/
│   ├── cortex-decisions/
│   ├── cortex-errors/
│   ├── cortex-health/
│   ├── cortex-unfinished/
│   └── cortex-conventions/
│
└── hooks/
    └── hooks.json              # Hook configuration template
```

---

## MCP Tools

22 tools available when the MCP server is running:

| Tool | Description |
|---|---|
| `cortex_search` | Full-text search across sessions, decisions, errors, learnings |
| `cortex_get_context` | Relevant context for specific files |
| `cortex_save_session` | Save/update a session |
| `cortex_list_sessions` | List recent sessions |
| `cortex_add_decision` | Log an architectural decision |
| `cortex_list_decisions` | List decisions by category |
| `cortex_add_error` | Record an error with root cause, fix, prevention rule |
| `cortex_list_errors` | List known errors |
| `cortex_add_learning` | Record an anti-pattern with optional auto-blocking regex |
| `cortex_get_deps` | Dependency tree + impact analysis for a file |
| `cortex_get_map` | Project architecture map |
| `cortex_scan_project` | Scan project files into DB (auto-called by `cortex_update_map`) |
| `cortex_update_map` | Re-scan project and update architecture map |
| `cortex_index_docs` | Index CLAUDE.md gotchas and docs/ sections |
| `cortex_get_hot_zones` | Most frequently changed files |
| `cortex_get_file_history` | Complete history for a file |
| `cortex_get_health` | Project health score with trend |
| `cortex_get_unfinished` | Open/unresolved items |
| `cortex_add_unfinished` | Track something for later |
| `cortex_resolve_unfinished` | Mark an unfinished item as resolved |
| `cortex_get_conventions` | Active conventions with violation counts |
| `cortex_add_convention` | Add a convention with detection patterns |
| `cortex_check_regression` | Check content against known regressions |
| `cortex_suggest_claude_md` | Suggest CLAUDE.md updates from learnings |
| `cortex_list_learnings` | List anti-patterns sorted by occurrence |
| `cortex_get_stats` | DB statistics (counts per table) |

## Slash Commands

Install the `skills/` directory as a Claude Code plugin or copy individual skill files.

| Command | Description |
|---|---|
| `/cortex-search <query>` | Search everything |
| `/cortex-map [module]` | Project architecture |
| `/cortex-deps <file>` | Impact analysis |
| `/cortex-history <file>` | File timeline |
| `/cortex-decisions` | Decision log |
| `/cortex-errors` | Known errors |
| `/cortex-health` | Health score |
| `/cortex-unfinished` | Open items |
| `/cortex-conventions` | Convention overview |

---

## Database

SQLite at `.claude/cortex.db` — one file per project, created automatically on first hook run.

12 tables: `sessions`, `decisions`, `errors`, `learnings`, `project_modules`, `project_files`, `dependencies`, `diffs`, `conventions`, `unfinished`, `health_snapshots`, `schema_version`.

Uses `node:sqlite` (Node.js built-in, available since Node 22). Zero native dependencies, no compilation.

---

## Session Start Output

```
-- Project Cortex | Health: 82/100 (+) --
Branch: main

RECENT SESSIONS:
  [2h ago] Fixed team voting bug, created migration 058
  [1d ago] Implemented bookmark feature with React Query

UNFINISHED:
  - [high] Push migration 058 to production
  - [medium] Add tests for bookmark service

ERRORS IN CHANGED FILES:
  ! sitemap.py: Directus 403 on date_updated filter

ACTIVE PATTERNS (auto-block):
  X == for API keys -> secrets.compare_digest
  X auth.uid() without (select ...) wrapper in RLS

/cortex-search, /cortex-map, /cortex-deps for details
---
```

---

## Windows Notes

The daemon automatically finds `claude.cmd` in `%APPDATA%\npm\`. The `CLAUDECODE` environment variable is unset before spawning subprocesses to avoid the "nested session" restriction.

---

## License

MIT
