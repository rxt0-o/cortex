# Cortex MCP Server

TypeScript MCP server for Cortex memory and project-map tools.

## Build

```bash
npm run build
```

Changes in `src/` only become active after rebuilding `dist/bundle.js`.

## Structure

```text
server/src/
├── index.ts           # Server bootstrap + registerCoreTools/registerProjectMapTools
├── db.ts              # SQLite schema + compat migrations + getDb()/closeDb()
├── helpers.ts         # Shared pruning helper
├── modules/           # Query/business logic + memory lifecycle
│   ├── decisions.ts
│   ├── errors.ts
│   ├── learnings.ts
│   ├── unfinished.ts
│   ├── sessions.ts
│   ├── search.ts
│   ├── health.ts
│   ├── project-map.ts
│   ├── embeddings.ts
│   ├── decay.ts           # Ebbinghaus decay pruning + strength calculations
│   ├── importance.ts      # 5D importance scoring (Freq/Recency/Impact/Surprise/Sentiment)
│   ├── extractions.ts     # Auto-extraction management + promotion/rejection
│   ├── associations.ts    # Memory association graph (5 types)
│   └── activation.ts      # Spreading activation BFS traversal
├── tools/
│   ├── core.ts        # cortex_store/search/context/list/resolve/snooze/reindex + internal save_session
│   └── project-map.ts # map/deps/history/hot-zones/git-import/doc-index
└── utils/
    └── gemini.ts      # optional summarize helper
```

### New Modules (v9 Brain Upgrade)

- **decay.ts**: Ebbinghaus memory decay curve, prune_old_memories, update_strength
- **importance.ts**: 5D scoring algorithm, compute_importance_score, frequency/recency/impact analysis
- **extractions.ts**: Auto-pattern extraction from transcripts, promote/reject extraction workflow
- **associations.ts**: Memory association graph (same-session, same-file, temporal, causal, semantic)
- **activation.ts**: Spreading activation BFS, find_activated_memories, traversal with decay weighting

## Rules

- Use `getDb()` for DB access; never instantiate `DatabaseSync` directly in modules/tools.
- Keep schema updates in both:
  - `scripts/ensure-db.js` (hook/runtime DB bootstrap)
  - `server/src/db.ts` (`SCHEMA_SQL` + `COMPAT_MIGRATIONS`)
- Keep MCP instructions in `server/src/index.ts` aligned with real tool names.
- Return tool-level errors as text payloads instead of throwing uncaught exceptions.

## Core Tools

- `cortex_store`
- `cortex_search`
- `cortex_context`
- `cortex_list`
- `cortex_resolve`
- `cortex_snooze`
- `cortex_reindex_embeddings`
- `cortex_save_session` (internal hook helper)
