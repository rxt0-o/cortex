# Project Cortex

**Intelligent project memory for Claude Code — remembers, learns, and protects.**

Cortex gives Claude Code a persistent brain. It automatically tracks every session, remembers every decision, learns from every mistake, and actively prevents you from repeating known bugs. Zero configuration, zero effort — it just runs.

## What It Does

| Capability | How |
|---|---|
| **Session Memory** | Every session is automatically summarized and stored. Decisions, changes, and learnings are extracted. |
| **Context Injection** | On session start: relevant context from past sessions, prioritized by what you're working on right now. |
| **Error Memory** | Remembers every error + fix. Same error again? Instant answer instead of re-debugging. |
| **Regression Guard** | Blocks changes that would reintroduce known bugs. "This was the fix for Bug #X — are you sure?" |
| **Pattern Enforcer** | PreToolUse hook checks Write/Edit against known anti-patterns. `==` instead of `secrets.compare_digest`? Blocked. |
| **Convention Drift** | Detects when new code deviates from established patterns and warns you. |
| **Dependency Graph** | Import-based graph: "If you change X, Y and Z are affected." |
| **Hot Zones** | Which files get changed the most? Where do most bugs originate? Identifies refactoring candidates. |
| **Health Score** | Daily snapshot: error frequency, open TODOs, convention compliance. Trend over time. |
| **Unfinished Business** | Tracks "do it later", "TODO", abandoned tasks. Reminds you on next session start. |

## Requirements

- **Node.js >= 22** (uses built-in `node:sqlite`)
- **Claude Code CLI**

## Installation

```bash
# Clone
git clone https://github.com/rxt0-o/cortex.git
cd cortex

# Build MCP Server
cd server
npm install
npm run build
cd ..
```

### Activate Hooks

Add to your project's `.claude/settings.local.json` (or `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node path/to/cortex/scripts/on-session-start.js",
            "timeout": 15
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node path/to/cortex/scripts/on-pre-tool-use.js",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node path/to/cortex/scripts/on-post-tool-use.js",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node path/to/cortex/scripts/on-pre-compact.js",
            "timeout": 15
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node path/to/cortex/scripts/on-session-end.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Replace `path/to/cortex` with the actual path to your cloned repo.

### Register MCP Server (optional)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["path/to/cortex/server/dist/index.js"]
    }
  }
}
```

## Architecture

```
cortex/
├── scripts/                  # Hook scripts (plain JS, zero dependencies)
│   ├── ensure-db.js          # Shared DB init (creates schema on first run)
│   ├── on-session-start.js   # Context injection at session start
│   ├── on-session-end.js     # Session summary + health snapshot
│   ├── on-pre-tool-use.js    # Pattern enforcer + regression guard
│   ├── on-post-tool-use.js   # File tracking, diffs, import scanning
│   └── on-pre-compact.js     # Save interim data before context compaction
│
├── server/                   # MCP Server (TypeScript)
│   └── src/
│       ├── index.ts          # 20 MCP tools
│       ├── db.ts             # SQLite schema + connection
│       ├── modules/          # sessions, decisions, errors, learnings,
│       │                     # conventions, dependencies, diffs, health,
│       │                     # project-map, unfinished
│       ├── analyzer/         # transcript-parser, diff-extractor,
│       │                     # relevance-scorer
│       └── utils/            # git integration, summarization
│
├── skills/                   # 9 slash commands for Claude Code
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
    └── hooks.json            # Hook configuration template
```

## Hooks

| Hook | Trigger | What it does |
|---|---|---|
| **SessionStart** | Every session start | Creates DB if needed, loads relevant context (recent sessions, unfinished items, errors in changed files, active learnings, health score), injects it into the session |
| **PreToolUse** | Before Write/Edit | Checks content against learned anti-patterns (`auto_block`), error prevention rules, and convention violations. **Can block** dangerous changes. |
| **PostToolUse** | After Write/Edit | Tracks file changes (hot zones), saves diffs, scans imports for dependency graph, infers file types. Runs async. |
| **PreCompact** | Before context compaction | Saves interim session data so nothing is lost during compaction |
| **Stop** | Session end | Summarizes the session, saves to DB, tracks files, creates health snapshot |

## MCP Tools

20 tools available when the MCP server is running:

| Tool | Description |
|---|---|
| `cortex_search` | Full-text search across sessions, decisions, errors, learnings |
| `cortex_get_context` | Get relevant context for specific files |
| `cortex_save_session` | Save/update a session |
| `cortex_list_sessions` | List recent sessions |
| `cortex_add_decision` | Log an architectural decision with reasoning |
| `cortex_list_decisions` | List decisions by category |
| `cortex_add_error` | Record an error with root cause, fix, and prevention rule |
| `cortex_list_errors` | List known errors |
| `cortex_add_learning` | Record an anti-pattern with auto-blocking regex |
| `cortex_get_deps` | Dependency tree + impact analysis for a file |
| `cortex_get_map` | Project architecture map |
| `cortex_update_map` | Re-scan project structure |
| `cortex_get_hot_zones` | Most frequently changed files |
| `cortex_get_file_history` | Complete history for a file (diffs, errors, decisions) |
| `cortex_get_health` | Project health score with trend |
| `cortex_get_unfinished` | Open/unresolved items |
| `cortex_add_unfinished` | Track something for later |
| `cortex_get_conventions` | Active conventions with violation counts |
| `cortex_add_convention` | Add a convention with detection/violation patterns |
| `cortex_check_regression` | Check content against known regressions |
| `cortex_suggest_claude_md` | Suggest CLAUDE.md updates from learnings |

## Slash Commands

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

## Database

SQLite database at `.claude/cortex.db` (per project, auto-created on first hook run).

12 tables: `sessions`, `decisions`, `errors`, `learnings`, `project_modules`, `project_files`, `dependencies`, `diffs`, `conventions`, `unfinished`, `health_snapshots`, `schema_version`.

Uses `node:sqlite` (Node.js built-in SQLite, available since Node 22). Zero native dependencies.

## How Context Injection Works

On every session start, Cortex builds a prioritized context block:

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

Only relevant context is shown. Files you're currently working on get priority.

## License

MIT
