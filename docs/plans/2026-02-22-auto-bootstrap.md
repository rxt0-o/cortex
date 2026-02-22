# Auto-Bootstrap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatisch `import_git_history`, `scan_project` und `index_docs` ausführen wenn Cortex in ein Projekt mit leerer DB installiert wird.

**Architecture:** SessionStart-Hook prüft `project_files` Count, setzt meta-Flag. Daemon liest Flag beim Start und dispatcht Bootstrap-Agent via `claude -p` mit MCP-Tools. Nach Erfolg wird Flag gelöscht.

**Tech Stack:** Node.js (Hook-Scripts), TypeScript (Daemon), SQLite (`node:sqlite`), `claude -p` Subprozess

---

### Task 1: Bootstrap-Trigger im SessionStart-Hook

**Files:**
- Modify: `scripts/on-session-start.js:99-103` (nach `openDb()`, vor Compact-Branch)

**Step 1: Bootstrap-Check + Flag einfügen**

In `on-session-start.js`, direkt nach `const db = openDb(cwd);` (Zeile 99) und vor dem Compact-Branch (Zeile 106), folgenden Block einfügen:

```js
// Auto-Bootstrap: Flag setzen wenn DB quasi leer
try {
  const filesTracked = db.prepare(`SELECT COUNT(*) as c FROM project_files`).get()?.c ?? 0;
  if (filesTracked < 10) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('needs_bootstrap', 'true') ON CONFLICT(key) DO NOTHING`).run();
  }
} catch { /* ignore */ }
```

`ON CONFLICT DO NOTHING` stellt sicher, dass das Flag nicht überschrieben wird wenn der Daemon es bereits verarbeitet.

**Step 2: Dashboard-Hinweis einfügen**

In der Dashboard-Ausgabe (nach den `parts`-Blocks, ca. Zeile 280), vor dem Health-Block:

```js
// Bootstrap-Hinweis
try {
  const needsBootstrap = db.prepare(`SELECT value FROM meta WHERE key='needs_bootstrap'`).get();
  if (needsBootstrap) {
    parts.push('');
    parts.push('BOOTSTRAP: Erstmalige Indexierung laeuft im Hintergrund...');
  }
} catch {}
```

**Step 3: Commit**

```bash
git add scripts/on-session-start.js
git commit -m "feat: Auto-Bootstrap Trigger im SessionStart-Hook"
```

---

### Task 2: Bootstrap-Agent erstellen

**Files:**
- Create: `daemon/src/agents/bootstrap.ts`

**Step 1: Agent-Datei erstellen**

```typescript
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

export async function runBootstrapAgent(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);
  try {
    const flag = db.prepare(`SELECT value FROM meta WHERE key='needs_bootstrap'`).get();
    if (!flag || flag.value !== 'true') return;
    process.stdout.write('[cortex-daemon] Bootstrap: DB quasi leer, starte Erstindexierung...\n');
  } finally {
    db.close();
  }

  const prompt = `Du bist ein Setup-Agent fuer Cortex. Fuehre diese 3 MCP-Tools nacheinander aus:

1. cortex_import_git_history mit max_commits: 200
2. cortex_scan_project
3. cortex_index_docs

Fuehre alle 3 aus und berichte kurz was importiert wurde. Keine weiteren Aktionen.`;

  const result = await runClaudeAgent({
    prompt,
    projectPath,
    timeoutMs: 120_000,
    agentName: 'bootstrap',
  });

  if (result.success) {
    const db2 = new DatabaseSync(dbPath);
    try {
      db2.prepare(`UPDATE meta SET value='done' WHERE key='needs_bootstrap'`).run();
      process.stdout.write('[cortex-daemon] Bootstrap: Erfolgreich abgeschlossen\n');
    } finally {
      db2.close();
    }
  } else {
    process.stderr.write(`[cortex-daemon] Bootstrap: Fehlgeschlagen — ${result.error?.slice(0, 200) ?? 'unknown'}\n`);
  }
}
```

**Step 2: Commit**

```bash
git add daemon/src/agents/bootstrap.ts
git commit -m "feat: Bootstrap-Agent — import_git_history + scan_project + index_docs"
```

---

### Task 3: Bootstrap-Agent im Daemon registrieren

**Files:**
- Modify: `daemon/src/index.ts:1-12` (Import hinzufügen)
- Modify: `daemon/src/index.ts:50-53` (nach runArchitectAgent dispatchen)

**Step 1: Import hinzufügen**

In `daemon/src/index.ts`, nach den bestehenden Imports (Zeile 12):

```typescript
import { runBootstrapAgent } from './agents/bootstrap.js';
```

**Step 2: Bootstrap nach Architect dispatchen**

In `daemon/src/index.ts`, nach dem `runArchitectAgent` Block (Zeile 51-53):

```typescript
// Auto-Bootstrap: DB fuellen wenn quasi leer
runBootstrapAgent(projectPath).catch(err => {
  process.stderr.write(`[cortex-daemon] Bootstrap error: ${err}\n`);
});
```

**Step 3: Daemon bauen**

```bash
cd daemon && npm run build
```

**Step 4: Commit**

```bash
git add daemon/src/index.ts daemon/src/agents/bootstrap.ts daemon/dist/
git commit -m "feat: Bootstrap-Agent im Daemon registrieren + build"
```

---

### Task 4: Manueller Test

**Step 1: Prüfen ob Flag korrekt gesetzt wird**

In einem Testprojekt mit leerer DB: `project_files` Count = 0 und meta `needs_bootstrap` = `true` nach SessionStart.

**Step 2: Prüfen ob Daemon Bootstrap ausführt**

Daemon-Logs prüfen auf:
```
[cortex-daemon] Bootstrap: DB quasi leer, starte Erstindexierung...
[cortex-daemon] Bootstrap: Erfolgreich abgeschlossen
```

**Step 3: Prüfen ob Flag nach Erfolg auf 'done' gesetzt wird**

`project_files` Count > 10 und meta `needs_bootstrap` = `done`.

---

### Task 5: Abschluss

**Step 1: Cortex Unfinished auflösen** — `cortex_resolve_unfinished(id=15)`

**Step 2: Decision loggen** — `cortex_add_decision: "Auto-Bootstrap via SessionStart-Flag + Daemon-Agent"`

**Step 3: Push** — `git push origin main`
