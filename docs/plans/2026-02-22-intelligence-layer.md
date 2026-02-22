# Cortex Intelligence Layer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** KI-basierte Intent-Prediction und automatische Daten-Pipeline fuer smarten Session-Start-Kontext.

**Architecture:** Neuer PatternAgent (Daemon) analysiert bei session_end Arbeits-Patterns (File-Cluster, Task-Sequenzen, Time-Patterns) und speichert sie in `work_patterns`-Tabelle. Intent-Prediction wird pre-computed und bei naechstem Session-Start im Dashboard angezeigt. Learner-Agent wird um Convention-Extraktion erweitert.

**Tech Stack:** TypeScript (Daemon), plain JS (Hooks), node:sqlite, Claude Haiku/Sonnet via `runClaudeAgent()`

**Design-Doc:** `docs/plans/2026-02-22-intelligence-layer-design.md`

---

### Task 1: DB-Schema — work_patterns Tabelle + cluster_id Spalte

**Files:**
- Modify: `scripts/ensure-db.js:95-193` (v04migrations Array)

**Step 1: Migration hinzufuegen**

Am Ende des `v04migrations`-Arrays in `scripts/ensure-db.js` diese Eintraege anfuegen:

```javascript
// Intelligence Layer
`CREATE TABLE IF NOT EXISTS work_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT NOT NULL,
  pattern_data TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  occurrences INTEGER DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  decay_rate REAL DEFAULT 0.95
)`,
`CREATE INDEX IF NOT EXISTS idx_work_patterns_type ON work_patterns(pattern_type)`,
`CREATE INDEX IF NOT EXISTS idx_work_patterns_confidence ON work_patterns(confidence)`,
`ALTER TABLE project_files ADD COLUMN cluster_id INTEGER`,
```

**Step 2: Testen**

Run: `node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb('.'); db.prepare('SELECT * FROM work_patterns LIMIT 1').all(); console.log('OK'); db.close(); })"`
Expected: `OK` (leere Tabelle, kein Fehler)

**Step 3: Commit**

```bash
git add scripts/ensure-db.js
git commit -m "feat: work_patterns Tabelle + cluster_id Migration fuer Intelligence Layer"
```

---

### Task 2: PatternAgent — Grundgeruest + File-Cluster-Erkennung

**Files:**
- Create: `daemon/src/agents/patternAgent.ts`

**Step 1: PatternAgent Grundgeruest erstellen**

Datei `daemon/src/agents/patternAgent.ts`:

```typescript
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent, buildAgentContext, formatAgentContext } from '../runner.js';

interface WorkPattern {
  id?: number;
  pattern_type: string;
  pattern_data: string; // JSON
  confidence: number;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  decay_rate: number;
}

interface SessionDiffs {
  session_id: string;
  started_at: string;
  summary: string | null;
  files: string[];
}

// Jaccard-Similarity: |A ∩ B| / |A ∪ B|
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) { if (b.has(item)) intersection++; }
  return intersection / (a.size + b.size - intersection);
}

function applyDecay(db: DatabaseSync): void {
  const ts = new Date().toISOString();
  // Decay alle Patterns basierend auf Tagen seit last_seen
  db.prepare(`
    UPDATE work_patterns
    SET confidence = confidence * POWER(decay_rate, MAX(1, julianday('now') - julianday(last_seen)))
    WHERE confidence > 0.01
  `).run();
  // Archivieren wenn confidence zu niedrig
  db.prepare(`DELETE FROM work_patterns WHERE confidence < 0.05`).run();
}

function updateFileCluster(db: DatabaseSync, recentSessions: SessionDiffs[]): void {
  if (recentSessions.length < 2) return;
  const ts = new Date().toISOString();

  // Fuer jede Session-Kombination: File-Overlap pruefen
  for (let i = 0; i < recentSessions.length; i++) {
    for (let j = i + 1; j < recentSessions.length; j++) {
      const setA = new Set(recentSessions[i].files);
      const setB = new Set(recentSessions[j].files);
      const similarity = jaccardSimilarity(setA, setB);

      if (similarity < 0.3) continue; // Zu wenig Overlap

      // Union der Files als Cluster
      const clusterFiles = [...new Set([...setA, ...setB])].sort();
      const clusterKey = clusterFiles.join('|');

      // Existierendes Pattern suchen
      const existing = db.prepare(`
        SELECT id, confidence, occurrences, pattern_data FROM work_patterns
        WHERE pattern_type = 'file_cluster'
      `).all() as Array<{ id: number; confidence: number; occurrences: number; pattern_data: string }>;

      let matched = false;
      for (const p of existing) {
        try {
          const data = JSON.parse(p.pattern_data);
          const existingFiles = new Set(data.files as string[]);
          if (jaccardSimilarity(new Set(clusterFiles), existingFiles) > 0.6) {
            // Bestehendes Cluster staerken
            const mergedFiles = [...new Set([...existingFiles, ...clusterFiles])].sort();
            db.prepare(`
              UPDATE work_patterns
              SET confidence = MIN(1.0, confidence + 0.1),
                  occurrences = occurrences + 1,
                  last_seen = ?,
                  pattern_data = ?
              WHERE id = ?
            `).run(ts, JSON.stringify({ files: mergedFiles, similarity }), p.id);
            matched = true;
            break;
          }
        } catch { continue; }
      }

      if (!matched && clusterFiles.length >= 2 && clusterFiles.length <= 15) {
        db.prepare(`
          INSERT INTO work_patterns (pattern_type, pattern_data, confidence, first_seen, last_seen)
          VALUES ('file_cluster', ?, ?, ?, ?)
        `).run(JSON.stringify({ files: clusterFiles, similarity }), similarity, ts, ts);
      }
    }
  }
}

export async function runPatternAgent(projectPath: string, sessionId?: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Letzte 5 Sessions mit ihren Diffs laden
    const sessions = db.prepare(`
      SELECT s.id, s.started_at, s.summary,
        GROUP_CONCAT(DISTINCT d.file_path) as files
      FROM sessions s
      LEFT JOIN diffs d ON d.session_id = s.id
      WHERE s.status != 'active' AND s.summary IS NOT NULL
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 5
    `).all() as Array<{ id: string; started_at: string; summary: string | null; files: string | null }>;

    const recentSessions: SessionDiffs[] = sessions.map(s => ({
      session_id: s.id,
      started_at: s.started_at,
      summary: s.summary,
      files: s.files ? s.files.split(',').filter(Boolean) : [],
    }));

    if (recentSessions.length < 2) {
      process.stdout.write('[cortex-daemon] PatternAgent: not enough sessions yet, skipping\n');
      return;
    }

    // 1. Decay anwenden
    applyDecay(db);

    // 2. File-Cluster aktualisieren
    updateFileCluster(db, recentSessions);

    // 3. Intent-Prediction via Haiku
    await predictIntent(db, projectPath, recentSessions);

    const patternCount = (db.prepare('SELECT COUNT(*) as c FROM work_patterns').get() as any)?.c ?? 0;
    process.stdout.write(`[cortex-daemon] PatternAgent: ${patternCount} patterns in DB\n`);

  } finally {
    db.close();
  }
}

async function predictIntent(
  db: DatabaseSync,
  projectPath: string,
  recentSessions: SessionDiffs[]
): Promise<void> {
  // Signale sammeln
  let branch = 'unknown';
  try {
    const { execFileSync } = await import('child_process');
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath, encoding: 'utf-8'
    }).trim();
  } catch { /* not git */ }

  const unfinished = db.prepare(`
    SELECT description, priority FROM unfinished
    WHERE resolved_at IS NULL
    ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 5
  `).all() as Array<{ description: string; priority: string }>;

  const topPatterns = db.prepare(`
    SELECT pattern_type, pattern_data, confidence FROM work_patterns
    WHERE confidence > 0.2
    ORDER BY confidence DESC
    LIMIT 5
  `).all() as Array<{ pattern_type: string; pattern_data: string; confidence: number }>;

  const decisions = db.prepare(`
    SELECT id, title, reasoning FROM decisions
    WHERE archived != 1
    ORDER BY created_at DESC
    LIMIT 5
  `).all() as Array<{ id: number; title: string; reasoning: string }>;

  const errors = db.prepare(`
    SELECT id, error_message, fix_description FROM errors
    WHERE archived != 1
    ORDER BY last_seen DESC
    LIMIT 3
  `).all() as Array<{ id: number; error_message: string; fix_description: string | null }>;

  // Bestimme ob Sonnet noetig ist
  const lastSession = recentSessions[0];
  const daysSinceLastSession = lastSession
    ? (Date.now() - new Date(lastSession.started_at).getTime()) / 86400000
    : 999;
  const useSonnet = daysSinceLastSession > 3;
  const model = useSonnet ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';

  const INTENT_SCHEMA = {
    type: 'object',
    properties: {
      predicted_task: { type: 'string' },
      confidence: { type: 'number' },
      reasoning: { type: 'string' },
      relevant_decision_ids: { type: 'array', items: { type: 'number' } },
      relevant_error_ids: { type: 'array', items: { type: 'number' } },
      relevant_files: { type: 'array', items: { type: 'string' } },
      suggested_next_step: { type: 'string' },
    },
    required: ['predicted_task', 'confidence', 'reasoning', 'relevant_files', 'suggested_next_step'],
  };

  const prompt = `<role>
Du bist ein Arbeits-Muster-Analyst. Sage voraus, was der Entwickler in der NAECHSTEN Session wahrscheinlich tun wird.
</role>

<signals>
<branch>${branch}</branch>
<hour>${new Date().getHours()}</hour>
<days_since_last_session>${daysSinceLastSession.toFixed(1)}</days_since_last_session>

<recent_sessions>
${recentSessions.map(s => `[${s.started_at.slice(0, 16)}] ${s.summary ?? '(keine Summary)'}\n  Files: ${s.files.slice(0, 8).join(', ')}`).join('\n')}
</recent_sessions>

<unfinished_items>
${unfinished.map(u => `[${u.priority}] ${u.description}`).join('\n') || '(keine)'}
</unfinished_items>

<work_patterns>
${topPatterns.map(p => `[${p.pattern_type}] confidence=${p.confidence.toFixed(2)}: ${p.pattern_data.slice(0, 200)}`).join('\n') || '(noch keine Patterns)'}
</work_patterns>

<recent_decisions>
${decisions.map(d => `[#${d.id}] ${d.title}`).join('\n') || '(keine)'}
</recent_decisions>

<recent_errors>
${errors.map(e => `[#${e.id}] ${e.error_message}${e.fix_description ? ' (fixed: ' + e.fix_description + ')' : ''}`).join('\n') || '(keine)'}
</recent_errors>
</signals>

<instructions>
Analysiere die Signale und sage voraus:
1. Was wird der Entwickler wahrscheinlich als naechstes tun?
2. Welche Dateien sind relevant?
3. Was waere ein guter erster Schritt?

Beruecksichtige:
- Unfinished-Items mit hoher Prioritaet
- Muster in den letzten Sessions (Fortfuehrung vs. neues Thema)
- Branch-Name als Hinweis auf aktuelle Arbeit
- Tageszeit (morgens: frische Features, abends: Reviews/Fixes)

Sei spezifisch. Keine generischen Antworten wie "Code schreiben".
Antworte NUR mit dem JSON.
</instructions>`;

  const result = await runClaudeAgent({
    prompt,
    projectPath,
    timeoutMs: 60_000,
    jsonSchema: INTENT_SCHEMA,
    model,
    agentName: 'patternAgent',
  });

  if (!result.success || !result.output) {
    process.stderr.write(`[cortex-daemon] PatternAgent: intent prediction failed: ${result.error ?? 'no output'}\n`);
    return;
  }

  try {
    const parsed = JSON.parse(result.output);
    const prediction = parsed?.structured_output ?? parsed;
    if (!prediction?.predicted_task) return;

    // Model-Info hinzufuegen
    prediction.model_used = model;
    prediction.predicted_at = new Date().toISOString();

    // In meta-Tabelle speichern (ueberschreibt vorherige Prediction)
    db.prepare(`
      INSERT INTO meta (key, value) VALUES ('last_intent_prediction', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(prediction));

    process.stdout.write(`[cortex-daemon] PatternAgent: intent prediction saved (${prediction.confidence?.toFixed(2) ?? '?'} confidence, ${model})\n`);
  } catch (e) {
    // Fallback: Regex
    try {
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const prediction = JSON.parse(jsonMatch[0]);
        prediction.model_used = model;
        prediction.predicted_at = new Date().toISOString();
        db.prepare(`
          INSERT INTO meta (key, value) VALUES ('last_intent_prediction', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(JSON.stringify(prediction));
      }
    } catch { /* aufgeben */ }
  }
}
```

**Step 2: Commit**

```bash
git add daemon/src/agents/patternAgent.ts
git commit -m "feat: PatternAgent — File-Cluster-Erkennung + Intent-Prediction"
```

---

### Task 3: PatternAgent in Daemon registrieren

**Files:**
- Modify: `daemon/src/index.ts:11` (import hinzufuegen)
- Modify: `daemon/src/index.ts:69-88` (session_end handler)

**Step 1: Import hinzufuegen**

In `daemon/src/index.ts` nach Zeile 11 (`import { runSkillAdvisorAgent }...`):

```typescript
import { runPatternAgent } from './agents/patternAgent.js';
```

**Step 2: PatternAgent im session_end Handler aufrufen**

In `daemon/src/index.ts`, im `session_end`-Block (nach Zeile 86, nach dem runSkillAdvisorAgent-Call):

```typescript
      runPatternAgent(projectPath, event.session_id).catch(err => {
        process.stderr.write(`[cortex-daemon] PatternAgent error: ${err}\n`);
      });
```

**Step 3: Build**

Run: `cd daemon && npm run build`
Expected: Kompiliert ohne Fehler, erzeugt `daemon/dist/index.js`

**Step 4: Commit**

```bash
git add daemon/src/index.ts
git commit -m "feat: PatternAgent in session_end Event-Handler registriert"
```

---

### Task 4: Learner-Agent — Convention-Extraktion

**Files:**
- Modify: `daemon/src/agents/learner.ts:6-85` (LEARNER_SCHEMA erweitern)
- Modify: `daemon/src/agents/learner.ts:127-221` (Prompt erweitern)
- Modify: `daemon/src/agents/learner.ts:279-404` (Speicherlogik)

**Step 1: Schema erweitern**

In `daemon/src/agents/learner.ts`, im `LEARNER_SCHEMA.properties`-Objekt (nach `resolved_unfinished_ids`):

```typescript
    conventions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          scope: { type: 'string', enum: ['global', 'frontend', 'backend', 'database'] },
          detection_pattern: { type: ['string', 'null'] },
          violation_pattern: { type: ['string', 'null'] },
        },
        required: ['name', 'description'],
      },
    },
```

Und `required`-Array aktualisieren:
```typescript
  required: ['learnings', 'errors', 'architecture_updates', 'facts', 'insights', 'resolved_unfinished_ids', 'conventions'],
```

**Step 2: Prompt erweitern**

Im Prompt (nach dem `resolved_unfinished_ids`-Block in `<analysis_targets>`), neuen Punkt hinzufuegen:

```
7. Wiederkehrende Code-Konventionen -> conventions (name + description + scope)
   Beispiele: "ESM Imports statt require", "Fehler auf stderr, nie exit(1)", "DB-Migrationen als ALTER TABLE"
   Nur stabile, wiederholte Muster — keine Einmal-Beobachtungen.
```

Und das JSON-Template um `conventions` erweitern:
```json
  "conventions": [
    {
      "name": "ESM Imports",
      "description": "Alle Hook-Scripts nutzen import statt require",
      "scope": "global",
      "detection_pattern": "^import .+ from",
      "violation_pattern": "require\\("
    }
  ],
```

**Step 3: Speicherlogik hinzufuegen**

Nach dem `resolved_unfinished_ids`-Block (ca. Zeile 400), vor der finalen Log-Zeile:

```typescript
    // Conventions speichern
    if (analysis.conventions) {
      for (const c of analysis.conventions) {
        if (!c.name || !c.description) continue;
        try {
          db.prepare(`
            INSERT INTO conventions (name, description, scope, detection_pattern, violation_pattern, source)
            VALUES (?, ?, ?, ?, ?, 'learner-agent')
            ON CONFLICT(name) DO UPDATE SET
              description = excluded.description,
              detection_pattern = COALESCE(excluded.detection_pattern, detection_pattern),
              violation_pattern = COALESCE(excluded.violation_pattern, violation_pattern)
          `).run(
            c.name, c.description,
            c.scope ?? 'global',
            c.detection_pattern ?? null,
            c.violation_pattern ?? null
          );
          saved++;
        } catch { /* ignorieren */ }
      }
    }
```

**Step 4: TypeScript-Typen anpassen**

Im `analysis`-Typ (ca. Zeile 230), hinzufuegen:

```typescript
      conventions?: Array<{
        name: string;
        description: string;
        scope?: string;
        detection_pattern?: string | null;
        violation_pattern?: string | null;
      }>;
```

**Step 5: Build + Test**

Run: `cd daemon && npm run build`
Expected: Kompiliert ohne Fehler

**Step 6: Commit**

```bash
git add daemon/src/agents/learner.ts
git commit -m "feat: Learner extrahiert automatisch Conventions aus Sessions"
```

---

### Task 5: Session-Start-Hook — Intent-Prediction anzeigen

**Files:**
- Modify: `scripts/on-session-start.js:142-298` (main Funktion, Dashboard-Aufbau)

**Step 1: Intent-Prediction aus DB laden und anzeigen**

In `scripts/on-session-start.js`, nach dem Git-Status-Block (ca. Zeile 153) und vor "Recent sessions" (Zeile 155), Intent-Prediction einfuegen:

```javascript
    // 1b. Intent-Prediction (vom PatternAgent pre-computed)
    try {
      const intentRow = db.prepare(`SELECT value FROM meta WHERE key='last_intent_prediction'`).get();
      if (intentRow?.value) {
        const intent = JSON.parse(intentRow.value);
        if (intent.predicted_task && intent.confidence > 0.2) {
          const confPct = Math.round((intent.confidence ?? 0) * 100);
          parts.push(`PREDICTED TASK: ${intent.predicted_task} (${confPct}% confident)`);
          if (intent.suggested_next_step) parts.push(`  -> Suggested: ${intent.suggested_next_step}`);
          if (intent.relevant_files?.length > 0) parts.push(`  -> Files: ${intent.relevant_files.slice(0, 5).join(', ')}`);
          const refs = [];
          if (intent.relevant_decision_ids?.length > 0) refs.push(`Decision ${intent.relevant_decision_ids.map(id => '#' + id).join(', ')}`);
          if (intent.relevant_error_ids?.length > 0) refs.push(`Error ${intent.relevant_error_ids.map(id => '#' + id).join(', ')}`);
          if (refs.length > 0) parts.push(`  -> Relevant: ${refs.join(', ')}`);
          parts.push('');
        }
      }
    } catch { /* keine Prediction vorhanden */ }
```

**Step 2: Commit**

```bash
git add scripts/on-session-start.js
git commit -m "feat: Intent-Prediction im Session-Start-Dashboard anzeigen"
```

---

### Task 6: Architect-Agent — Post-Session Map Refresh

**Files:**
- Modify: `daemon/src/agents/architect.ts`
- Modify: `daemon/src/index.ts`

**Step 1: Architect um Conditional-Trigger erweitern**

In `daemon/src/agents/architect.ts`, Export-Funktion um optionalen `triggerReason`-Parameter erweitern:

```typescript
export async function runArchitectAgent(projectPath: string, triggerReason?: 'startup' | 'post_session'): Promise<void> {
```

Vor dem `if (files.length === 0)` Check (Zeile 23), bei `post_session` die Diff-Anzahl pruefen:

```typescript
    // Post-Session: nur ausfuehren wenn genuegend Aenderungen
    if (triggerReason === 'post_session') {
      const recentDiffs = (db.prepare(`
        SELECT COUNT(DISTINCT file_path) as c FROM diffs
        WHERE created_at > datetime('now', '-2 hours')
      `).get() as any)?.c ?? 0;
      if (recentDiffs < 5) {
        process.stdout.write('[cortex-daemon] Architect: <5 changed files, skipping post-session refresh\n');
        return;
      }
    }
```

**Step 2: In index.ts den Architect-Call im session_end ergaenzen**

Im session_end-Handler in `daemon/src/index.ts`:

```typescript
      runArchitectAgent(projectPath, 'post_session').catch(err => {
        process.stderr.write(`[cortex-daemon] Architect (post-session) error: ${err}\n`);
      });
```

**Step 3: Build**

Run: `cd daemon && npm run build`
Expected: Kompiliert ohne Fehler

**Step 4: Commit**

```bash
git add daemon/src/agents/architect.ts daemon/src/index.ts
git commit -m "feat: Architect-Agent laeuft auch post-session bei >5 geaenderten Dateien"
```

---

### Task 7: Build + dist aktualisieren

**Files:**
- Modify: `daemon/dist/` (generiert)
- Modify: `server/dist/` (generiert, falls Server-Aenderungen)

**Step 1: Daemon bauen**

Run: `cd daemon && npm run build`
Expected: Keine Fehler, `daemon/dist/index.js` aktualisiert

**Step 2: Dist committen**

```bash
git add daemon/dist/
git commit -m "build: dist-Dateien aktualisieren (patternAgent, learner, architect)"
```

---

### Task 8: End-to-End Test

**Step 1: DB-Migration testen**

Run: `node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb('.'); const r = db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get('work_patterns'); console.log(r?.sql ?? 'TABLE NOT FOUND'); db.close(); })"`
Expected: CREATE TABLE mit allen Spalten

**Step 2: PatternAgent manuell triggern**

Run: `node -e "import('./daemon/dist/index.js');"` (mit --project Flag)
Oder: Event manuell in Queue schreiben und Daemon beobachten

**Step 3: Verify Intent-Prediction in meta**

Run: `node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb('.'); const r = db.prepare('SELECT value FROM meta WHERE key=?').get('last_intent_prediction'); console.log(r?.value ?? 'NO PREDICTION YET'); db.close(); })"`
Expected: JSON mit predicted_task, confidence, etc.

**Step 4: Commit (falls Fixes noetig)**

```bash
git add -A
git commit -m "fix: Intelligence Layer end-to-end Fixes"
```
