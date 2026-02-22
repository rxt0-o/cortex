# Cortex: saga-mcp Feature-Erweiterung — Design

**Datum:** 2026-02-22
**Inspiration:** [saga-mcp](https://github.com/spranab/saga-mcp)

## Ziel

Drei Features aus saga-mcp in Cortex integrieren:
1. **Batch-Operationen** — mehrere Items auf einmal verwalten (alle Entities)
2. **Entity-Links bei Notes** — Notes direkt an Decision/Error/Learning/Session verlinken, Rücklinks, Auftauchen in snapshot/get_context
3. **Activity Log** — strukturiertes Audit-Log aller wichtigen Änderungen

## Ansatz: Hybrid

- Bestehende Tools erweitern (neue optionale Parameter)
- Activity-Log als separates neues Tool (kein Auto-Wrapping/Middleware)
- Keine Änderung an bestehenden Tool-Signaturen (nur additive Parameter)

---

## DB-Schema

**Migration in `scripts/ensure-db.js`:**

```sql
-- notes: Entity-Links
ALTER TABLE notes ADD COLUMN entity_type TEXT;  -- 'decision'|'error'|'learning'|'session'
ALTER TABLE notes ADD COLUMN entity_id INTEGER;

-- Neues Activity-Log
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  tool_name TEXT NOT NULL,
  entity_type TEXT,               -- 'decision'|'error'|'learning'|'note'|'unfinished'
  entity_id INTEGER,
  action TEXT NOT NULL,           -- 'create'|'update'|'delete'|'archive'
  old_value TEXT,                 -- JSON
  new_value TEXT,                 -- JSON
  session_id TEXT
);
```

---

## Tool-Änderungen

### Notes (entity-links)

`cortex_add_note` — neue optionale Parameter:
- `entity_type?: 'decision' | 'error' | 'learning' | 'session'`
- `entity_id?: number`

`cortex_list_notes` — neue optionale Filter:
- `entity_type?`, `entity_id?` → filtert auf verknüpfte Notes

`cortex_list_decisions`, `cortex_list_errors`, `cortex_list_learnings`:
- neuer optionaler Parameter `include_notes?: boolean`
- wenn true: verknüpfte Notes werden in Output mitgeladen

`cortex_get_context` + `cortex_snapshot`:
- Notes mit entity-Link tauchen in den relevanten Sektionen auf

### Batch-Operationen

`cortex_resolve_unfinished` → `ids: number[]` statt `id: number`
`cortex_add_learning` → akzeptiert einzelnes Objekt ODER Array
`cortex_add_error` → akzeptiert einzelnes Objekt ODER Array

### Activity Log (neue Tools)

`cortex_activity_log` — liest Activity-Log:
- Filter: `entity_type?`, `entity_id?`, `action?`, `limit?`, `since?`

`cortex_log_activity` — manuell einen Eintrag loggen:
- `tool_name`, `entity_type?`, `entity_id?`, `action`, `old_value?`, `new_value?`, `session_id?`

---

## Out of Scope (YAGNI)

- Auto-Logging per Middleware
- MCP Safety-Annotations
- Notes-Kategorien (saga-mcp style)
- Hierarchie (Epics → Tasks)

---

## Implementierungsreihenfolge (4 Tasks, parallel mit Agents)

| Task | Was | Files |
|---|---|---|
| 1 | DB-Migration | `scripts/ensure-db.js` |
| 2 | Notes Entity-Links | `server/src/tools/profile.ts`, `server/src/modules/notes.ts` (neu) |
| 3 | Batch-Operationen | `server/src/tools/tracking.ts`, `learnings.ts`, `errors.ts` |
| 4 | Activity-Log | `server/src/tools/activity.ts` (neu), `server/src/modules/activity.ts` (neu) |

Task 1 muss vor 2, 3, 4 fertig sein (DB-Schema). Tasks 2, 3, 4 sind danach unabhängig parallel möglich.
