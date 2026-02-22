# Cortex MCP-Server

TypeScript MCP-Server mit 56 Tools. Kommuniziert via stdio mit Claude Code.

## Build

```bash
npm run build   # erzeugt dist/bundle.js (esbuild bundle)
```

Änderungen in `src/` werden erst nach `npm run build` aktiv.

## Struktur

```
server/src/
├── index.ts          # ~60 Zeilen: Server-Setup + register*Tools() calls
├── helpers.ts        # runAllPruning() shared helper
├── db.ts             # SQLite-Verbindung via node:sqlite, getDb() / closeDb()
├── tools/            # Tool-Registrierungen (Zod-Schema + Handler-Glue)
│   ├── sessions.ts   # registerSessionTools    (4 tools)
│   ├── decisions.ts  # registerDecisionTools   (3 tools)
│   ├── errors.ts     # registerErrorTools      (3 tools)
│   ├── learnings.ts  # registerLearningTools   (5 tools)
│   ├── project-map.ts# registerProjectMapTools (8 tools)
│   ├── tracking.ts   # registerTrackingTools   (5 tools)
│   ├── intelligence.ts# registerIntelligenceTools (7 tools)
│   ├── stats.ts      # registerStatsTools      (7 tools)
│   ├── profile.ts    # registerProfileTools    (13 tools)
│   └── meta.ts       # registerMetaTools       (1 tool: cortex_load_tools)
└── modules/          # Business-Logik (DB-Queries, kein Tool-Glue)
    ├── sessions.ts
    ├── decisions.ts
    ├── errors.ts
    ├── learnings.ts
    ├── unfinished.ts
    ├── project-map.ts
    ├── dependencies.ts
    ├── diffs.ts
    ├── conventions.ts
    ├── health.ts
    └── tool-registry.ts
```

## Regeln

- **Neues Tool:** Zod-Schema mit `.describe()` + `input_examples` auf jedem Parameter
- **DB-Zugriff:** immer `getDb()` — nie direktes `new DatabaseSync()`
- **Schema-Änderungen:** nur in `scripts/ensure-db.js`, nicht im Server-Code
- **CORTEX_INSTRUCTIONS:** bei neuen Tools die MCP-Server-Instructions aktualisieren
- **Fehler:** Tool gibt `{ content: [{ type: 'text', text: 'Error: ...' }] }` zurück, wirft nicht

## Tool-Kategorien

| Kategorie | Tools |
|---|---|
| Memory & Context | cortex_snapshot, cortex_get_context, cortex_list_sessions, cortex_search |
| Decisions | cortex_add_decision, cortex_list_decisions, cortex_mark_decision_reviewed |
| Errors & Learnings | cortex_add_error, cortex_add_learning, cortex_check_regression, cortex_list_errors |
| Project Map | cortex_scan_project, cortex_get_map, cortex_get_deps, cortex_get_hot_zones |
| Tracking | cortex_add_unfinished, cortex_get_unfinished, cortex_resolve_unfinished, cortex_add_intent, cortex_snooze |
| Notes & Profile | cortex_add_note, cortex_list_notes, cortex_onboard, cortex_update_profile |
| Intelligence | cortex_dejavu, cortex_check_blind_spots, cortex_get_mood, cortex_forget |
| Stats | cortex_get_health, cortex_get_stats, cortex_get_access_stats, cortex_run_pruning |
| Meta | cortex_load_tools |
