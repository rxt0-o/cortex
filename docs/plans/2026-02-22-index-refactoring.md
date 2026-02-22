# index.ts Refactoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `server/src/index.ts` von 1630 auf ~80 Zeilen schrumpfen — alle 55 Tool-Registrierungen in `server/src/tools/` Kategorie-Dateien auslagern.

**Architecture:** Business-Logik bleibt unverändert in `server/src/modules/`. Neue `server/src/tools/` Dateien enthalten nur Zod-Schema + `server.tool(...)` Glue-Code. Jede Datei exportiert eine `register*Tools(server: McpServer): void` Funktion. Shared Helper `runAllPruning` wird nach `server/src/helpers.ts` extrahiert.

**Tech Stack:** TypeScript strict, esbuild bundle, `@modelcontextprotocol/sdk`

---

## TypeScript-Muster für tools/-Dateien

```typescript
// server/src/tools/decisions.ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db.js';
import * as decisions from '../modules/decisions.js';

export function registerDecisionTools(server: McpServer): void {
  server.tool(
    'cortex_add_decision',
    'Log an architectural or design decision with reasoning',
    { /* Zod-Schema */ },
    async (input) => {
      getDb();
      // ... Handler
      return { content: [{ type: 'text' as const, text: '...' }] };
    }
  );
  // weitere Tools...
}
```

**Import-Pfade aus tools/:** `../db.js`, `../modules/*.js`, `../modules/tool-registry.js`

---

## Tool-Zuordnung (55 Tools auf 10 Dateien)

| Datei | Tools (Anzahl) |
|---|---|
| `tools/decisions.ts` | cortex_add_decision, cortex_list_decisions, cortex_mark_decision_reviewed (3) |
| `tools/errors.ts` | cortex_add_error, cortex_list_errors, cortex_update_error (3) |
| `tools/learnings.ts` | cortex_add_learning, cortex_update_learning, cortex_delete_learning, cortex_list_learnings, cortex_check_regression (5) |
| `tools/tracking.ts` | cortex_get_unfinished, cortex_add_unfinished, cortex_resolve_unfinished, cortex_add_intent, cortex_snooze (5) |
| `tools/project-map.ts` | cortex_get_deps, cortex_get_map, cortex_update_map, cortex_scan_project, cortex_index_docs, cortex_get_hot_zones, cortex_get_file_history, cortex_import_git_history (8) |
| `tools/stats.ts` | cortex_get_health, cortex_get_stats, cortex_get_access_stats, cortex_run_pruning, cortex_get_timeline, cortex_compare_periods, cortex_suggest_claude_md (7) |
| `tools/profile.ts` | cortex_update_profile, cortex_get_profile, cortex_onboard, cortex_export, cortex_add_note, cortex_list_notes, cortex_delete_note, cortex_add_anchor, cortex_remove_anchor, cortex_list_anchors, cortex_set_project, cortex_get_conventions, cortex_add_convention (13) |
| `tools/intelligence.ts` | cortex_blame, cortex_snapshot, cortex_dejavu, cortex_check_blind_spots, cortex_forget, cortex_get_mood, cortex_cross_project_search (7) |
| `tools/sessions.ts` | cortex_save_session, cortex_list_sessions, cortex_search, cortex_get_context (4) |
| `tools/meta.ts` | cortex_load_tools (1) |

---

## Task 1: helpers.ts erstellen

**Files:**
- Create: `server/src/helpers.ts`

**Step 1: Datei erstellen**

```typescript
// server/src/helpers.ts
import * as decisions from './modules/decisions.js';
import * as learnings from './modules/learnings.js';
import * as errors from './modules/errors.js';

export function runAllPruning(): { decisions_archived: number; learnings_archived: number; errors_archived: number } {
  const d = decisions.runDecisionsPruning();
  const l = learnings.runLearningsPruning();
  const e = errors.runErrorsPruning();
  return {
    decisions_archived: d.decisions_archived,
    learnings_archived: l.learnings_archived,
    errors_archived: e.errors_archived,
  };
}
```

**Step 2: Build prüfen**
```bash
cd server && npm run build
```
Expected: Kein Fehler.

**Step 3: Commit**
```bash
git add server/src/helpers.ts server/dist/bundle.js
git commit -m "refactor: helpers.ts mit runAllPruning extrahiert"
```

---

## Task 2: tools/decisions.ts

**Files:**
- Create: `server/src/tools/decisions.ts`
- Modify: `server/src/index.ts` (3 Tool-Blöcke entfernen, Import + registerDecisionTools() hinzufügen)

**Step 1: Lese den aktuellen Stand von index.ts** um die exakten Tool-Blöcke für cortex_add_decision, cortex_list_decisions, cortex_mark_decision_reviewed zu finden.

**Step 2: tools/decisions.ts erstellen** — exakte Kopie der 3 Tool-Blöcke aus index.ts, gewrappt in `registerDecisionTools(server: McpServer): void`.

**Step 3: index.ts anpassen**
- Import hinzufügen: `import { registerDecisionTools } from './tools/decisions.js';`
- Die 3 Tool-Blöcke aus index.ts entfernen
- `registerDecisionTools(server);` an passender Stelle einfügen

**Step 4: Build**
```bash
cd server && npm run build
```
Expected: Kein Fehler. Falls Fehler: sofort fixen.

**Step 5: Commit**
```bash
git add server/src/tools/decisions.ts server/src/index.ts server/dist/bundle.js
git commit -m "refactor: extract tools/decisions.ts (3 tools)"
```

---

## Task 3: tools/errors.ts

Gleiche Vorgehensweise wie Task 2 für:
- cortex_add_error, cortex_list_errors, cortex_update_error

Commit: `refactor: extract tools/errors.ts (3 tools)`

---

## Task 4: tools/learnings.ts

Gleiche Vorgehensweise für:
- cortex_add_learning, cortex_update_learning, cortex_delete_learning, cortex_list_learnings, cortex_check_regression

Achtung: `cortex_check_regression` hat Cross-Modul-Abhängigkeiten (learnings, conventions, errors) — alle Imports müssen in tools/learnings.ts landen.

Commit: `refactor: extract tools/learnings.ts (5 tools)`

---

## Task 5: tools/tracking.ts

Gleiche Vorgehensweise für:
- cortex_get_unfinished, cortex_add_unfinished, cortex_resolve_unfinished, cortex_add_intent, cortex_snooze

Commit: `refactor: extract tools/tracking.ts (5 tools)`

---

## Task 6: tools/project-map.ts

Gleiche Vorgehensweise für:
- cortex_get_deps, cortex_get_map, cortex_update_map, cortex_scan_project, cortex_index_docs, cortex_get_hot_zones, cortex_get_file_history, cortex_import_git_history

Achtung: `cortex_index_docs` nutzt `fs` und `path` inline — diese Imports müssen nach tools/project-map.ts.
Achtung: `cortex_import_git_history` nutzt `child_process` — ebenfalls importieren.

Commit: `refactor: extract tools/project-map.ts (8 tools)`

---

## Task 7: tools/stats.ts

Gleiche Vorgehensweise für:
- cortex_get_health, cortex_get_stats, cortex_get_access_stats, cortex_run_pruning, cortex_get_timeline, cortex_compare_periods, cortex_suggest_claude_md

Achtung: `cortex_run_pruning` braucht `runAllPruning` aus `../helpers.js`.

Commit: `refactor: extract tools/stats.ts (7 tools)`

---

## Task 8: tools/profile.ts

Gleiche Vorgehensweise für:
- cortex_update_profile, cortex_get_profile, cortex_onboard, cortex_export, cortex_add_note, cortex_list_notes, cortex_delete_note, cortex_add_anchor, cortex_remove_anchor, cortex_list_anchors, cortex_set_project, cortex_get_conventions, cortex_add_convention

Commit: `refactor: extract tools/profile.ts (13 tools)`

---

## Task 9: tools/intelligence.ts

Gleiche Vorgehensweise für:
- cortex_blame, cortex_snapshot, cortex_dejavu, cortex_check_blind_spots, cortex_forget, cortex_get_mood, cortex_cross_project_search

Achtung: `cortex_blame` braucht `parseDiff` und `summarizeFunctionChanges` aus `../analyzer/diff-extractor.js` und `../analyzer/chunk-analyzer.js`.
Achtung: `cortex_snapshot` ist ~170 Zeilen — sorgfältig kopieren.

Commit: `refactor: extract tools/intelligence.ts (7 tools)`

---

## Task 10: tools/sessions.ts

Gleiche Vorgehensweise für:
- cortex_save_session, cortex_list_sessions, cortex_search, cortex_get_context

Achtung: `cortex_save_session` braucht `runAllPruning` aus `../helpers.js`.
Achtung: `cortex_search` und `cortex_get_context` haben direkte DB-Queries.

Commit: `refactor: extract tools/sessions.ts (4 tools)`

---

## Task 11: tools/meta.ts + index.ts aufräumen

**Step 1: tools/meta.ts erstellen** für cortex_load_tools

**Step 2: index.ts auf ~80 Zeilen schrumpfen**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb, closeDb } from './db.js';

import { registerSessionTools } from './tools/sessions.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerErrorTools } from './tools/errors.js';
import { registerLearningTools } from './tools/learnings.js';
import { registerProjectMapTools } from './tools/project-map.js';
import { registerTrackingTools } from './tools/tracking.js';
import { registerIntelligenceTools } from './tools/intelligence.js';
import { registerStatsTools } from './tools/stats.js';
import { registerProfileTools } from './tools/profile.js';
import { registerMetaTools } from './tools/meta.js';

const CORTEX_INSTRUCTIONS = `Cortex is a persistent memory and intelligence system for Claude Code.

TOOL CATEGORIES (call cortex_load_tools to get detailed guidance):
- memory: snapshot, get_context, list_sessions, search
- decisions: add_decision, list_decisions, mark_decision_reviewed
- errors: add_error, add_learning, check_regression, list_errors, list_learnings
- map: scan_project, get_map, get_deps, get_hot_zones, file_history, blame
- tracking: add_unfinished, get_unfinished, resolve_unfinished, add_intent, snooze
- notes: add_note, list_notes, onboard, update_profile, get_profile
- intelligence: dejavu, check_blind_spots, get_mood, forget, cross_project_search
- stats: get_health, get_stats, get_access_stats, run_pruning, get_timeline

RULES: Always call cortex_check_regression before writing/editing files.
Use cortex_load_tools(['category']) to get detailed usage guidance for any category.`;

const server = new McpServer(
  { name: 'project-cortex', version: '0.1.0' },
  { instructions: CORTEX_INSTRUCTIONS },
);

registerSessionTools(server);
registerDecisionTools(server);
registerErrorTools(server);
registerLearningTools(server);
registerProjectMapTools(server);
registerTrackingTools(server);
registerIntelligenceTools(server);
registerStatsTools(server);
registerProfileTools(server);
registerMetaTools(server);

async function main() {
  getDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGINT', () => { closeDb(); process.exit(0); });
  process.on('SIGTERM', () => { closeDb(); process.exit(0); });
}

main().catch((err) => {
  console.error('Cortex MCP Server failed to start:', err);
  process.exit(1);
});
```

**Step 3: Build + Smoke-Test**
```bash
cd server && npm run build
node server/dist/bundle.js &
sleep 2 && kill %1
```
Expected: Startet ohne Fehler.

**Step 4: Commit**
```bash
git add server/src/tools/meta.ts server/src/index.ts server/dist/bundle.js
git commit -m "refactor: extract tools/meta.ts + index.ts auf ~80 Zeilen"
```

---

## Task 12: server/CLAUDE.md aktualisieren

Struktur-Sektion in `server/CLAUDE.md` aktualisieren:

```
server/src/
├── index.ts          # ~80 Zeilen: Server-Setup + register*Tools() calls
├── helpers.ts        # runAllPruning() shared helper
├── db.ts             # SQLite-Verbindung
├── tools/            # Tool-Registrierungen (Zod-Schema + Handler)
│   ├── sessions.ts   # registerSessionTools (4 tools)
│   ├── decisions.ts  # registerDecisionTools (3 tools)
│   ├── errors.ts     # registerErrorTools (3 tools)
│   ├── learnings.ts  # registerLearningTools (5 tools)
│   ├── project-map.ts # registerProjectMapTools (8 tools)
│   ├── tracking.ts   # registerTrackingTools (5 tools)
│   ├── intelligence.ts # registerIntelligenceTools (7 tools)
│   ├── stats.ts      # registerStatsTools (7 tools)
│   ├── profile.ts    # registerProfileTools (13 tools)
│   └── meta.ts       # registerMetaTools (1 tool: cortex_load_tools)
└── modules/          # Business-Logik (unverändert)
```

Commit: `docs: server/CLAUDE.md mit tools/-Struktur aktualisiert`

---

## Zusammenfassung

| Vorher | Nachher |
|---|---|
| index.ts: 1630 Zeilen | index.ts: ~80 Zeilen |
| 0 Dateien in tools/ | 10 Dateien in tools/ |
| runAllPruning in index.ts | helpers.ts |
