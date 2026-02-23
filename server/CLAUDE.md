# Cortex MCP-Server

TypeScript MCP-Server mit 7 Tools. Kommuniziert via stdio mit Claude Code.

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
│   ├── meta.ts       # registerMetaTools       (1 tool: cortex_load_tools)
│   └── activity.ts   # registerActivityTools   (2 tools)
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
    ├── tool-registry.ts
    └── activity.ts
```

## Regeln

- **Neues Tool:** Zod-Schema mit `.describe()` + `input_examples` auf jedem Parameter
- **DB-Zugriff:** immer `getDb()` — nie direktes `new DatabaseSync()`
- **Schema-Änderungen:** nur in `scripts/ensure-db.js`, nicht im Server-Code
- **CORTEX_INSTRUCTIONS:** bei neuen Tools die MCP-Server-Instructions aktualisieren
- **Fehler:** Tool gibt `{ content: [{ type: 'text', text: 'Error: ...' }] }` zurück, wirft nicht

## Tools (6 + 1 intern)

| Tool | Zweck |
|---|---|
| cortex_store | Unified Write: decision/error/learning/todo/intent/note |
| cortex_search | FTS5-Suche über alle Entitäten |
| cortex_context | Session-Kontext + datei-spezifischer Kontext |
| cortex_list | Listen: decisions/errors/learnings/todos/notes |
| cortex_resolve | Abschließen: todo resolved / decision reviewed / error updated |
| cortex_snooze | Reminder für spätere Session setzen |
| cortex_save_session | (intern, von Hooks genutzt) |
