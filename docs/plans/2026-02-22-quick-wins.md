# Quick Wins: Auto-Cleanup Agent + Goal-Loop + Cross-Project Sharing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Drei kleine Features in einer Session: (1) Daemon-Agent für automatisches Aufräumen von Duplikat-Learnings und stale Decisions, (2) Goal-Vorschlag im SessionStart-Dashboard, (3) Shared-Flag für Cross-Project Learnings.

**Architecture:** Alle drei Features sind unabhängig voneinander und können parallel implementiert werden. Feature 1 ist ein neuer Daemon-Agent (Haiku). Feature 2 ist ein Edit am SessionStart-Hook. Feature 3 ist eine DB-Migration + Server-Tool-Anpassung.

**Tech Stack:** Node.js (Hook-Scripts), TypeScript (Daemon + Server), SQLite (node:sqlite)

---

## Task 1: Auto-Cleanup Agent

**Files:**
- Create: `daemon/src/agents/cleanupAgent.ts`
- Modify: `daemon/src/index.ts:7-13` (import hinzufügen)
- Modify: `daemon/src/index.ts:76-101` (im session_end handler aufrufen)

**Step 1: Erstelle `daemon/src/agents/cleanupAgent.ts`**

```typescript
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

export async function runCleanupAgent(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Nur alle 5 completed Sessions laufen
    const total = (db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE status='completed'`).get() as any)?.c ?? 0;
    if (total === 0 || total % 5 !== 0) return;

    // Check: bereits bei diesem Count gelaufen?
    let lastCount = 0;
    try {
      const meta = db.prepare(`SELECT value FROM meta WHERE key='cleanup_last_count'`).get() as any;
      lastCount = parseInt(meta?.value ?? '0', 10);
    } catch {}
    if (lastCount === total) return;

    // Sammle alle aktiven Learnings
    const allLearnings = db.prepare(`
      SELECT id, anti_pattern, correct_pattern, context, severity, auto_block, confidence, occurrences
      FROM learnings
      WHERE archived_at IS NULL AND superseded_by IS NULL
      ORDER BY id ASC
    `).all() as any[];

    // Sammle stale Decisions (>30 Tage, nie reviewed)
    const staleDecisions = db.prepare(`
      SELECT id, title, category, created_at
      FROM decisions
      WHERE archived_at IS NULL
        AND reviewed_at IS NULL
        AND created_at < datetime('now', '-30 days')
        AND stale != 1
    `).all() as any[];

    if (allLearnings.length < 2 && staleDecisions.length === 0) {
      // Nichts zu tun, aber Count trotzdem updaten
      db.prepare(`INSERT INTO meta (key,value) VALUES ('cleanup_last_count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(total));
      return;
    }

    const learningStr = allLearnings.map(l =>
      `#${l.id} [${l.severity}${l.auto_block ? ',auto_block' : ''}] "${l.anti_pattern}" → "${l.correct_pattern}" (conf:${l.confidence}, occ:${l.occurrences})`
    ).join('\n');

    const staleStr = staleDecisions.map(d =>
      `#${d.id} [${d.category}] "${d.title}" (${d.created_at?.slice(0,10)})`
    ).join('\n');

    const prompt = `You are a memory cleanup agent. Analyze these items and return a JSON object.

ACTIVE LEARNINGS (${allLearnings.length}):
${learningStr || '(none)'}

STALE DECISIONS (never reviewed, >30 days old):
${staleStr || '(none)'}

Tasks:
1. Find DUPLICATE learnings (same concept, different wording). Return pairs where the NEWER one should be superseded by the OLDER (keep the original).
2. Flag stale decisions that should be marked as stale.

Return ONLY valid JSON:
{
  "duplicate_pairs": [{"keep_id": 1, "supersede_id": 2, "reason": "same concept"}],
  "stale_decision_ids": [3, 5],
  "summary": "Found X duplicates, Y stale decisions"
}

If nothing to clean up, return: {"duplicate_pairs": [], "stale_decision_ids": [], "summary": "All clean"}`;

    const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 60000, agentName: 'cleanup' });

    if (result.success && result.output?.trim()) {
      try {
        // Extrahiere JSON aus Antwort
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;
        const data = JSON.parse(jsonMatch[0]);

        // Duplikate: supersede_id → superseded_by = keep_id
        let dupsFixed = 0;
        for (const pair of (data.duplicate_pairs ?? [])) {
          try {
            db.prepare(`UPDATE learnings SET superseded_by = ?, superseded_at = datetime('now') WHERE id = ? AND superseded_by IS NULL`).run(pair.keep_id, pair.supersede_id);
            dupsFixed++;
          } catch {}
        }

        // Stale Decisions markieren
        let staleMarked = 0;
        for (const id of (data.stale_decision_ids ?? [])) {
          try {
            db.prepare(`UPDATE decisions SET stale = 1 WHERE id = ? AND stale != 1`).run(id);
            staleMarked++;
          } catch {}
        }

        // Meta updaten
        db.prepare(`INSERT INTO meta (key,value) VALUES ('cleanup_last_count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(total));

        process.stdout.write(`[cortex-daemon] Cleanup: ${dupsFixed} duplicates resolved, ${staleMarked} decisions marked stale\n`);
      } catch (e) {
        process.stderr.write(`[cortex-daemon] Cleanup: failed to parse result: ${e}\n`);
      }
    }
  } finally {
    db.close();
  }
}
```

**Step 2: Registriere in `daemon/src/index.ts`**

Füge Import hinzu (nach Zeile 13):
```typescript
import { runCleanupAgent } from './agents/cleanupAgent.js';
```

Füge im `session_end` Handler hinzu (nach Zeile 97, vor `processed.push(event)`):
```typescript
      runCleanupAgent(projectPath).catch(err => {
        process.stderr.write(`[cortex-daemon] Cleanup error: ${err}\n`);
      });
```

**Step 3: Build**

Run: `cd daemon && npm run build`
Expected: Clean build, keine Fehler

**Step 4: Commit**

```bash
git add daemon/src/agents/cleanupAgent.ts daemon/src/index.ts daemon/dist/
git commit -m "feat: Auto-Cleanup Agent — dedupliziert Learnings, markiert stale Decisions"
```

---

## Task 2: Goal-Loop im SessionStart Dashboard

**Files:**
- Modify: `scripts/on-session-start.js:162-179` (Intent-Prediction Block erweitern)

**Step 1: Erweitere den Intent-Prediction Block**

Aktuell zeigt der Block `PREDICTED TASK: ...` an. Ändere zu einem `SUGGESTED GOAL` Format mit Alternative aus Top-1 Unfinished.

Ersetze den gesamten Block Zeile 162-179 mit:

```javascript
    // 1b. Goal Suggestion (Intent-Prediction + Top-Unfinished)
    try {
      const intentRow = db.prepare(`SELECT value FROM meta WHERE key='last_intent_prediction'`).get();
      let goalShown = false;

      if (intentRow?.value) {
        const intent = JSON.parse(intentRow.value);
        if (intent.predicted_task && intent.confidence > 0.4) {
          const confPct = Math.round((intent.confidence ?? 0) * 100);
          parts.push(`SUGGESTED GOAL: ${intent.predicted_task} (${confPct}% match)`);
          if (intent.suggested_next_step) parts.push(`  -> Next step: ${intent.suggested_next_step}`);
          if (intent.relevant_files?.length > 0) parts.push(`  -> Files: ${intent.relevant_files.slice(0, 5).join(', ')}`);
          goalShown = true;
        }
      }

      // Fallback: Top-1 High-Priority Unfinished als Goal
      if (!goalShown) {
        const topItem = db.prepare(`SELECT description FROM unfinished WHERE resolved_at IS NULL AND context != 'intent' ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC LIMIT 1`).get();
        if (topItem) {
          parts.push(`SUGGESTED GOAL: ${topItem.description}`);
        }
      }

      parts.push('');
    } catch { /* keine Prediction/Goal vorhanden */ }
```

**Step 2: Commit**

```bash
git add scripts/on-session-start.js
git commit -m "feat: Goal-Loop — zeigt SUGGESTED GOAL im Dashboard (Intent-Prediction + Fallback)"
```

---

## Task 3: Cross-Project Sharing (Light)

**Files:**
- Modify: `scripts/ensure-db.js:207` (Migration: `shared` Spalte)
- Modify: `server/src/modules/learnings.ts` (addLearning: auto-shared bei severity=high)
- Modify: `server/src/tools/intelligence.ts:326-356` (cross_project_search: shared bevorzugt)
- Modify: `server/src/tools/learnings.ts` (neues Tool: cortex_share_learning)

**Step 1: DB-Migration in `ensure-db.js`**

Füge in das `v04migrations` Array hinzu (vor der schließenden `]` in Zeile 208):
```javascript
    `ALTER TABLE learnings ADD COLUMN shared INTEGER DEFAULT 0`,
```

**Step 2: Auto-shared bei severity=high**

In `server/src/modules/learnings.ts`, in der `addLearning` Funktion:
Nach dem INSERT, wenn `severity === 'high'`, setze `shared = 1`:

Finde die INSERT-Stelle und füge nach dem INSERT hinzu:
```typescript
// Auto-share high-severity learnings
if (input.severity === 'high') {
  db.prepare('UPDATE learnings SET shared = 1 WHERE id = ?').run(id);
}
```

**Step 3: `cortex_cross_project_search` — shared Learnings bevorzugen**

In `server/src/tools/intelligence.ts`, ersetze den Learnings-Block (Zeile 344-347):

```typescript
      try {
        // Shared learnings first
        const sharedLearnings = db.prepare(`SELECT anti_pattern, correct_pattern FROM learnings WHERE shared=1 AND (anti_pattern LIKE ? OR context LIKE ?) AND archived_at IS NULL LIMIT ?`).all(pat, pat, limit) as any[];
        for (const l of sharedLearnings) lines.push(`[SHARED LEARNING] ${l.anti_pattern} → ${l.correct_pattern}`);

        const otherLearnings = db.prepare(`SELECT anti_pattern, correct_pattern FROM learnings WHERE (shared IS NULL OR shared=0) AND (anti_pattern LIKE ? OR context LIKE ?) AND archived_at IS NULL LIMIT ?`).all(pat, pat, limit) as any[];
        for (const l of otherLearnings) lines.push(`[LEARNING] ${l.anti_pattern} → ${l.correct_pattern}`);
      } catch {}
```

**Step 4: Neues Tool `cortex_share_learning`**

In `server/src/tools/learnings.ts`, nach dem `cortex_delete_learning` Tool, füge hinzu:

```typescript
  server.tool(
    'cortex_share_learning',
    'Mark a learning as shared across projects',
    {
      id: z.number().describe('Learning ID to share'),
      shared: z.boolean().optional().default(true).describe('Set to false to unshare'),
    },
    async ({ id, shared }) => {
      const db = getDb();
      const val = shared ? 1 : 0;
      db.prepare('UPDATE learnings SET shared = ? WHERE id = ?').run(val, id);
      return { content: [{ type: 'text' as const, text: `Learning #${id} ${shared ? 'shared' : 'unshared'}` }] };
    }
  );
```

**Step 5: Build + Commit**

Run: `cd server && npm run build`

```bash
git add scripts/ensure-db.js server/src/ server/dist/
git commit -m "feat: Cross-Project Sharing Light — shared Flag für Learnings"
```

---

## Abschluss

**Step 1: Unfinished Items resolven**

```
cortex_resolve_unfinished(id=21)  # Auto-Cleanup Agent
cortex_resolve_unfinished(id=22)  # Goal-Loop
cortex_resolve_unfinished(id=18)  # Cross-Project Sharing (Light — Grundlage steht)
```

**Step 2: Build all + Smoke-Test**

```bash
cd daemon && npm run build && cd ../server && npm run build
```
