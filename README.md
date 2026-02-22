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
| **Regression Guard** | PreToolUse hook blocks changes that would reintroduce known bugs or violate pinned rules. |
| **Dependency Graph** | Import-based graph: "If you change X, Y and Z are affected." |
| **Hot Zones** | Which files get changed most? Where do bugs originate? Identifies refactoring candidates. |
| **Health Score** | Daily snapshot: error frequency, open TODOs, convention compliance. Trend over time. |
| **Unfinished Business** | Tracks abandoned tasks, reminds you on next session start. |
| **Pin Rules** | `/pin` writes a rule to DB + hookify-compatible `.claude/cortex-pins.local.md`. PreToolUse blocks violations instantly. |
| **Intent Prediction** | PatternAgent analyzes work patterns (file clusters, task sequences) and predicts what you'll work on next session. Shown at session start. |
| **Auto-Conventions** | Learner agent automatically extracts coding conventions from sessions and populates the conventions table. |
| **Skill Self-Improvement** | SkillAdvisor agent autonomously improves `skills/*/SKILL.md` files after each session. |
| **Agent Monitoring** | Every agent run is logged to DB. `cortex_agent_status` + `cortex_session_metrics` for observability. |
| **Daemon Resilience** | External watcher process auto-restarts daemon on crash via heartbeat file. |

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
```

No build step needed — `server/dist/` and `daemon/dist/` are pre-built and included in the repo.

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
| `on-user-prompt-submit.js` | Every user message | Context window size early-warning (thresholds: 0.75/0.92/1.03 MB) |
| `on-pre-tool-use.js` | Before Write/Edit | Pattern enforcer: checks against anti-patterns and regression rules. Can block. |
| `on-post-tool-use.js` | After Read/Write/Edit | Tracks changes, saves diffs, scans imports, queues `file_access` events for daemon |
| `on-pre-compact.js` | Before context compaction | Saves interim session data |
| `on-session-end.js` | Session end | Summarizes session, health snapshot, queues `session_end` event for Learner agent |

### Daemon (Autonomous Layer)

The daemon is a persistent Node.js process that starts automatically on session start (via PID file check) and runs in the background. It polls an event queue (`.claude/cortex-events.jsonl`) every 500ms and dispatches work to autonomous agents. A separate watcher process monitors the daemon via heartbeat file and auto-restarts it on crash.

```
SessionStart hook
  └─ starts: node daemon/dist/index.js --project <cwd>
               ├─ on startup: Architect Agent
               └─ every 500ms poll:
                    file_access event → Context Agent
                    session_end event → Learner Agent
                                     → Drift Detector Agent
                                     → Synthesizer Agent
                                     → Serendipity Agent
                                     → MoodScorer Agent
                                     → SkillAdvisor Agent
                                     → PatternAgent (file clusters + intent prediction)
                                     → Architect Agent (post-session, if >5 files changed)
```

Each agent runs as a separate `claude -p` subprocess (same Claude Code subscription, no extra API costs). All agents receive a structured context block (recent diffs, hot zones, session delta) via `buildAgentContext()` before their main prompt.

#### Architect Agent

Runs on daemon start and after sessions with >5 changed files. Reads all known files from the DB (up to 200), asks Claude to map the full-stack architecture (Frontend → Hook → Service → Backend Route → DB table), and saves the result as decisions in the DB.

#### Context Agent

Triggers on every `Read` event (with 60s debounce per file). Queries the DB for known info about the file (type, imports, who imports it, related decisions) and generates a compact 3–4 line summary. The summary is:
- Written to `.claude/cortex-feedback.jsonl`
- Injected into Claude's context via the PostToolUse hook response
- Saved as the file's description in the DB (if empty)

#### Learner Agent

Triggers on `session_end`. Reads files changed in the last 2 hours and the last 8000 characters of the session transcript. Uses Sonnet as the analysis model. Classifies every finding by relevance:

- **noise** — skipped, not written to DB
- **maybe_relevant** — saved as low-confidence learning
- **important** — saved with full context
- **critical** — saved with `auto_block: true` (blocks future regressions)

Extracts: **learnings** (anti-patterns), **errors**, **facts** (stable project truths), **insights** (broader observations), **conventions** (recurring code patterns), and **architecture updates**. Every write includes a mandatory `write_gate_reason`. Superseded entries are linked via `superseded_by`.

#### Drift Detector Agent

Triggers on `session_end` (max once per 22 hours). Compares recently modified files against stored architectural decisions and flags potential drift as `[DRIFT]` unfinished items.

#### Synthesizer Agent

Triggers every 10 sessions. Reads accumulated learnings, errors and facts, identifies duplicates and contradictions, and synthesizes a consolidated memory — removing noise and promoting what matters.

#### Serendipity Agent

Triggers on `session_end`. Randomly surfaces old learnings or decisions that may be relevant to current work — creating unexpected connections across sessions.

#### MoodScorer Agent

Triggers on `session_end`. Classifies the session's emotional tone (productive, stuck, exploratory, etc.) and writes a rolling mood score used by `cortex_get_mood`.

#### PatternAgent

Triggers on `session_end`. Builds a persistent model of your work patterns:

- **File Clusters:** Identifies files that are frequently edited together using Jaccard similarity. Stored in `work_patterns` table with confidence scores and exponential decay.
- **Intent Prediction:** Analyzes branch name, recent sessions, unfinished items, work patterns, and time of day to predict what you'll work on next. Uses Haiku by default, falls back to Sonnet after >3 days of inactivity or branch changes. The prediction is stored in `meta` and displayed at next session start.

#### SkillAdvisor Agent

Triggers on `session_end`. Analyzes the transcript and recent diffs, identifies skills that were incomplete or patterns recurring enough to warrant a new skill, and directly edits `skills/*/SKILL.md` files. Changes land uncommitted — visible via `git diff skills/`.

### MCP Server

A TypeScript MCP server exposes 55+ tools for querying and updating the Cortex database. Used by Claude during active sessions.

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
│   ├── on-user-prompt-submit.js # Context window size early-warning
│   ├── on-session-end.js       # Session summary + session_end event
│   ├── on-pre-tool-use.js      # Pattern enforcer (can block)
│   ├── on-post-tool-use.js     # File tracking + file_access events
│   └── on-pre-compact.js       # Interim save before compaction
│
├── daemon/                     # Autonomous background process (TypeScript)
│   ├── src/
│   │   ├── index.ts            # Entry point: PID mgmt, queue polling
│   │   ├── runner.ts           # claude -p runner + buildAgentContext()
│   │   ├── queue.ts            # JSONL event queue reader/writer
│   │   ├── watcher.ts          # External heartbeat watcher (auto-restart)
│   │   └── agents/
│   │       ├── architect.ts    # Full-stack architecture mapper
│   │       ├── context.ts      # File-access explainer (debounced)
│   │       ├── learner.ts      # Session transcript analyzer (Sonnet)
│   │       ├── drift-detector.ts # Architecture drift detection
│   │       ├── synthesizerAgent.ts # Memory consolidation (every 10 sessions)
│   │       ├── serendipityAgent.ts # Surfaces old learnings randomly
│   │       ├── moodScorer.ts   # Session mood classification
│   │       ├── skillAdvisor.ts # Autonomous skill improvement (Haiku)
│   │       └── patternAgent.ts # File clusters + intent prediction
│   └── dist/                   # Pre-built, ready to run
│
├── server/                     # MCP Server (TypeScript)
│   └── src/
│       ├── index.ts            # 55 MCP tools
│       ├── db.ts               # SQLite schema + connection
│       └── modules/            # sessions, decisions, errors, learnings,
│                               # conventions, dependencies, diffs, health,
│                               # project-map, unfinished
│
├── skills/                     # Slash commands for Claude Code
│   ├── resume/                 # Re-entry brief
│   ├── cortex-search/          # FTS5 search
│   ├── cortex-health/          # Master dashboard
│   ├── cortex-file/            # File history + impact
│   ├── cortex-review/          # Code review
│   ├── cortex-decisions/       # Decision log
│   ├── cortex-errors/          # Error list
│   ├── pin/                    # Pin rules (DB + hookify)
│   ├── note/                   # Scratch-pad notes
│   ├── snooze/                 # Session reminders
│   └── timeline/               # Activity overview
│
└── hooks/
    └── hooks.json              # Hook configuration template
```

---

## MCP Tools

55+ tools available when the MCP server is running:

**Memory & Context**
| Tool | Description |
|---|---|
| `cortex_snapshot` | Full brain state: open items, recent sessions, decisions, learnings. Now includes intent prediction. |
| `cortex_get_context` | Relevant context for specific files |
| `cortex_save_session` | Save/update a session |
| `cortex_list_sessions` | List recent sessions |
| `cortex_search` | FTS5/BM25 full-text search across all data |
| `cortex_cross_project_search` | Search across all projects in this Cortex DB |

**Decisions**
| Tool | Description |
|---|---|
| `cortex_add_decision` | Log an architectural decision with reasoning + examples |
| `cortex_list_decisions` | List decisions by category |
| `cortex_mark_decision_reviewed` | Confirm a decision is still current |

**Errors & Learnings**
| Tool | Description |
|---|---|
| `cortex_add_error` | Record an error with root cause, fix, prevention rule |
| `cortex_update_error` | Update an existing error record |
| `cortex_list_errors` | List known errors |
| `cortex_add_learning` | Record an anti-pattern with optional auto-blocking regex |
| `cortex_update_learning` | Update an existing learning |
| `cortex_delete_learning` | Delete a learning by ID |
| `cortex_list_learnings` | List anti-patterns sorted by occurrence |
| `cortex_check_regression` | Check content against known regressions before editing |

**Project Map & Files**
| Tool | Description |
|---|---|
| `cortex_scan_project` | Scan project files into DB |
| `cortex_update_map` | Re-scan project and update architecture map |
| `cortex_get_map` | Project architecture map |
| `cortex_get_deps` | Dependency tree + impact analysis for a file |
| `cortex_get_file_history` | Complete history for a file |
| `cortex_blame` | Full history with diffs, errors, decisions for a file |
| `cortex_get_hot_zones` | Most frequently changed files |
| `cortex_import_git_history` | Import git log to populate hot zones |
| `cortex_index_docs` | Index CLAUDE.md gotchas and docs/ sections |

**Tracking & TODOs**
| Tool | Description |
|---|---|
| `cortex_add_unfinished` | Track something for later |
| `cortex_get_unfinished` | Open/unresolved items |
| `cortex_resolve_unfinished` | Mark an unfinished item as resolved |
| `cortex_add_intent` | Store what you plan to do next session |
| `cortex_snooze` | Set a reminder for a future session |

**Conventions & Health**
| Tool | Description |
|---|---|
| `cortex_add_convention` | Add a convention with detection patterns |
| `cortex_get_conventions` | Active conventions with violation counts |
| `cortex_suggest_claude_md` | Suggest CLAUDE.md updates from learnings |
| `cortex_get_health` | Project health score with trend |
| `cortex_get_stats` | DB statistics (counts per table) |
| `cortex_get_access_stats` | Top accessed decisions, learnings, errors |
| `cortex_run_pruning` | Manually run Ebbinghaus-based pruning |

**Notes & Profile**
| Tool | Description |
|---|---|
| `cortex_add_note` | Add a scratch pad note |
| `cortex_list_notes` | List notes, optionally filtered |
| `cortex_delete_note` | Delete a note by ID |
| `cortex_onboard` | First-time setup: profile + anchors |
| `cortex_update_profile` | Update user profile |
| `cortex_get_profile` | Get user profile |
| `cortex_add_anchor` | Pin a topic as permanent high-priority context |
| `cortex_remove_anchor` | Remove an attention anchor |
| `cortex_list_anchors` | List all anchors |

**Intelligence**
| Tool | Description |
|---|---|
| `cortex_dejavu` | Detect if task is similar to past sessions |
| `cortex_check_blind_spots` | Find files not touched in recent sessions |
| `cortex_get_mood` | Rolling session mood from last 7 sessions |
| `cortex_forget` | Archive decisions/learnings/errors by topic |
| `cortex_get_timeline` | Monthly activity timeline |
| `cortex_compare_periods` | Compare activity between two date ranges |
| `cortex_export` | Export all brain data as JSON or Markdown |
| `cortex_set_project` | Set active project name for context tagging |

**Monitoring**
| Tool | Description |
|---|---|
| `cortex_session_metrics` | OTEL-based metrics for the last N sessions |
| `cortex_agent_status` | Health and run history for all daemon agents |

## Slash Commands

| Command | Description |
|---|---|
| `/resume` | Re-entry brief: last session, open items, changed files |
| `/cortex-search <query>` | FTS5/BM25 search across all Cortex data |
| `/cortex-health` | Master dashboard: health, decisions, errors, conventions |
| `/cortex-file <file>` | File history, dependencies, impact analysis |
| `/cortex-review` | Intelligent code review with auto model selection |
| `/pin <rule>` | Pin a rule as auto-blocking learning + hookify file |
| `/note <text>` | Quick scratch-pad note |
| `/snooze <text> <time>` | Set a reminder for a future session |
| `/timeline` | Monthly activity overview |

---

## Database

SQLite at `.claude/cortex.db` — one file per project, created automatically on first hook run.

18 tables: `sessions`, `decisions`, `errors`, `learnings`, `facts`, `insights`, `project_modules`, `project_files`, `dependencies`, `diffs`, `conventions`, `unfinished`, `health_snapshots`, `notes`, `work_patterns`, `schema_version`, `session_metrics`, `agent_runs`.

Uses `node:sqlite` (Node.js built-in, available since Node 22). Zero native dependencies, no compilation.

---

## Session Start Output

```
-- Project Cortex | Health: 82/100 (+) --
Branch: main

PREDICTED TASK: Fix team voting regression (85% confident)
  -> Suggested: Run migration 058 tests first
  -> Files: backend/routes/teams.py, migrations/058_fix_votes.sql
  -> Relevant: Decision #3, Error #7

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
