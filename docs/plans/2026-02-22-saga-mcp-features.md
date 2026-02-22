# Cortex: saga-mcp Feature-Erweiterung — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Drei Features aus saga-mcp in Cortex integrieren: Batch-Operationen, Entity-Links bei Notes und Activity Log.

**Architecture:** Hybrid-Ansatz — bestehende Tools bekommen neue optionale Parameter (additive, kein Breaking Change), Activity-Log als zwei neue Tools. Task 1 (DB-Migration) muss vor Tasks 2-4 fertig sein; Tasks 2, 3, 4 sind danach parallel implementierbar.

**Tech Stack:** TypeScript strict, esbuild, @modelcontextprotocol/sdk, zod, node:sqlite (via getDb())

---

## Kontext fuer Implementierer

### Projektstruktur

```
server/src/
├── index.ts          # ~58 Zeilen: nur Server-Setup + register*Tools() calls
├── helpers.ts        # runAllPruning() shared helper
├── db.ts             # getDb() / closeDb()
├── tools/            # Tool-Registrierungen (Zod-Schema + Handler)
│   ├── profile.ts    # cortex_add_note, cortex_list_notes, cortex_delete_note etc.
│   ├── tracking.ts   # cortex_resolve_unfinished, cortex_add_unfinished etc.
│   ├── learnings.ts  # cortex_add_learning etc.
│   ├── errors.ts     # cortex_add_error etc.
│   └── ...
└── modules/          # Business-Logik (DB-Queries, kein Tool-Glue)

scripts/
└── ensure-db.js      # DB-Schema + Migrationen (kein npm, nur Node stdlib)
```

### TypeScript-Pattern fuer Tools

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';

export function registerExampleTools(server: McpServer): void {
  server.tool(
    'cortex_tool_name',
    'Description',
    { param: z.string().describe('Example: "foo"') },
    async (input) => {
      const db = getDb();
      return { content: [{ type: 'text' as const, text: 'result' }] };
    }
  );
}
```

### Build
```bash
cd server && npm run build
```
Expected: dist/bundle.js erzeugt, kein Fehler.

### Migrationen in ensure-db.js
Neue SQL-Statements am Ende des v04migrations-Arrays einfuegen:
```javascript
`ALTER TABLE notes ADD COLUMN entity_type TEXT`,
```
try/catch per Statement ist absichtlich — idempotent (Column exists wird ignoriert).

---

## Task 1: DB-Migration

**Files:**
- Modify: `scripts/ensure-db.js`

**Step 1: Neue Statements ans Ende des v04migrations-Arrays einfuegen**

Suche das Ende des Arrays (nach dem notes_ai Trigger) und fuege vor der schliessenden ] ein:

```javascript
    // v05: entity-links fuer notes + activity_log
    `ALTER TABLE notes ADD COLUMN entity_type TEXT`,
    `ALTER TABLE notes ADD COLUMN entity_id INTEGER`,
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      tool_name TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      session_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)`,
```

**Step 2: Smoke-Test**

```bash
node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb(process.cwd()); const cols = db.prepare('PRAGMA table_info(notes)').all(); console.log('notes cols:', cols.map(c => c.name).join(', ')); const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all(); console.log('tables:', tables.map(t => t.name).join(', ')); db.close(); console.log('OK'); })"
```
Expected: notes cols enthaelt entity_type und entity_id, tables enthaelt activity_log.

**Step 3: Commit**

```bash
git add scripts/ensure-db.js
git commit -m "feat: DB-Migration — notes entity-links + activity_log Tabelle"
```

---

## Task 2: Notes Entity-Links

**Files:**
- Modify: `server/src/tools/profile.ts`
- Modify: `server/src/tools/decisions.ts`
- Modify: `server/src/tools/errors.ts`
- Modify: `server/src/tools/learnings.ts`

**Step 1: cortex_add_note — entity_type und entity_id hinzufuegen**

In server/src/tools/profile.ts, das cortex_add_note Tool:

Vorher (Schema):
```typescript
{
  text: z.string(),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
}
```

Nachher (Schema):
```typescript
{
  text: z.string(),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  entity_type: z.enum(['decision', 'error', 'learning', 'session']).optional().describe('Link this note to an entity. Example: "decision"'),
  entity_id: z.number().optional().describe('ID of the linked entity. Example: 42'),
}
```

Vorher (Handler body):
```typescript
async ({ text, tags, session_id }) => {
  const r = getDb().prepare(`INSERT INTO notes (text,tags,session_id) VALUES (?,?,?)`).run(text, tags ? JSON.stringify(tags) : null, session_id ?? null);
  return { content: [{ type: 'text' as const, text: `Note saved (id: ${r.lastInsertRowid})` }] };
}
```

Nachher (Handler body):
```typescript
async ({ text, tags, session_id, entity_type, entity_id }) => {
  const r = getDb().prepare(`INSERT INTO notes (text,tags,session_id,entity_type,entity_id) VALUES (?,?,?,?,?)`).run(
    text,
    tags ? JSON.stringify(tags) : null,
    session_id ?? null,
    entity_type ?? null,
    entity_id ?? null,
  );
  return { content: [{ type: 'text' as const, text: `Note saved (id: ${r.lastInsertRowid})` }] };
}
```

**Step 2: cortex_list_notes — entity Filter hinzufuegen**

In server/src/tools/profile.ts, das cortex_list_notes Tool:

Vorher (Schema):
```typescript
{
  limit: z.number().optional().default(20),
  search: z.string().optional(),
}
```

Nachher (Schema):
```typescript
{
  limit: z.number().optional().default(20),
  search: z.string().optional(),
  entity_type: z.enum(['decision', 'error', 'learning', 'session']).optional().describe('Filter by linked entity type'),
  entity_id: z.number().optional().describe('Filter by linked entity ID'),
}
```

Vorher (Handler body):
```typescript
async ({ limit, search }) => {
  const db = getDb();
  const notes = search
    ? db.prepare(`SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${search}%`, limit)
    : db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT ?`).all(limit);
  return { content: [{ type: 'text' as const, text: (notes as any[]).map(n => `[${n.id}] ${n.created_at.slice(0,10)}: ${n.text}`).join('\n') || 'No notes.' }] };
}
```

Nachher (Handler body):
```typescript
async ({ limit, search, entity_type, entity_id }) => {
  const db = getDb();
  let notes: any[];
  if (entity_type && entity_id) {
    notes = db.prepare(`SELECT * FROM notes WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT ?`).all(entity_type, entity_id, limit) as any[];
  } else if (search) {
    notes = db.prepare(`SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${search}%`, limit) as any[];
  } else {
    notes = db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
  }
  return { content: [{ type: 'text' as const, text: (notes as any[]).map(n => {
    const link = n.entity_type ? ` [${n.entity_type}:${n.entity_id}]` : '';
    return `[${n.id}] ${n.created_at.slice(0,10)}${link}: ${n.text}`;
  }).join('\n') || 'No notes.' }] };
}
```

**Step 3: cortex_list_decisions — include_notes**

In server/src/tools/decisions.ts, das cortex_list_decisions Tool — include_notes Parameter hinzufuegen:

Im Schema:
```typescript
include_notes: z.boolean().optional().describe('If true, include linked notes for each decision'),
```

Im Handler, nach dem Laden der results, wenn include_notes:
```typescript
if (input.include_notes) {
  const db = getDb();
  for (const d of result as any[]) {
    (d as any).notes = db.prepare(`SELECT id, text, created_at FROM notes WHERE entity_type='decision' AND entity_id=? ORDER BY created_at DESC`).all(d.id);
  }
}
```

**Step 4: cortex_list_errors und cortex_list_learnings — gleich wie Step 3**

In server/src/tools/errors.ts → cortex_list_errors:
- include_notes: z.boolean().optional()
- Notes laden mit: entity_type='error'

In server/src/tools/learnings.ts → cortex_list_learnings:
- include_notes: z.boolean().optional()
- Notes laden mit: entity_type='learning'

**Step 5: Build**
```bash
cd server && npm run build
```
Expected: Kein Fehler.

**Step 6: Commit**
```bash
git add server/src/tools/profile.ts server/src/tools/decisions.ts server/src/tools/errors.ts server/src/tools/learnings.ts server/dist/bundle.js
git commit -m "feat: notes entity-links + include_notes in list tools"
```

---

## Task 3: Batch-Operationen

**Files:**
- Modify: `server/src/tools/tracking.ts`
- Modify: `server/src/tools/learnings.ts`
- Modify: `server/src/tools/errors.ts`

**Step 1: cortex_resolve_unfinished — ids[] statt id**

In server/src/tools/tracking.ts:

Vorher (Schema):
```typescript
{ id: z.number(), session_id: z.string().optional() }
```

Nachher (Schema):
```typescript
{
  id: z.number().optional().describe('Single item ID to resolve'),
  ids: z.array(z.number()).optional().describe('Multiple item IDs to resolve at once. Example: [1, 2, 3]'),
  session_id: z.string().optional(),
}
```

Vorher (Handler):
```typescript
async ({ id, session_id }) => {
  getDb();
  const item = unfinished.resolveUnfinished(id, session_id);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ success: !!item, item }, null, 2) }] };
}
```

Nachher (Handler):
```typescript
async ({ id, ids, session_id }) => {
  getDb();
  const toResolve = ids ?? (id !== undefined ? [id] : []);
  if (toResolve.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Error: provide id or ids' }] };
  }
  const results = toResolve.map(i => ({ id: i, item: unfinished.resolveUnfinished(i, session_id) }));
  return { content: [{ type: 'text' as const, text: JSON.stringify({ resolved: results.length, results }, null, 2) }] };
}
```

**Step 2: cortex_add_learning — batch Parameter**

In server/src/tools/learnings.ts, cortex_add_learning:

Neuen batch Parameter ans Schema-Ende anfuegen:
```typescript
batch: z.array(z.object({
  anti_pattern: z.string(),
  correct_pattern: z.string(),
  context: z.string(),
  detection_regex: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  auto_block: z.boolean().optional(),
  session_id: z.string().optional(),
})).optional().describe('Add multiple learnings at once'),
```

Handler am Anfang des async-Blocks:
```typescript
if (input.batch && input.batch.length > 0) {
  const results = input.batch.map(item => learnings.addLearning(item));
  return { content: [{ type: 'text' as const, text: JSON.stringify({ added: results.length, results: results.map(r => ({ id: r.learning.id, duplicate: !!r.duplicate })) }, null, 2) }] };
}
```

**Step 3: cortex_add_error — batch Parameter**

In server/src/tools/errors.ts, cortex_add_error:

Neuen batch Parameter:
```typescript
batch: z.array(z.object({
  error_message: z.string(),
  root_cause: z.string().optional(),
  fix_description: z.string().optional(),
  fix_diff: z.string().optional(),
  files_involved: z.array(z.string()).optional(),
  prevention_rule: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  session_id: z.string().optional(),
})).optional().describe('Add multiple errors at once'),
```

Handler am Anfang:
```typescript
if (input.batch && input.batch.length > 0) {
  const results = input.batch.map(item => errors.addError(item));
  return { content: [{ type: 'text' as const, text: JSON.stringify({ added: results.length, ids: results.map((r: any) => r.id) }, null, 2) }] };
}
```

**Step 4: Build**
```bash
cd server && npm run build
```
Expected: Kein Fehler.

**Step 5: Commit**
```bash
git add server/src/tools/tracking.ts server/src/tools/learnings.ts server/src/tools/errors.ts server/dist/bundle.js
git commit -m "feat: batch-operationen fuer resolve_unfinished, add_learning, add_error"
```

---

## Task 4: Activity Log

**Files:**
- Create: `server/src/modules/activity.ts`
- Create: `server/src/tools/activity.ts`
- Modify: `server/src/index.ts`

**Step 1: server/src/modules/activity.ts erstellen**

```typescript
// server/src/modules/activity.ts
import { getDb } from '../db.js';

export interface ActivityEntry {
  tool_name: string;
  entity_type?: string;
  entity_id?: number;
  action: string;
  old_value?: string;
  new_value?: string;
  session_id?: string;
}

export function logActivity(entry: ActivityEntry): { id: number | bigint } {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO activity_log (tool_name, entity_type, entity_id, action, old_value, new_value, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.tool_name,
    entry.entity_type ?? null,
    entry.entity_id ?? null,
    entry.action,
    entry.old_value ?? null,
    entry.new_value ?? null,
    entry.session_id ?? null,
  );
  return { id: r.lastInsertRowid };
}

export interface ActivityFilter {
  entity_type?: string;
  entity_id?: number;
  action?: string;
  since?: string;
  limit?: number;
}

export function listActivity(filter: ActivityFilter = {}): any[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.entity_type) { conditions.push('entity_type=?'); params.push(filter.entity_type); }
  if (filter.entity_id) { conditions.push('entity_id=?'); params.push(filter.entity_id); }
  if (filter.action) { conditions.push('action=?'); params.push(filter.action); }
  if (filter.since) { conditions.push('created_at >= ?'); params.push(filter.since); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const lim = filter.limit ?? 50;
  params.push(lim);

  return db.prepare(`SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as any[];
}
```

**Step 2: server/src/tools/activity.ts erstellen**

```typescript
// server/src/tools/activity.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as activity from '../modules/activity.js';

export function registerActivityTools(server: McpServer): void {
  server.tool(
    'cortex_activity_log',
    'Get activity log — structured audit trail of all important operations',
    {
      entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional().describe('Filter by entity type. Example: "decision"'),
      entity_id: z.number().optional().describe('Filter by entity ID. Example: 42'),
      action: z.enum(['create', 'update', 'delete', 'archive']).optional().describe('Filter by action type'),
      since: z.string().optional().describe('ISO date or datetime to filter from. Example: "2026-02-01"'),
      limit: z.number().optional().default(50),
    },
    async (input) => {
      getDb();
      const entries = activity.listActivity(input);
      if (entries.length === 0) return { content: [{ type: 'text' as const, text: 'No activity found.' }] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries, null, 2) }] };
    }
  );

  server.tool(
    'cortex_log_activity',
    'Manually log an activity entry — call after important operations',
    {
      tool_name: z.string().describe('Tool or operation name. Example: "cortex_add_decision" or "manual-refactor"'),
      entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional(),
      entity_id: z.number().optional().describe('ID of the affected entity'),
      action: z.enum(['create', 'update', 'delete', 'archive']).describe('Type of action performed'),
      old_value: z.string().optional().describe('Previous value as JSON string'),
      new_value: z.string().optional().describe('New value as JSON string'),
      session_id: z.string().optional(),
    },
    async (input) => {
      getDb();
      const result = activity.logActivity(input);
      return { content: [{ type: 'text' as const, text: `Activity logged (id: ${result.id})` }] };
    }
  );
}
```

**Step 3: server/src/index.ts — registerActivityTools hinzufuegen**

Suche in server/src/index.ts nach den Import-Zeilen und fuege hinzu:
```typescript
import { registerActivityTools } from './tools/activity.js';
```

Suche nach registerMetaTools(server); und fuege danach hinzu:
```typescript
registerActivityTools(server);
```

**Step 4: Build**
```bash
cd server && npm run build
```
Expected: Kein Fehler.

**Step 5: Smoke-Test DB**
```bash
node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb(process.cwd()); db.prepare('INSERT INTO activity_log (tool_name, entity_type, entity_id, action) VALUES (?,?,?,?)').run('test', 'decision', 1, 'create'); const e = db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1').get(); console.log('OK:', JSON.stringify(e)); db.close(); })"
```
Expected: JSON-Objekt mit tool_name: 'test', action: 'create'.

**Step 6: Commit**
```bash
git add server/src/modules/activity.ts server/src/tools/activity.ts server/src/index.ts server/dist/bundle.js
git commit -m "feat: activity log — cortex_activity_log + cortex_log_activity"
```

---

## Task 5: Docs aktualisieren

**Files:**
- Modify: `server/src/index.ts` (CORTEX_INSTRUCTIONS)
- Modify: `server/src/modules/tool-registry.ts`
- Modify: `server/CLAUDE.md`

**Step 1: CORTEX_INSTRUCTIONS in index.ts — neue Zeile**

In der Kategorienliste (nach stats):
```
- activity: activity_log, log_activity
```

**Step 2: tool-registry.ts — ToolCategory + TOOL_CATEGORIES erweitern**

ToolCategory Union-Typ:
```typescript
export type ToolCategory = 'memory' | 'decisions' | 'errors' | 'map' | 'tracking' | 'notes' | 'intelligence' | 'stats' | 'activity';
```

Neue Kategorie im TOOL_CATEGORIES Objekt:
```typescript
  activity: `## Activity Log Tools

Use to audit and track what happened across sessions.

- **cortex_activity_log** → List activity log entries. Filter by entity_type, entity_id, action, since date.
- **cortex_log_activity** → Manually log an activity entry after important operations.`,
```

**Step 3: server/CLAUDE.md — Tabelle + Struktur**

In der Tool-Kategorien-Tabelle Zeile hinzufuegen:
```
| Activity | cortex_activity_log, cortex_log_activity |
```

In der Struktur-Sektion tools/-Liste:
```
│   └── activity.ts   # registerActivityTools (2 tools)
```

Tool-Count von 56 auf 58 erhoehen.

**Step 4: Build + Commit**
```bash
cd server && npm run build
git add server/src/index.ts server/src/modules/tool-registry.ts server/CLAUDE.md server/dist/bundle.js
git commit -m "docs: activity Kategorie in CORTEX_INSTRUCTIONS + CLAUDE.md + tool-registry"
```

---

## Zusammenfassung

| Vorher | Nachher |
|---|---|
| Notes ohne Entity-Links | Notes mit entity_type/entity_id, Ruecklinks in list_decisions/errors/learnings |
| Einzelne resolve/add Calls | Batch: ids[], batch: [...] |
| Kein Audit-Trail | activity_log Tabelle + 2 neue Tools |
| 56 Tools | 58 Tools |
