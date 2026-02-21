# Cortex hmem-Verbesserungen: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Drei hmem-inspirierte Features implementieren: Access-Counter, automatisches Ebbinghaus-Pruning und Recency-Gradient im Snapshot.

**Architecture:** Schema-Migration von v1 auf v2 fuegt `access_count`, `last_accessed` und `archived_at` zu decisions/learnings/errors hinzu. Pruning laeuft automatisch bei jedem Session-Start. Der Snapshot bekommt eine Tiefenstruktur fuer frische vs. alte Daten.

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), MCP SDK, Zod

---

## Betroffene Dateien

- `server/src/db.ts` — Schema v2, Migration, neue Spalten
- `server/src/modules/decisions.ts` — access_count tracken, archived_at filtern, Pruning
- `server/src/modules/learnings.ts` — access_count tracken, archived_at filtern, Pruning
- `server/src/modules/errors.ts` — access_count tracken, archived_at filtern, Pruning
- `server/src/index.ts` — cortex_snapshot erweitern, cortex_run_pruning Tool, auto-pruning bei session start

**Build-Befehl:** `cd /c/Users/toasted/Desktop/data/cortex/server && npm run build`

---

## Task 1: Schema v2 in db.ts

**File:** `server/src/db.ts`

### Schritt 1: SCHEMA_VERSION aendern

Zeile 8: `const SCHEMA_VERSION = 1;` aendern zu:
```
const SCHEMA_VERSION = 2;
```

### Schritt 2: Neue Spalten in SCHEMA_SQL

In der `decisions`-Tabelle nach `confidence TEXT DEFAULT 'high'` hinzufuegen (vor dem schliessenden Semikolon):
```sql
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  archived_at TEXT
```

In der `learnings`-Tabelle nach `auto_block INTEGER DEFAULT 0` hinzufuegen:
```sql
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  archived_at TEXT
```

In der `errors`-Tabelle nach `severity TEXT DEFAULT 'medium'` hinzufuegen:
```sql
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  archived_at TEXT
```

Am Ende des Index-Blocks (nach dem letzten `CREATE INDEX`) hinzufuegen:
```sql
CREATE INDEX IF NOT EXISTS idx_decisions_archived ON decisions(archived_at);
CREATE INDEX IF NOT EXISTS idx_learnings_archived ON learnings(archived_at);
CREATE INDEX IF NOT EXISTS idx_errors_archived ON errors(archived_at);
```

### Schritt 3: Migration in initSchema() einfuegen

Den Block `if (!current || current.version < SCHEMA_VERSION)` ersetzen durch:

```typescript
  if (!current || current.version < SCHEMA_VERSION) {
    // Migration v1 auf v2: Access-Counter und Archivierung
    if (!current || current.version < 2) {
      const migrations = [
        'ALTER TABLE decisions ADD COLUMN access_count INTEGER DEFAULT 0',
        'ALTER TABLE decisions ADD COLUMN last_accessed TEXT',
        'ALTER TABLE decisions ADD COLUMN archived_at TEXT',
        'ALTER TABLE learnings ADD COLUMN access_count INTEGER DEFAULT 0',
        'ALTER TABLE learnings ADD COLUMN last_accessed TEXT',
        'ALTER TABLE learnings ADD COLUMN archived_at TEXT',
        'ALTER TABLE errors ADD COLUMN access_count INTEGER DEFAULT 0',
        'ALTER TABLE errors ADD COLUMN last_accessed TEXT',
        'ALTER TABLE errors ADD COLUMN archived_at TEXT',
      ];
      for (const sql of migrations) {
        try { database.exec(sql); } catch { /* Spalte existiert bereits */ }
      }
    }
    database.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
```

### Schritt 4: Build pruefen

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
```

Erwartet: kein Fehler.

### Schritt 5: Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/db.ts server/dist/ && git commit -m "feat(schema): add access_count, last_accessed, archived_at columns (v2)"
```

---

## Task 2: decisions.ts — Access-Counter + Filter + Pruning

**File:** `server/src/modules/decisions.ts`

### Schritt 1: Decision Interface erweitern

Nach `confidence: string;` hinzufuegen:
```typescript
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
```

### Schritt 2: getDecision() erweitern — zaehlen beim Lesen

Die Funktion komplett ersetzen:
```typescript
export function getDecision(id: number): Decision | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('UPDATE decisions SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
  return {
    ...row,
    alternatives: parseJson<Alternative[]>(row.alternatives as string),
    files_affected: parseJson<string[]>(row.files_affected as string),
  } as Decision;
}
```

### Schritt 3: listDecisions() — archivierte ausblenden

Am Anfang von `listDecisions()`, direkt nach `const conditions: string[] = [];`:
```typescript
  conditions.push('archived_at IS NULL');
```

### Schritt 4: runDecisionsPruning() am Ende der Datei ergaenzen

```typescript
export interface DecisionPruningResult {
  decisions_archived: number;
}

export function runDecisionsPruning(): DecisionPruningResult {
  const db = getDb();
  const result = db.prepare(`
    UPDATE decisions
    SET archived_at = ?
    WHERE archived_at IS NULL
      AND superseded_by IS NULL
      AND (
        (created_at < datetime('now', '-90 days') AND access_count = 0)
        OR
        (created_at < datetime('now', '-365 days') AND access_count < 3)
      )
  `).run(now());
  return { decisions_archived: Number(result.changes) };
}
```

### Schritt 5: Build + Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/modules/decisions.ts server/dist/ && git commit -m "feat(decisions): access_count tracking, archived_at filter, pruning logic"
```

---

## Task 3: learnings.ts — Access-Counter + Filter + Pruning

**File:** `server/src/modules/learnings.ts`

### Schritt 1: Learning Interface erweitern

Nach `auto_block: boolean;` hinzufuegen:
```typescript
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
```

### Schritt 2: getLearning() erweitern

```typescript
export function getLearning(id: number): Learning | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('UPDATE learnings SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
  return { ...row, auto_block: Boolean(row.auto_block) } as unknown as Learning;
}
```

### Schritt 3: listLearnings() — archivierte ausblenden

Am Anfang von `listLearnings()`, direkt nach `const conditions: string[] = [];`:
```typescript
  conditions.push('archived_at IS NULL');
```

### Schritt 4: getAutoBlockLearnings() — archivierte ausblenden

SQL-Query aendern:
```typescript
  const rows = db.prepare('SELECT * FROM learnings WHERE auto_block = 1 AND archived_at IS NULL').all() as Record<string, unknown>[];
```

### Schritt 5: runLearningsPruning() am Ende ergaenzen

```typescript
export interface LearningPruningResult {
  learnings_archived: number;
}

export function runLearningsPruning(): LearningPruningResult {
  const db = getDb();
  // auto_block = 1 wird NIEMALS archiviert
  const result = db.prepare(`
    UPDATE learnings
    SET archived_at = ?
    WHERE archived_at IS NULL
      AND auto_block = 0
      AND (
        (created_at < datetime('now', '-90 days') AND access_count = 0)
        OR
        (created_at < datetime('now', '-365 days') AND access_count < 3)
      )
  `).run(now());
  return { learnings_archived: Number(result.changes) };
}
```

### Schritt 6: Build + Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/modules/learnings.ts server/dist/ && git commit -m "feat(learnings): access_count tracking, archived_at filter, Ebbinghaus pruning"
```

---

## Task 4: errors.ts — Access-Counter + Filter + Pruning

**File:** `server/src/modules/errors.ts`

### Schritt 1: CortexError Interface erweitern

Nach `severity: string;` hinzufuegen:
```typescript
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
```

### Schritt 2: getError() erweitern

```typescript
export function getError(id: number): CortexError | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM errors WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('UPDATE errors SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
  return {
    ...row,
    files_involved: parseJson<string[]>(row.files_involved as string),
  } as CortexError;
}
```

### Schritt 3: listErrors() — archivierte ausblenden

Am Anfang von `listErrors()`, direkt nach `const conditions: string[] = [];`:
```typescript
  conditions.push('archived_at IS NULL');
```

### Schritt 4: runErrorsPruning() am Ende ergaenzen

```typescript
export interface ErrorPruningResult {
  errors_archived: number;
}

export function runErrorsPruning(): ErrorPruningResult {
  const db = getDb();
  const result = db.prepare(`
    UPDATE errors
    SET archived_at = ?
    WHERE archived_at IS NULL
      AND (
        (first_seen < datetime('now', '-90 days') AND access_count = 0)
        OR
        (first_seen < datetime('now', '-365 days') AND access_count < 3)
      )
  `).run(now());
  return { errors_archived: Number(result.changes) };
}
```

### Schritt 5: Build + Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/modules/errors.ts server/dist/ && git commit -m "feat(errors): access_count tracking, archived_at filter, pruning logic"
```

---

## Task 5: index.ts — runAllPruning + cortex_run_pruning + auto-pruning

**File:** `server/src/index.ts`

### Schritt 1: runAllPruning() Helper vor dem McpServer einfuegen

Direkt nach den Import-Statements (nach ca. Zeile 14), vor `const server = new McpServer(...)`:

```typescript
function runAllPruning(): { decisions_archived: number; learnings_archived: number; errors_archived: number } {
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

### Schritt 2: cortex_save_session — auto-pruning bei Session-Start

In der `cortex_save_session` Handler-Funktion, direkt nach `sessions.createSession({ id: session_id });`:

```typescript
    // Auto-pruning beim Session-Start (Ebbinghaus-Forgetting-Curve)
    if (!status || status === 'active') {
      try { runAllPruning(); } catch { /* Pruning-Fehler blockieren Session-Start nicht */ }
    }
```

### Schritt 3: cortex_run_pruning Tool nach cortex_list_sessions Block einfuegen

```typescript
server.tool(
  'cortex_run_pruning',
  'Manually run Ebbinghaus pruning — archives unused decisions/learnings/errors. Runs automatically on session start.',
  {},
  async () => {
    getDb();
    const result = runAllPruning();
    const total = result.decisions_archived + result.learnings_archived + result.errors_archived;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          archived: result,
          total_archived: total,
          message: total > 0
            ? `${total} item(s) archived based on Ebbinghaus forgetting curve.`
            : 'Nothing to archive -- all items are fresh or recently accessed.',
        }, null, 2),
      }],
    };
  }
);
```

### Schritt 4: Build + Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/index.ts server/dist/ && git commit -m "feat(index): cortex_run_pruning tool + auto-pruning on session start"
```

---

## Task 6: Recency-Gradient im cortex_snapshot

**File:** `server/src/index.ts`

### Schritt 1: Den "Last 3 sessions" Block im Snapshot ersetzen

Den aktuellen Block suchen (ca. Zeile 1083):
```typescript
    // Last 3 sessions
    try {
      const recent = db.prepare(`SELECT started_at, summary FROM sessions WHERE status='completed' AND summary IS NOT NULL ORDER BY started_at DESC LIMIT 3`).all() as any[];
      if (recent.length > 0) {
        md.push('');
        md.push('## Recent Sessions');
        for (const s of recent) md.push(`- [${s.started_at?.slice(0,10)}] ${s.summary}`);
      }
    } catch {}
```

Ersetzen durch:
```typescript
    // Recency-Gradient: letzte 3 Sessions vollstaendig, aeltere komprimiert
    try {
      const recent = db.prepare(`
        SELECT id, started_at, summary, key_changes FROM sessions
        WHERE status='completed' AND summary IS NOT NULL
        ORDER BY started_at DESC LIMIT 10
      `).all() as any[];

      if (recent.length > 0) {
        md.push('');
        md.push('## Recent Sessions');
        for (let i = 0; i < recent.length; i++) {
          const s = recent[i];
          const date = s.started_at?.slice(0, 10) ?? '?';
          if (i < 3) {
            md.push(`- [${date}] ${s.summary}`);
            if (s.key_changes) {
              try {
                const changes = JSON.parse(s.key_changes) as Array<{ file: string; action: string; description: string }>;
                for (const c of changes.slice(0, 3)) {
                  md.push(`  - ${c.action}: ${c.file} -- ${c.description}`);
                }
              } catch {}
            }
          } else {
            const summary = s.summary ?? '';
            md.push(`- [${date}] ${summary.slice(0, 80)}${summary.length > 80 ? '...' : ''}`);
          }
        }
      }
    } catch {}

    // Recency-Gradient: Decisions letzte 7 Tage vollstaendig, aeltere nur Anzahl
    try {
      const recentDecisions = db.prepare(`
        SELECT id, title, category, reasoning FROM decisions
        WHERE archived_at IS NULL AND superseded_by IS NULL
          AND created_at > datetime('now', '-7 days')
        ORDER BY created_at DESC LIMIT 5
      `).all() as any[];

      const olderDecisionsCount = (db.prepare(`
        SELECT COUNT(*) as c FROM decisions
        WHERE archived_at IS NULL AND superseded_by IS NULL
          AND created_at <= datetime('now', '-7 days')
      `).get() as any)?.c ?? 0;

      if (recentDecisions.length > 0 || olderDecisionsCount > 0) {
        md.push('');
        md.push('## Decisions');
        for (const d of recentDecisions) {
          const r = d.reasoning ?? '';
          md.push(`- [${d.category}] **${d.title}** -- ${r.slice(0, 100)}${r.length > 100 ? '...' : ''}`);
        }
        if (olderDecisionsCount > 0) {
          md.push(`- _(+ ${olderDecisionsCount} older -- use cortex_list_decisions to view)_`);
        }
      }
    } catch {}

    // Recency-Gradient: Learnings letzte 7 Tage + auto_block immer
    try {
      const autoBlocks = db.prepare(`
        SELECT anti_pattern, correct_pattern FROM learnings
        WHERE auto_block = 1 AND archived_at IS NULL
      `).all() as any[];

      const recentLearnings = db.prepare(`
        SELECT anti_pattern, correct_pattern, severity FROM learnings
        WHERE auto_block = 0 AND archived_at IS NULL
          AND created_at > datetime('now', '-7 days')
        ORDER BY created_at DESC LIMIT 5
      `).all() as any[];

      const olderLearningsCount = (db.prepare(`
        SELECT COUNT(*) as c FROM learnings
        WHERE auto_block = 0 AND archived_at IS NULL
          AND created_at <= datetime('now', '-7 days')
      `).get() as any)?.c ?? 0;

      if (autoBlocks.length > 0 || recentLearnings.length > 0 || olderLearningsCount > 0) {
        md.push('');
        md.push('## Learnings');
        if (autoBlocks.length > 0) {
          md.push('**Auto-Block Rules:**');
          for (const l of autoBlocks) {
            md.push(`- NEVER: ${l.anti_pattern} -- DO: ${l.correct_pattern}`);
          }
        }
        for (const l of recentLearnings) {
          md.push(`- [${l.severity}] ${l.anti_pattern} -- ${l.correct_pattern}`);
        }
        if (olderLearningsCount > 0) {
          md.push(`- _(+ ${olderLearningsCount} older -- use cortex_list_learnings to view)_`);
        }
      }
    } catch {}
```

### Schritt 2: Build + Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/index.ts server/dist/ && git commit -m "feat(snapshot): recency-gradient -- full context last 3 sessions, decisions/learnings tiered by 7-day freshness"
```

---

## Task 7: cortex_get_access_stats Tool

**File:** `server/src/index.ts`

### Schritt 1: Neues Tool nach cortex_run_pruning einfuegen

```typescript
server.tool(
  'cortex_get_access_stats',
  'Show top accessed decisions, learnings and errors -- what gets used most',
  {},
  async () => {
    const db = getDb();
    const topDecisions = db.prepare(`
      SELECT id, title, category, access_count, last_accessed
      FROM decisions WHERE archived_at IS NULL
      ORDER BY access_count DESC LIMIT 10
    `).all() as any[];

    const topLearnings = db.prepare(`
      SELECT id, anti_pattern, severity, access_count, last_accessed
      FROM learnings WHERE archived_at IS NULL
      ORDER BY access_count DESC LIMIT 10
    `).all() as any[];

    const topErrors = db.prepare(`
      SELECT id, error_message, severity, access_count, last_accessed
      FROM errors WHERE archived_at IS NULL
      ORDER BY access_count DESC LIMIT 10
    `).all() as any[];

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ top_decisions: topDecisions, top_learnings: topLearnings, top_errors: topErrors }, null, 2),
      }],
    };
  }
);
```

### Schritt 2: Build + Commit

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
cd /c/Users/toasted/Desktop/data/cortex && git add server/src/index.ts server/dist/ && git commit -m "feat(index): add cortex_get_access_stats tool"
```

---

## Task 8: Abschluss-Verifikation

### Schritt 1: Finaler Build

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
```

### Schritt 2: Git Log

```bash
cd /c/Users/toasted/Desktop/data/cortex && git log --oneline -8
```

Erwartet: 7 neue Feature-Commits.

### Schritt 3: Dem User mitteilen

Bitte Claude Code neu starten damit der aktualisierte Cortex-Server mit Schema-v2 geladen wird.

### Schritt 4: Nach Neustart testen

- `cortex_snapshot` -- pruefe ob Decisions/Learnings-Sections mit Recency-Gradient erscheinen
- `cortex_run_pruning` -- sollte `total_archived: 0` zurueckgeben (DB ist frisch)
- `cortex_get_access_stats` -- sollte leere Listen zurueckgeben (noch keine Zugriffe getrackt)
