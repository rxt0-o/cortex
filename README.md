# Cortex

**Persistent memory for Claude Code.**

Cortex gives Claude Code a long-term brain. It tracks sessions, remembers decisions, learns from mistakes, and automatically extracts patterns from your work — all without manual input. No daemon, no background processes — just hooks + MCP server.

## Features

### 3-Layer Memory

| Layer | What | How |
|---|---|---|
| **Sensory** | Auto-Extraction | Pattern recognition on session transcripts surfaces learnings, errors, conventions automatically |
| **Short-term** | Working Memory | Per-session buffer (`working_memory`). Auto-pruned at session end via consolidation |
| **Long-term** | Persistent Memory | Decisions, errors, learnings with Ebbinghaus decay + importance scoring. Spreading activation retrieves associated memories |

### Memory Lifecycle

| Feature | How |
|---|---|
| **Ebbinghaus Decay** | `memory_strength` decays over time. Items < 0.1 excluded from context. Frequent access slows decay (spaced repetition) |
| **Importance Scoring** | 5 dimensions: Frequency, Recency, Impact, Surprise, Sentiment |
| **Associations** | 5 types: same-session, same-file, temporal, causal, semantic. Graph-based context stitching |
| **Auto-Extractions** | Regex patterns extract errors/decisions/learnings from transcripts at session end |
| **Deduplication** | Embedding similarity (threshold 0.92) prevents duplicate entries |

### Intelligence

| Feature | How |
|---|---|
| **Error Memory** | Remembers every error + fix. Same error? Instant answer |
| **Regression Guard** | PreToolUse hook blocks changes that reintroduce known bugs |
| **Semantic Search** | Hybrid BM25 + semantic vector search (`all-MiniLM-L6-v2`) with sqlite-vec (auto) + JS fallback |
| **Dependency Graph** | Import-based: "Change X → Y and Z affected" |
| **Hot Zones** | Most-changed files, bug origins, refactoring candidates |
| **Health Score** | Error frequency, open TODOs, convention compliance. Trend over time |
| **Pin Rules** | `/pin` writes auto-blocking rules. PreToolUse enforces instantly |

## Requirements

- **Node.js >= 22** (uses built-in `node:sqlite`)
- **MCP client** (Claude Code and/or [Codex CLI](https://github.com/openai/codex))
- **Optional:** `GEMINI_API_KEY` for AI summaries
- **Optional (Windows):** sqlite-vec runtime for native KNN (`sqlite-vec` npm package is auto-installed by `mcp:install*`)

## Installation

### Global (recommended — works in every project)

```bash
git clone https://github.com/rxt0-o/cortex.git
cd cortex
npm run mcp:install:global
```

What this does:
- builds `server/dist/bundle.js`
- **Claude Code**: registers cortex as user-scope MCP server (`claude mcp add --scope user`) + merges hooks into `~/.claude/settings.json`
- **Codex CLI**: registers cortex via `codex mcp add` (saved in `~/.codex/config.toml`)
- **Windows:** tries to auto-install `sqlite-vec` runtime (`server/node_modules/sqlite-vec`) for native vector search

After install, **restart your client**. Cortex is now available in every project. The DB is created per-project at `.claude/cortex.db`.
If sqlite-vec is unavailable, Cortex automatically falls back to JS cosine search.

> **Note:** Hooks (Regression Guard, Auto-Extraction, Context Injection at session start) are Claude Code only. Codex CLI gets the full 16 MCP tools but no hook automation.

To uninstall: `npm run mcp:uninstall:global`

### Project-local (single project only)

```bash
git clone https://github.com/rxt0-o/cortex.git
cd cortex
npm run mcp:install
```

What this does:
- builds `server/dist/bundle.js`
- writes `.mcp.json` in the cortex repo (only works when opened in this directory)
- tries `codex mcp add` if Codex CLI is installed
- **Windows:** tries to auto-install `sqlite-vec` runtime (`server/node_modules/sqlite-vec`) for native vector search

### Optional: AI summaries

```bash
# Windows (PowerShell)
$env:GEMINI_API_KEY="YOUR_KEY"

# macOS/Linux
export GEMINI_API_KEY="YOUR_KEY"
```

### Optional: sqlite-vec overrides

```bash
# disable sqlite-vec and force JS fallback
CORTEX_VEC_DISABLE=1

# pin sqlite-vec npm version used by installer (Windows)
CORTEX_SQLITE_VEC_VERSION=0.1.7-alpha.2

# explicit DLL path (fallback if npm runtime is unavailable)
CORTEX_VEC_DLL_PATH=C:\tools\sqlite-vec\vec0.dll
```

### Claude Plugin (alternative)

```bash
/plugin marketplace add rxt0-o/cortex
/plugin install cortex@rxt0-o
```

Auto-allow all tools: `/setup` or add to `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_cortex_cortex__*"]
  }
}
```

### Manual Installation

```bash
git clone https://github.com/rxt0-o/cortex.git
```

`server/dist/` is pre-built.

**Global (all projects)** — register MCP server + hooks with absolute paths:

```bash
# Claude Code (user scope = available everywhere)
claude mcp add --scope user --transport stdio cortex -- node "/path/to/cortex/server/dist/bundle.js"

# Codex CLI
codex mcp add cortex -- node "/path/to/cortex/server/dist/bundle.js"
```

Add hooks to `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-session-start.js", "timeout": 15 }] }],
    "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-pre-tool-use.js", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "Read|Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-post-tool-use.js", "timeout": 10 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-session-end.js", "timeout": 30 }] }]
  }
}
```

**Project-local** — add to project `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/server/dist/bundle.js"]
    }
  }
}
```

And hooks to `.claude/settings.local.json` (same format as above).

---

## How It Works

### Hooks (Synchronous Layer)

Six plain Node.js scripts, zero npm dependencies — only `node:sqlite` and Node.js stdlib.

| Hook | Trigger | What it does |
|---|---|---|
| `on-session-start.js` | Session start | Creates DB, runs decay, injects ranked context |
| `on-user-prompt-submit.js` | User message | Context window size early-warning |
| `on-pre-tool-use.js` | Before Write/Edit | Regression guard: blocks known anti-patterns |
| `on-post-tool-use.js` | After Read/Write/Edit | Tracks changes, saves diffs, scans imports, retry detection |
| `on-pre-compact.js` | Before compaction | Saves interim session data |
| `on-session-end.js` | Session end | Summarizes session, auto-extracts patterns from transcript |

### MCP Server

TypeScript server exposing 16 tools via stdio. Built to `server/dist/bundle.js`.

---

## Architecture

```
cortex/
├── scripts/                    # Hook scripts (plain JS, zero npm deps)
│   ├── ensure-db.js            # DB init + schema migration
│   ├── on-session-start.js     # Context injection + decay
│   ├── on-user-prompt-submit.js # Context window size warning
│   ├── on-session-end.js       # Session summary + auto-extraction
│   ├── on-pre-tool-use.js      # Regression guard (can block)
│   ├── on-post-tool-use.js     # File tracking + retry detection
│   └── on-pre-compact.js       # Interim save before compaction
│
├── server/                     # MCP Server (TypeScript)
│   └── src/
│       ├── index.ts            # Server bootstrap + tool registration
│       ├── db.ts               # SQLite schema v10 + migrations (+ sqlite-vec auto-load)
│       ├── shared/
│       │   └── fts-schema.ts   # FTS5 tables + triggers (single source of truth)
│       ├── modules/
│       │   ├── decisions.ts, errors.ts, learnings.ts, sessions.ts
│       │   ├── search.ts       # Hybrid BM25 + vector search
│       │   ├── embeddings.ts   # Embedding storage + dedup
│       │   ├── decay.ts        # Ebbinghaus decay
│       │   ├── importance.ts   # 5-dimensional importance scoring
│       │   ├── extractions.ts  # Auto-extraction staging
│       │   ├── associations.ts # Memory association graph
│       │   ├── activation.ts   # Spreading activation (BFS)
│       │   ├── project-map.ts, unfinished.ts, health.ts
│       │   └── ...
│       └── tools/
│           ├── core.ts         # cortex_store/search/context/list/resolve/snooze/reindex
│           └── project-map.ts  # map/deps/history/hot-zones/git-import/doc-index
│
├── skills/                     # Slash commands for Claude Code
│   ├── resume/                 # Re-entry brief
│   ├── cortex-search/          # FTS5 search
│   ├── cortex-health/          # Health dashboard
│   ├── cortex-file/            # File history + impact
│   ├── cortex-review/          # Code review
│   ├── pin/                    # Pin auto-blocking rules
│   ├── note/                   # Scratch-pad notes
│   ├── snooze/                 # Session reminders
│   └── timeline/               # Activity overview
│
└── agents/                     # Team agents for development
```

---

## MCP Tools

### Core (8 tools)

| Tool | Description |
|---|---|
| `cortex_store` | Store memory: decisions, errors, learnings, todos, intents, notes |
| `cortex_search` | Hybrid BM25 + vector search; optional AI summary |
| `cortex_context` | Session context via spreading activation; optional AI summary |
| `cortex_list` | List decisions/errors/learnings/todos/notes/extractions |
| `cortex_resolve` | Resolve/update items, promote/reject extractions |
| `cortex_snooze` | Set reminder for future session |
| `cortex_reindex_embeddings` | Rebuild vector index |
| `cortex_save_session` | Save/update session (internal) |

### Project Map (8 tools)

| Tool | Description |
|---|---|
| `cortex_get_map` | Project architecture map |
| `cortex_update_map` | Re-scan and update map |
| `cortex_scan_project` | Scan project files into DB |
| `cortex_get_deps` | Dependency tree + impact analysis |
| `cortex_get_file_history` | File change history |
| `cortex_get_hot_zones` | Most frequently changed files |
| `cortex_import_git_history` | Import git log for hot zones |
| `cortex_index_docs` | Index CLAUDE.md and docs/ |

## Slash Commands

| Command | Description |
|---|---|
| `/resume` | Re-entry brief: last session, open items, changed files |
| `/cortex-search <query>` | Search across all Cortex data |
| `/cortex-health` | Health dashboard |
| `/cortex-file <file>` | File history + impact analysis |
| `/cortex-review` | Code review with auto model selection |
| `/pin <rule>` | Pin auto-blocking rule |
| `/note <text>` | Quick scratch-pad note |
| `/snooze <text> <time>` | Set reminder |
| `/timeline` | Activity overview |

---

## Database

SQLite at `.claude/cortex.db` — one per project, created automatically.

**Schema v10 tables:**
- **Memory:** `sessions`, `decisions`, `errors`, `learnings`, `working_memory`, `auto_extractions`, `notes`
- **Graph:** `memory_associations`, `dependencies`, `activity_log`
- **Project:** `project_modules`, `project_files`, `conventions`, `unfinished`, `diffs`
- **Index:** `embeddings`, `embedding_meta`, `meta`, `health_snapshots`, `schema_version`
- **Vector (optional):** `vec_embeddings` virtual table (available when sqlite-vec runtime loads)

All tables have FTS5 full-text search indexes with automatic INSERT/UPDATE/DELETE triggers.

Uses `node:sqlite` (Node.js built-in). sqlite-vec is auto-loaded when available (npm `sqlite-vec`, DLL path, or `server/native/vec0.dll`), otherwise Cortex uses JS fallback automatically.

---

## License

MIT
