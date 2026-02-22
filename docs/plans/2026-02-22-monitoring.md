# Cortex Monitoring-Erweiterung — Implementierungsplan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Daemon-Heartbeat mit externem Watcher-Prozess, Session-Metriken via OTEL, und Agent-Health-Monitoring in Cortex einbauen.

**Architecture:** Drei unabhängige Features: (1) Watcher-Prozess überwacht Daemon via Heartbeat-Datei und startet ihn bei Absturz neu. (2) on-session-end.js liest OTEL-JSONL und speichert Token/Kosten-Metriken in DB. (3) runner.ts loggt jeden Agent-Lauf mit Dauer und Erfolg in agent_runs-Tabelle.

**Tech Stack:** Node.js (scripts), TypeScript (daemon + server), node:sqlite, Zod, esbuild

---

## Task 1: DB-Schema — zwei neue Tabellen

**Files:**
- Modify: `scripts/ensure-db.js`

**Kontext:** Migrationen werden in `openDb()` am Ende des `v04migrations`-Arrays hinzugefügt. Jede Migration in eigenem try/catch. Schema-Änderungen **nur** in `ensure-db.js`, nie im Server.

**Step 1: Migrationen ans Ende des v04migrations-Arrays anhängen**

Direkt vor der schließenden `];` Zeile (aktuell Zeile ~168) einfügen:

```js
    `CREATE TABLE IF NOT EXISTS session_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL,
      duration_ms INTEGER,
      recorded_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_metrics_session ON session_metrics(session_id)`,
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      items_saved INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_name)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at)`,
```

**Step 2: Testen**

```bash
node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb('.'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name).join(', ')); db.close(); })"
```

Erwartete Ausgabe: enthält `session_metrics` und `agent_runs`

**Step 3: Commit**

```bash
git add scripts/ensure-db.js
git commit -m "feat: DB-Schema — session_metrics + agent_runs Tabellen"
```

---

## Task 2: Daemon Heartbeat

**Files:**
- Modify: `daemon/src/index.ts`

**Kontext:** Daemon schreibt alle 30s den aktuellen Unix-Timestamp (ms) in `.claude/cortex-daemon.heartbeat`. Beim sauberen Stop: Datei löschen.

**Step 1: Import ergänzen**

Am Anfang von `daemon/src/index.ts`, den bestehenden Import erweitern:

```typescript
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
```

→ `writeFileSync` ist bereits importiert. `readFileSync` prüfen ob vorhanden — wenn nicht ergänzen.

**Step 2: Heartbeat-Konstante und Intervall hinzufügen**

Nach der `pidPath`-Definition (Zeile ~21) einfügen:

```typescript
const heartbeatPath = join(projectPath, '.claude', 'cortex-daemon.heartbeat');

// Heartbeat alle 30s schreiben
setInterval(() => {
  try { writeFileSync(heartbeatPath, String(Date.now()), 'utf-8'); } catch { /* ignore */ }
}, 30_000);
// Einmalig sofort schreiben
try { writeFileSync(heartbeatPath, String(Date.now()), 'utf-8'); } catch { /* ignore */ }
```

**Step 3: Heartbeat beim Stop löschen**

In der `cleanup()`-Funktion ergänzen:

```typescript
function cleanup(): void {
  try { unlinkSync(pidPath); } catch { /* bereits geloescht */ }
  try { unlinkSync(heartbeatPath); } catch { /* ignore */ }
  process.stdout.write('[cortex-daemon] Stopped\n');
}
```

**Step 4: Bauen und prüfen**

```bash
cd daemon && npm run build 2>&1
```

Erwartete Ausgabe: `tsc` ohne Fehler

**Step 5: Commit**

```bash
git add daemon/src/index.ts daemon/dist/
git commit -m "feat: daemon heartbeat — schreibt alle 30s timestamp in .heartbeat-Datei"
```

---

## Task 3: Watcher-Prozess

**Files:**
- Create: `daemon/src/watcher.ts`
- Modify: `daemon/package.json`

**Kontext:** Watcher ist ein separater, minimaler Node.js-Prozess. Kein Claude-Aufruf. Pollt alle 15s die Heartbeat-Datei. Falls Timestamp >90s alt oder Datei fehlt → Daemon-PID prüfen, falls tot → Daemon neu starten.

**Step 1: `daemon/src/watcher.ts` erstellen**

```typescript
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const args = process.argv.slice(2);
const projectIdx = args.indexOf('--project');
if (projectIdx === -1 || !args[projectIdx + 1]) {
  process.stderr.write('[cortex-watcher] Missing --project argument\n');
  process.exit(1);
}
const projectPath = args[projectIdx + 1];
const watcherPidPath = join(projectPath, '.claude', 'cortex-watcher.pid');
const daemonPidPath  = join(projectPath, '.claude', 'cortex-daemon.pid');
const heartbeatPath  = join(projectPath, '.claude', 'cortex-daemon.heartbeat');
const daemonScript   = join(__dirname, 'index.js');

// Eigene PID schreiben
try {
  writeFileSync(watcherPidPath, String(process.pid), 'utf-8');
  process.stdout.write(`[cortex-watcher] Started (PID ${process.pid})\n`);
} catch (err) {
  process.stderr.write(`[cortex-watcher] Could not write PID: ${err}\n`);
  process.exit(1);
}

function cleanup(): void {
  try { unlinkSync(watcherPidPath); } catch { /* ignore */ }
}
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('exit',    () => { try { unlinkSync(watcherPidPath); } catch { /* ignore */ } });

function isDaemonAlive(): boolean {
  if (!existsSync(daemonPidPath)) return false;
  try {
    const pid = parseInt(readFileSync(daemonPidPath, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDaemon(): void {
  try {
    const proc = spawn('node', [daemonScript, '--project', projectPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true,
    });
    proc.unref();
    process.stdout.write('[cortex-watcher] Daemon restarted\n');
  } catch (err) {
    process.stderr.write(`[cortex-watcher] Could not restart daemon: ${err}\n`);
  }
}

function check(): void {
  const heartbeatOk = (() => {
    if (!existsSync(heartbeatPath)) return false;
    try {
      const ts = parseInt(readFileSync(heartbeatPath, 'utf-8').trim(), 10);
      return (Date.now() - ts) < 90_000;
    } catch { return false; }
  })();

  if (!heartbeatOk && !isDaemonAlive()) {
    process.stdout.write('[cortex-watcher] Daemon unresponsive — restarting\n');
    startDaemon();
  }
}

// Sofort + alle 15s prüfen
check();
setInterval(check, 15_000);
process.stdout.write('[cortex-watcher] Watching daemon...\n');
```

**Step 2: `daemon/package.json` — zweites Build-Target**

Aktuell hat `package.json` einen `build`-Script. Ein zweites Entry-Point für den Watcher hinzufügen. `tsconfig.json` prüfen und wenn nötig anpassen:

```bash
cat daemon/package.json
cat daemon/tsconfig.json
```

Dann in `package.json` den build-script anpassen (falls esbuild genutzt wird) oder `tsconfig.json` so lassen dass beide Dateien kompiliert werden. Bei `tsc` werden automatisch alle `.ts`-Dateien in `src/` kompiliert — kein extra Schritt nötig.

**Step 3: Bauen**

```bash
cd daemon && npm run build 2>&1
```

Erwartete Ausgabe: kein Fehler, `daemon/dist/watcher.js` existiert

```bash
ls daemon/dist/watcher.js
```

**Step 4: Commit**

```bash
git add daemon/src/watcher.ts daemon/dist/
git commit -m "feat: cortex-watcher — externer Prozess der Daemon-Heartbeat überwacht und neu startet"
```

---

## Task 4: on-session-start.js — Watcher starten

**Files:**
- Modify: `scripts/on-session-start.js`

**Kontext:** Analog zur bestehenden `ensureDaemonRunning()`-Funktion. PID-File prüfen, falls Watcher bereits läuft → skip, sonst starten.

**Step 1: `ensureWatcherRunning()`-Funktion hinzufügen**

Nach der `ensureDaemonRunning()`-Funktion (Zeile ~61) einfügen:

```js
function ensureWatcherRunning(cwd) {
  try {
    const pidPath = join(cwd, '.claude', 'cortex-watcher.pid');
    const watcherScript = join(__dirname, '..', 'daemon', 'dist', 'watcher.js');

    if (!existsSync(watcherScript)) return; // Watcher nicht gebaut

    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        return; // Watcher läuft bereits
      } catch {
        try { unlinkSync(pidPath); } catch { /* ignore */ }
      }
    }

    const watcher = spawn('node', [watcherScript, '--project', cwd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true,
    });
    watcher.unref();
  } catch { /* nicht kritisch */ }
}
```

**Step 2: Watcher im `main()` aufrufen**

Im `main()`, direkt nach `ensureDaemonRunning(cwd)` (Zeile ~69):

```js
if (!isCompact) ensureDaemonRunning(cwd);
if (!isCompact) ensureWatcherRunning(cwd);
```

**Step 3: Testen (manuell)**

```bash
node scripts/on-session-start.js <<< '{"session_id":"test","cwd":"'$(pwd)'","source":"user"}'
```

Prüfen ob `.claude/cortex-watcher.pid` existiert:

```bash
ls .claude/cortex-watcher.pid && echo "OK"
```

**Step 4: Commit**

```bash
git add scripts/on-session-start.js
git commit -m "feat: on-session-start startet cortex-watcher falls nicht laufend"
```

---

## Task 5: Agent Health-Monitoring im runner.ts

**Files:**
- Modify: `daemon/src/runner.ts`

**Kontext:** `RunnerOptions` bekommt optionale Felder `agentName` und `sessionId`. Vor dem Spawn: Eintrag in `agent_runs` anlegen. Nach `proc.on('close')`: Eintrag mit Ergebnis updaten.

**Step 1: DatabaseSync-Import und RunnerOptions erweitern**

Am Anfang von `runner.ts`:

```typescript
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
```

`RunnerOptions` Interface ergänzen:

```typescript
export interface RunnerOptions {
  prompt: string;
  projectPath: string;
  timeoutMs?: number;
  jsonSchema?: object;
  model?: string;
  agentName?: string;   // neu
  sessionId?: string;   // neu
}
```

**Step 2: Helper-Funktionen für agent_runs-Logging**

Nach den Interface-Definitionen, vor der Queue:

```typescript
function logAgentStart(projectPath: string, agentName: string, sessionId?: string): number | null {
  try {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath);
    const result = db.prepare(`
      INSERT INTO agent_runs (agent_name, session_id, started_at, success)
      VALUES (?, ?, ?, 0)
    `).run(agentName, sessionId ?? null, new Date().toISOString());
    db.close();
    return result.lastInsertRowid as number;
  } catch { return null; }
}

function logAgentEnd(projectPath: string, runId: number, success: boolean, errorMessage?: string, itemsSaved?: number): void {
  try {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath)) return;
    const db = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE agent_runs
      SET finished_at = ?, success = ?, error_message = ?, items_saved = ?,
          duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
      WHERE id = ?
    `).run(now, success ? 1 : 0, errorMessage ?? null, itemsSaved ?? 0, now, runId);
    db.close();
  } catch { /* ignore */ }
}
```

**Step 3: Logging in runClaudeAgent() einbauen**

In `runClaudeAgent()`, am Anfang des `pendingQueue.push()`-Callbacks:

```typescript
// Agent-Run loggen
const runId = opts.agentName
  ? logAgentStart(opts.projectPath, opts.agentName, opts.sessionId)
  : null;
```

Im `proc.on('close')`-Handler, vor `resolve()`:

```typescript
proc.on('close', (code) => {
  clearTimeout(timer);
  const success = code === 0;
  if (runId !== null) {
    logAgentEnd(opts.projectPath, runId, success, success ? undefined : errOutput.slice(0, 500));
  }
  resolve({ success, output, error: errOutput || undefined });
  processNext();
});
```

Im Timeout-Handler ebenfalls:

```typescript
const timer = setTimeout(() => {
  proc.kill();
  if (runId !== null) {
    logAgentEnd(opts.projectPath, runId, false, `Timeout after ${timeout}ms`);
  }
  resolve({ success: false, output, error: `Timeout after ${timeout}ms` });
  processNext();
}, timeout);
```

**Step 4: Jeden Agent mit agentName aufrufen**

In `daemon/src/agents/learner.ts`, den `runClaudeAgent()`-Aufruf anpassen:

```typescript
const result = await runClaudeAgent({
  prompt,
  projectPath,
  timeoutMs: 120_000,
  jsonSchema: LEARNER_SCHEMA,
  model: 'claude-sonnet-4-6',
  agentName: 'learner',  // neu
});
```

Dasselbe für alle anderen Agents in ihren jeweiligen Dateien:
- `architect.ts` → `agentName: 'architect'`
- `context.ts` → `agentName: 'context'`
- `drift-detector.ts` → `agentName: 'drift-detector'`
- `synthesizerAgent.ts` → `agentName: 'synthesizer'`
- `serendipityAgent.ts` → `agentName: 'serendipity'`
- `moodScorer.ts` → `agentName: 'mood-scorer'`

**Step 5: items_saved zurückgeben und loggen**

In `learner.ts`, den Runner-Aufruf so umstrukturieren dass `saved` nach dem Run in `logAgentEnd` übergeben wird. Da `logAgentEnd` intern aufgerufen wird, reicht es den `items_saved` Wert zu übergeben. Alternativ: `runClaudeAgent` gibt ihn nicht zurück — stattdessen nach dem Run direkt in DB schreiben:

Nach der Analyse-Schleife am Ende von `runLearnerAgent`:

```typescript
// items_saved in den agent_run eintragen (letzte run_id holen)
try {
  const db2 = new DatabaseSync(dbPath);
  db2.prepare(`UPDATE agent_runs SET items_saved = ? WHERE agent_name = 'learner' ORDER BY id DESC LIMIT 1`).run(saved);
  db2.close();
} catch { /* non-critical */ }
```

**Step 6: Bauen**

```bash
cd daemon && npm run build 2>&1
```

Erwartete Ausgabe: kein Fehler

**Step 7: Commit**

```bash
git add daemon/src/runner.ts daemon/src/agents/
git commit -m "feat: agent health-monitoring — runner loggt alle agent_runs in DB"
```

---

## Task 6: Session-Metriken via OTEL

**Files:**
- Modify: `scripts/on-session-end.js`

**Kontext:** Claude Code schreibt OTEL-Spans in `~/.claude/otel-spans.jsonl` (oder via `OTEL_LOG_FILE` env-var). Jeder Span hat `session_id` als Attribut. Wir lesen die Datei, filtern nach session_id, aggregieren Token-Zähler.

**Step 1: OTEL-Datei-Pfad ermitteln**

Am Anfang von `main()` in `on-session-end.js`:

```js
// OTEL-Metriken lesen
async function readOtelMetrics(sessionId) {
  const otelPath = process.env.OTEL_LOG_FILE
    || join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'otel-spans.jsonl');

  if (!existsSync(otelPath)) return null;

  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  let costUsd = 0, durationMs = 0;
  let found = false;

  try {
    const rl = createInterface({ input: createReadStream(otelPath, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const span = JSON.parse(line);
        // Session-ID im Span suchen (attributes oder resource)
        const attrs = span.attributes || span.resource?.attributes || {};
        const spanSession = attrs['session.id'] || attrs['claude.session_id'] || span.session_id;
        if (spanSession !== sessionId) continue;
        found = true;
        inputTokens      += attrs['llm.usage.prompt_tokens']           || attrs['input_tokens']       || 0;
        outputTokens     += attrs['llm.usage.completion_tokens']       || attrs['output_tokens']      || 0;
        cacheReadTokens  += attrs['llm.usage.cache_read_input_tokens'] || attrs['cache_read_tokens']  || 0;
        cacheWriteTokens += attrs['llm.usage.cache_creation_input_tokens'] || attrs['cache_write_tokens'] || 0;
        costUsd          += attrs['llm.usage.cost_usd']                || attrs['cost_usd']           || 0;
        durationMs       += Number(span.duration_ms || 0);
      } catch { /* skip */ }
    }
  } catch { return null; }

  if (!found) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, durationMs };
}
```

**Step 2: Metriken in DB speichern**

Am Ende von `main()`, vor `db.close()`:

```js
// OTEL-Metriken speichern
try {
  const metrics = await readOtelMetrics(session_id);
  if (metrics) {
    db.prepare(`
      INSERT INTO session_metrics
        (session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session_id, metrics.inputTokens, metrics.outputTokens,
      metrics.cacheReadTokens, metrics.cacheWriteTokens,
      metrics.costUsd, metrics.durationMs, new Date().toISOString()
    );
  }
} catch { /* non-critical */ }
```

**Step 3: Commit**

```bash
git add scripts/on-session-end.js
git commit -m "feat: OTEL session-metriken in session_metrics Tabelle speichern"
```

---

## Task 7: MCP-Tools — cortex_session_metrics + cortex_agent_status

**Files:**
- Modify: `server/src/tools/stats.ts`
- Modify: `server/src/index.ts`

**Kontext:** Zwei neue Tools in `stats.ts` registrieren. Dann in `index.ts` sicherstellen dass `registerStatsTools` sie enthält (das ist automatisch der Fall da sie in derselben Funktion stehen).

**Step 1: `cortex_session_metrics` zu stats.ts hinzufügen**

Am Ende von `registerStatsTools()`, vor der schließenden `}`:

```typescript
server.tool(
  'cortex_session_metrics',
  'Show token usage and cost metrics per session',
  {
    limit: z.number().optional().default(10).describe('Number of recent sessions to show. input_examples: [5, 20]'),
    aggregate: z.boolean().optional().default(false).describe('If true, return averages across all sessions instead of per-session list. input_examples: [true]'),
  },
  async ({ limit, aggregate }) => {
    const db = getDb();
    if (aggregate) {
      const row = db.prepare(`
        SELECT
          COUNT(*) as sessions,
          ROUND(AVG(input_tokens), 0) as avg_input_tokens,
          ROUND(AVG(output_tokens), 0) as avg_output_tokens,
          ROUND(AVG(cache_read_tokens), 0) as avg_cache_read,
          ROUND(AVG(cost_usd), 4) as avg_cost_usd,
          ROUND(SUM(cost_usd), 4) as total_cost_usd,
          ROUND(CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(input_tokens + cache_read_tokens), 0) * 100, 1) as cache_hit_rate_pct
        FROM session_metrics
      `).get();
      return { content: [{ type: 'text' as const, text: JSON.stringify(row, null, 2) }] };
    }
    const rows = db.prepare(`
      SELECT sm.*, s.summary
      FROM session_metrics sm
      LEFT JOIN sessions s ON s.id = sm.session_id
      ORDER BY sm.recorded_at DESC
      LIMIT ?
    `).all(limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  'cortex_agent_status',
  'Show daemon agent run history with success rates and errors',
  {
    limit: z.number().optional().default(20).describe('Max number of agent runs to return. input_examples: [10, 50]'),
    agent_name: z.string().optional().describe('Filter by agent name (learner, architect, context, etc.). input_examples: ["learner", "architect"]'),
  },
  async ({ limit, agent_name }) => {
    const db = getDb();
    const whereClause = agent_name ? 'WHERE agent_name = ?' : '';
    const params = agent_name ? [agent_name, limit] : [limit];

    const runs = db.prepare(`
      SELECT * FROM agent_runs
      ${whereClause}
      ORDER BY started_at DESC
      LIMIT ?
    `).all(...params);

    const summary = db.prepare(`
      SELECT agent_name,
        COUNT(*) as total_runs,
        SUM(success) as successful,
        ROUND(AVG(duration_ms), 0) as avg_duration_ms,
        SUM(items_saved) as total_items_saved,
        MAX(started_at) as last_run
      FROM agent_runs
      GROUP BY agent_name
      ORDER BY last_run DESC
    `).all();

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ summary, recent_runs: runs }, null, 2),
      }],
    };
  }
);
```

**Step 2: Bauen**

```bash
cd server && npm run build 2>&1
```

Erwartete Ausgabe: kein Fehler

**Step 3: Commit**

```bash
git add server/src/tools/stats.ts server/dist/
git commit -m "feat: cortex_session_metrics + cortex_agent_status MCP-Tools"
```

---

## Task 8: Abschluss — cortex_get_health erweitern + Decision loggen

**Files:**
- Modify: `server/src/tools/stats.ts` (cortex_get_health)

**Step 1: cortex_get_health um Monitoring-Daten erweitern**

Im bestehenden `cortex_get_health`-Handler, nach der `score`-Berechnung ergänzen:

```typescript
// Agent-Erfolgsrate (letzte 30 Tage)
const db = getDb();
let agentHealth = null;
try {
  agentHealth = db.prepare(`
    SELECT agent_name,
      COUNT(*) as runs,
      ROUND(100.0 * SUM(success) / COUNT(*), 1) as success_rate_pct,
      MAX(CASE WHEN success=0 THEN error_message END) as last_error
    FROM agent_runs
    WHERE started_at > datetime('now', '-30 days')
    GROUP BY agent_name
  `).all();
} catch { /* Tabelle noch nicht vorhanden */ }

// Session-Kosten (letzte 7 Sessions)
let costSummary = null;
try {
  costSummary = db.prepare(`
    SELECT
      COUNT(*) as sessions_with_metrics,
      ROUND(AVG(cost_usd), 4) as avg_cost_usd,
      ROUND(SUM(cost_usd), 4) as total_cost_usd_7d,
      ROUND(CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(input_tokens + cache_read_tokens), 0) * 100, 1) as cache_hit_rate_pct
    FROM session_metrics
    WHERE recorded_at > datetime('now', '-7 days')
  `).get();
} catch { /* Tabelle noch nicht vorhanden */ }
```

Dann in den Return-Wert einfügen:

```typescript
text: JSON.stringify({
  currentScore: score,
  metrics,
  latestSnapshot: snapshot,
  recentHistory: history,
  agentHealth,   // neu
  costSummary,   // neu
}, null, 2),
```

**Step 2: Bauen**

```bash
cd server && npm run build 2>&1
```

**Step 3: Decision loggen**

```
cortex_add_decision: "Daemon Heartbeat + Watcher Pattern"
reasoning: "Externer Watcher-Prozess überwacht Daemon via Heartbeat-Datei und startet ihn bei Absturz neu. Watcher selbst ist bewusst minimal (kein Claude-Aufruf). Session-Metriken via OTEL-JSONL, Agent-Health via agent_runs-Tabelle."
category: "architecture"
```

**Step 4: Final-Commit**

```bash
cd server && git add server/src/tools/stats.ts server/dist/
git commit -m "feat: cortex_get_health — agent-health + cost-summary Block"
```

---

## Zusammenfassung der Commits

1. `feat: DB-Schema — session_metrics + agent_runs Tabellen`
2. `feat: daemon heartbeat — schreibt alle 30s timestamp in .heartbeat-Datei`
3. `feat: cortex-watcher — externer Prozess der Daemon-Heartbeat überwacht und neu startet`
4. `feat: on-session-start startet cortex-watcher falls nicht laufend`
5. `feat: agent health-monitoring — runner loggt alle agent_runs in DB`
6. `feat: OTEL session-metriken in session_metrics Tabelle speichern`
7. `feat: cortex_session_metrics + cortex_agent_status MCP-Tools`
8. `feat: cortex_get_health — agent-health + cost-summary Block`
