# Confidence Decay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Learnings bekommen einen Confidence-Score (0.3–0.9) der bei Treffern steigt und pro Session decayed. Bei niedrigem Score wird der User gefragt statt automatisch geblockt.

**Architecture:** Hook-only Ansatz — Boost in on-pre-tool-use.js, Decay in on-session-end.js, Review-Prompt in on-session-start.js. Kein Daemon, kein LLM-Call. DB-Migration in ensure-db.js.

**Tech Stack:** Node.js (node:sqlite), plain JS Hooks, TypeScript MCP-Server

---

### Task 1: DB-Migration — confidence Spalte

**Files:**
- Modify: `scripts/ensure-db.js:95-207` (v04migrations Array)

**Step 1: Migration hinzufügen**

In `scripts/ensure-db.js`, am Ende des `v04migrations` Arrays (vor der schliessenden `]` bei Zeile 207) einfügen:

```js
`ALTER TABLE learnings ADD COLUMN confidence REAL DEFAULT 0.7`,
```

**Step 2: Verifizieren**

Run: `node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb(process.cwd()); const cols = db.prepare(\"PRAGMA table_info(learnings)\").all(); console.log(cols.map(c => c.name)); db.close(); })"`
Expected: Array enthält `confidence`

**Step 3: Commit**

```bash
git add scripts/ensure-db.js
git commit -m "feat(confidence-decay): add confidence column to learnings"
```

---

### Task 2: on-pre-tool-use.js — Confidence Boost + Block-Gate

**Files:**
- Modify: `scripts/on-pre-tool-use.js:63` (readOnly → readWrite)
- Modify: `scripts/on-pre-tool-use.js:70-87` (Learning-Query + Match-Loop)

**Step 1: DB als readWrite öffnen**

Zeile 63 ändern:
```js
// ALT:
const db = new DatabaseSync(dbPath, { readOnly: true });
// NEU:
const db = new DatabaseSync(dbPath);
```

**Step 2: Learning-Query um confidence erweitern**

Zeile 70-73 ändern:
```js
// ALT:
const learnings = db.prepare(`
  SELECT id, anti_pattern, correct_pattern, detection_regex, severity
  FROM learnings WHERE (auto_block = 1 OR core_memory = 1) AND archived != 1 AND detection_regex IS NOT NULL
`).all();
// NEU:
const learnings = db.prepare(`
  SELECT id, anti_pattern, correct_pattern, detection_regex, severity, COALESCE(confidence, 0.7) as confidence, core_memory
  FROM learnings WHERE (auto_block = 1 OR core_memory = 1) AND archived != 1 AND detection_regex IS NOT NULL
`).all();
```

**Step 3: Match-Loop anpassen — Boost + Block-Gate**

Zeile 78-87 ändern:
```js
// ALT:
for (const l of learnings) {
  if (isDocFile) continue;
  try {
    if (new RegExp(l.detection_regex, 'gm').test(content)) {
      warnings.push({ type: 'anti-pattern', severity: l.severity,
        message: `Anti-pattern: "${l.anti_pattern}" -> Use: "${l.correct_pattern}"` });
      if (l.severity === 'high') shouldBlock = true;
    }
  } catch { /* invalid regex */ }
}
// NEU:
const boostStmt = db.prepare(`UPDATE learnings SET confidence = MIN(0.9, COALESCE(confidence, 0.7) + 0.1) WHERE id = ?`);
for (const l of learnings) {
  if (isDocFile) continue;
  try {
    if (new RegExp(l.detection_regex, 'gm').test(content)) {
      // Boost confidence on match (nicht für core_memory — die sind immer 0.9)
      if (!l.core_memory) {
        try { boostStmt.run(l.id); } catch { /* non-critical */ }
      }
      warnings.push({ type: 'anti-pattern', severity: l.severity,
        message: `Anti-pattern: "${l.anti_pattern}" -> Use: "${l.correct_pattern}"` });
      // Block nur wenn confidence > 0.4 (oder core_memory)
      if (l.severity === 'high' && (l.confidence > 0.4 || l.core_memory)) shouldBlock = true;
    }
  } catch { /* invalid regex */ }
}
```

**Step 4: Commit**

```bash
git add scripts/on-pre-tool-use.js
git commit -m "feat(confidence-decay): boost on match + block-gate in PreToolUse"
```

---

### Task 3: on-session-end.js — Decay pro Session

**Files:**
- Modify: `scripts/on-session-end.js:121-125` (nach Memory Consolidation Block)

**Step 1: Decay-Query hinzufügen**

Nach Zeile 125 (nach dem `} catch {}` des Memory Consolidation Blocks) einfügen:

```js
// Confidence Decay: -0.01 pro Session für nicht-gepinnte Learnings
try {
  db.prepare(`UPDATE learnings SET confidence = MAX(0.3, COALESCE(confidence, 0.7) - 0.01) WHERE core_memory != 1 AND archived != 1`).run();
} catch {}
```

**Step 2: Commit**

```bash
git add scripts/on-session-end.js
git commit -m "feat(confidence-decay): decay -0.01 per session in SessionEnd"
```

---

### Task 4: on-session-start.js — Review-Prompt

**Files:**
- Modify: `scripts/on-session-start.js:246-267` (nach dem auto-block Learnings Block)

**Step 1: Review-Prompt Query hinzufügen**

Nach Zeile 267 (nach dem `if (manualLearnings.length > 0)` Block) einfügen:

```js
// Low-confidence Learnings: User fragen ob behalten oder archivieren
const lowConfidence = db.prepare(`
  SELECT id, anti_pattern, correct_pattern, COALESCE(confidence, 0.7) as confidence
  FROM learnings WHERE COALESCE(confidence, 0.7) <= 0.4 AND core_memory != 1 AND archived != 1
  ORDER BY confidence ASC LIMIT 3
`).all();

if (lowConfidence.length > 0) {
  parts.push('REVIEW NEEDED (low confidence):');
  for (const l of lowConfidence) {
    parts.push(`  ? Learning #${l.id} (${(l.confidence * 100).toFixed(0)}%): "${l.anti_pattern}" — keep or archive?`);
  }
}
```

**Step 2: Commit**

```bash
git add scripts/on-session-start.js
git commit -m "feat(confidence-decay): review prompt for low-confidence learnings"
```

---

### Task 5: MCP-Server — Learning Interface + addLearning

**Files:**
- Modify: `server/src/modules/learnings.ts:4-18` (Learning interface)
- Modify: `server/src/modules/learnings.ts:45-57` (INSERT Statement)

**Step 1: Learning Interface um confidence erweitern**

In `server/src/modules/learnings.ts`, Zeile 4-18, `confidence` zum Interface hinzufügen:

```ts
export interface Learning {
  id: number;
  session_id: string | null;
  created_at: string;
  anti_pattern: string;
  correct_pattern: string;
  detection_regex: string | null;
  context: string;
  severity: string;
  occurrences: number;
  auto_block: boolean;
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
  confidence: number;
}
```

**Step 2: addLearning INSERT — confidence 0.7 setzen**

Zeile 45-57 ändern:

```ts
const result = db.prepare(`
  INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, detection_regex, context, severity, auto_block, confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.7)
`).run(
  input.session_id ?? null,
  now(),
  input.anti_pattern,
  input.correct_pattern,
  input.detection_regex ?? null,
  input.context,
  input.severity ?? 'medium',
  input.auto_block ? 1 : 0
);
```

**Step 3: Commit**

```bash
git add server/src/modules/learnings.ts
git commit -m "feat(confidence-decay): add confidence to Learning interface + addLearning"
```

---

### Task 6: MCP-Server — updateLearning + listLearnings

**Files:**
- Modify: `server/src/modules/learnings.ts:144-152` (UpdateLearningInput)
- Modify: `server/src/modules/learnings.ts:154-170` (updateLearning function)

**Step 1: UpdateLearningInput erweitern**

```ts
export interface UpdateLearningInput {
  id: number;
  anti_pattern?: string;
  correct_pattern?: string;
  detection_regex?: string | null;
  context?: string;
  severity?: string;
  auto_block?: boolean;
  confidence?: number;
}
```

**Step 2: updateLearning — confidence Handling**

In der `updateLearning` Funktion, nach Zeile 164 (auto_block Handling) hinzufügen:

```ts
if (input.confidence !== undefined) { sets.push('confidence = ?'); values.push(input.confidence); }
```

**Step 3: cortex_update_learning Tool-Schema erweitern**

In `server/src/tools/learnings.ts`, Zeile 51-58, `confidence` zum Zod-Schema hinzufügen:

```ts
{
  id: z.number(),
  anti_pattern: z.string().optional(),
  correct_pattern: z.string().optional(),
  detection_regex: z.string().nullable().optional(),
  context: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  auto_block: z.boolean().optional(),
  confidence: z.number().min(0.3).max(0.9).optional().describe('Confidence score (0.3-0.9). Higher = more trusted.'),
},
```

**Step 4: Commit**

```bash
git add server/src/modules/learnings.ts server/src/tools/learnings.ts
git commit -m "feat(confidence-decay): confidence in updateLearning + listLearnings"
```

---

### Task 7: Build + Test

**Files:** keine neuen

**Step 1: Server bauen**

Run: `cd server && npm run build`
Expected: Bundle erfolgreich, keine Fehler

**Step 2: Manueller Integrations-Test**

Run: `node -e "import('./scripts/ensure-db.js').then(m => { const db = m.openDb(process.cwd()); const l = db.prepare('SELECT id, confidence FROM learnings LIMIT 3').all(); console.log(l); db.close(); })"`
Expected: Jedes Learning zeigt `confidence: 0.7` (Default)

**Step 3: Commit Build-Artefakt**

```bash
git add server/dist/bundle.js
git commit -m "build: rebuild server with confidence-decay support"
```

---

### Task 8: Decision loggen

**Step 1: Cortex Decision**

Run: `cortex_add_decision` mit:
- title: "Confidence Decay für Learnings — Hook-only Ansatz"
- reasoning: "Reine Arithmetik (boost +0.1, decay -0.01/session), kein LLM nötig. Pins (core_memory=1) immun. User-Review bei confidence ≤ 0.4."
- category: "feature"
- confidence: "high"
- files_affected: ["scripts/ensure-db.js", "scripts/on-pre-tool-use.js", "scripts/on-session-end.js", "scripts/on-session-start.js", "server/src/modules/learnings.ts", "server/src/tools/learnings.ts"]
