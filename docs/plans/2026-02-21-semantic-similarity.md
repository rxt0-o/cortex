# Semantic Similarity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cortex bekommt semantische Ähnlichkeitserkennung via TF-IDF (Redundancy Detection), SQLite FTS5/BM25 (Search-Ranking) und Natural Boundary Chunking (Function-Level Diff-Tracking).

**Architecture:** Drei Schichten: (1) similarity.ts — pure TypeScript TF-IDF, in addLearning/addDecision für Duplikat-Erkennung. (2) SQLite FTS5 Virtual Tables mit BM25-Ranking ersetzen LIKE-Queries in cortex_search. (3) chunk-analyzer.ts erkennt Funktionsgrenzen in Diffs für cortex_blame und Loop Detector.

**Tech Stack:** TypeScript ESM, node:sqlite (FTS5 built-in), zero external dependencies. Build: cd server && npm run build.

**Cortex root:** C:/Users/toasted/Desktop/data/cortex/

---

## Task 1: TF-IDF Similarity Utility

**Files:**
- Create: server/src/utils/similarity.ts

Erstelle die Datei mit folgendem Inhalt:

```typescript
const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','it','this','that','are','was','be','have','has','do','does',
  'not','no','so','if','as','by','from','use','used','using','should',
  'must','will','can','may','always','never','instead',
  'ein','eine','der','die','das','und','oder','aber','zu','fuer',
  'von','mit','ist','es','ich','wir','sie','nicht','kein','wie',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && \!STOPWORDS.has(t));
}

function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const total = tokens.length || 1;
  for (const [k, v] of tf) tf.set(k, v / total);
  return tf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (const [k, v] of a) {
    dot += v * (b.get(k) ?? 0);
    normA += v * v;
  }
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SimilarMatch { id: number; score: number; }

export function findSimilar(
  query: string,
  corpus: { id: number; text: string }[],
  threshold = parseFloat(process.env.CORTEX_SIMILARITY_THRESHOLD ?? '0.85')
): SimilarMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const allDocs = [...corpus.map(c => tokenize(c.text)), queryTokens];
  const N = allDocs.length;
  const df = new Map<string, number>();
  for (const doc of allDocs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (term: string) => Math.log((N + 1) / ((df.get(term) ?? 0) + 1));
  function tfidfVec(tokens: string[]): Map<string, number> {
    const tf = computeTF(tokens);
    const vec = new Map<string, number>();
    for (const [t, tfVal] of tf) vec.set(t, tfVal * idf(t));
    return vec;
  }
  const queryVec = tfidfVec(queryTokens);
  const results: SimilarMatch[] = [];
  for (const entry of corpus) {
    const score = cosineSimilarity(queryVec, tfidfVec(tokenize(entry.text)));
    if (score >= threshold) results.push({ id: entry.id, score });
  }
  return results.sort((a, b) => b.score - a.score);
}
```

Commit: feat(similarity): TF-IDF cosine similarity utility

---

## Task 2: Redundancy Detection in addLearning

**Files:**
- Modify: server/src/modules/learnings.ts

### Änderungen:

1. Import hinzufügen: `import { findSimilar } from '../utils/similarity.js';`

2. Neuen Interface-Typ vor addLearning einfügen:
```typescript
export interface AddLearningResult {
  learning: Learning;
  duplicate?: { id: number; score: number; anti_pattern: string };
}
```

3. addLearning Return-Type auf AddLearningResult ändern und vor dem INSERT einfügen:
```typescript
// Duplikat-Check
const existing = db.prepare(
  'SELECT id, anti_pattern, correct_pattern FROM learnings WHERE archived_at IS NULL LIMIT 500'
).all() as { id: number; anti_pattern: string; correct_pattern: string }[];
const corpus = existing.map(e => ({ id: e.id, text: e.anti_pattern + ' ' + e.correct_pattern }));
const similar = findSimilar(input.anti_pattern + ' ' + input.correct_pattern, corpus);
```

4. Nach dem getLearning-Aufruf:
```typescript
if (similar.length > 0) {
  const top = similar[0];
  const topEntry = existing.find(e => e.id === top.id);
  return { learning, duplicate: { id: top.id, score: Math.round(top.score * 100), anti_pattern: topEntry?.anti_pattern ?? '' } };
}
return { learning };
```

5. In server/src/index.ts den cortex_add_learning Handler anpassen (ca. Zeile 314):
```typescript
const { learning, duplicate } = learnings.addLearning(input);
let text = 'Learning saved (id: ' + learning.id + ')';
if (duplicate) text += '
Warning: Possible duplicate of Learning #' + duplicate.id + ' (' + duplicate.score + '% similar): "' + duplicate.anti_pattern + '"';
return { content: [{ type: 'text' as const, text }] };
```

Build: cd server && npm run build
Commit: feat(redundancy): duplicate detection in cortex_add_learning

---

## Task 3: Redundancy Detection in addDecision

**Files:**
- Modify: server/src/modules/decisions.ts

Analog zu Task 2:

1. Import: `import { findSimilar } from '../utils/similarity.js';`

2. Interface:
```typescript
export interface AddDecisionResult {
  decision: Decision;
  duplicate?: { id: number; score: number; title: string };
}
```

3. addDecision Return-Type auf AddDecisionResult ändern, Duplikat-Check vor INSERT:
```typescript
const existing = db.prepare(
  'SELECT id, title, reasoning FROM decisions WHERE archived_at IS NULL LIMIT 200'
).all() as { id: number; title: string; reasoning: string }[];
const corpus = existing.map(e => ({ id: e.id, text: e.title + ' ' + e.reasoning }));
const similar = findSimilar(input.title + ' ' + input.reasoning, corpus);
```

4. Nach getDecision:
```typescript
if (similar.length > 0) {
  const top = similar[0];
  const topEntry = existing.find(e => e.id === top.id);
  return { decision, duplicate: { id: top.id, score: Math.round(top.score * 100), title: topEntry?.title ?? '' } };
}
return { decision };
```

5. cortex_add_decision Handler in index.ts (ca. Zeile 225):
```typescript
const { decision, duplicate } = decisions.addDecision(input);
let text = 'Decision saved (id: ' + decision.id + ')';
if (duplicate) text += '
Warning: Possible duplicate of Decision #' + duplicate.id + ' (' + duplicate.score + '% similar): "' + duplicate.title + '"';
return { content: [{ type: 'text' as const, text }] };
```

Build: cd server && npm run build
Commit: feat(redundancy): duplicate detection in cortex_add_decision

---

## Task 4: FTS5 Schema in ensure-db.js

**Files:**
- Modify: scripts/ensure-db.js

Ans Ende des v04migrations-Array (nach dem letzten Eintrag `ALTER TABLE unfinished ADD COLUMN project TEXT`) einfügen:

```javascript
`CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(anti_pattern, correct_pattern, context, content='learnings', content_rowid='id')`,
`CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, reasoning, content='decisions', content_rowid='id')`,
`CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(error_message, root_cause, fix_description, content='errors', content_rowid='id')`,
`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', content_rowid='id')`,
`CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context) VALUES (new.id, new.anti_pattern, new.correct_pattern, new.context); END`,
`CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN INSERT INTO decisions_fts(rowid, title, reasoning) VALUES (new.id, new.title, new.reasoning); END`,
`CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description) VALUES (new.id, new.error_message, new.root_cause, new.fix_description); END`,
`CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END`,
```

Nach der migrations-Schleife FTS-Backfill einfügen:
```javascript
try {
  const ftsCount = db.prepare('SELECT COUNT(*) as c FROM learnings_fts').get()?.c ?? 0;
  if (ftsCount === 0) {
    db.prepare('INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context) SELECT id, anti_pattern, correct_pattern, context FROM learnings WHERE archived_at IS NULL').run();
    db.prepare('INSERT INTO decisions_fts(rowid, title, reasoning) SELECT id, title, reasoning FROM decisions WHERE archived_at IS NULL').run();
    db.prepare("INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description) SELECT id, error_message, COALESCE(root_cause,''), COALESCE(fix_description,'') FROM errors").run();
    db.prepare('INSERT INTO notes_fts(rowid, text) SELECT id, text FROM notes').run();
  }
} catch {}
```

Commit: feat(fts5): FTS5 virtual tables + triggers + backfill

---

## Task 5: cortex_search auf FTS5/BM25 upgraden

**Files:**
- Modify: server/src/index.ts (cortex_search Handler, Zeile ~151-179)

Den gesamten Handler-Body ersetzen:

```typescript
async ({ query, limit }) => {
  const db = getDb();
  const maxResults = limit ?? 10;
  const lines: string[] = [];

  function ftsSearch(ftsTable: string, labelFn: (row: any) => string, prefix: string) {
    try {
      const rows = db.prepare(
        'SELECT rowid, * FROM ' + ftsTable + ' WHERE ' + ftsTable + ' MATCH ? ORDER BY bm25(' + ftsTable + ') LIMIT ?'
      ).all(query, maxResults) as any[];
      for (const r of rows) lines.push(prefix + ' ' + labelFn(r));
    } catch {}
  }

  ftsSearch('learnings_fts', r => r.anti_pattern, '[LEARNING]');
  ftsSearch('decisions_fts', r => r.title, '[DECISION]');
  ftsSearch('errors_fts', r => r.error_message, '[ERROR]');
  ftsSearch('notes_fts', r => String(r.text).slice(0, 120), '[NOTE]');

  try {
    const sr = db.prepare(
      "SELECT summary FROM sessions WHERE summary LIKE ? AND status \!= 'active' ORDER BY started_at DESC LIMIT ?"
    ).all('%' + query + '%', maxResults) as any[];
    for (const s of sr) lines.push('[SESSION] ' + s.summary);
  } catch {}

  try {
    const ur = db.prepare(
      'SELECT description FROM unfinished WHERE description LIKE ? AND resolved_at IS NULL LIMIT ?'
    ).all('%' + query + '%', maxResults) as any[];
    for (const u of ur) lines.push('[TODO] ' + u.description);
  } catch {}

  return { content: [{ type: 'text' as const, text: lines.join('
') || 'No results.' }] };
}
```

Build + Commit: feat(search): cortex_search upgraded to FTS5/BM25 ranking

---

## Task 6: chunk-analyzer.ts erstellen

**Files:**
- Create: server/src/analyzer/chunk-analyzer.ts

```typescript
import type { ParsedDiff, DiffHunk } from './diff-extractor.js';

export interface FunctionChunk {
  functionName: string;
  startLine: number;
  hunks: DiffHunk[];
  linesAdded: number;
  linesRemoved: number;
}

const BOUNDARY_PATTERNS: RegExp[] = [
  /^\s*export\s+(?:async\s+)?function\s+(\w+)/,
  /^\s*(?:async\s+)?function\s+(\w+)/,
  /^\s*export\s+class\s+(\w+)/,
  /^\s*class\s+(\w+)/,
  /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  /^\s*def\s+(\w+)/,
  /^\s*func\s+(\w+)/,
];

const SKIP = new Set(['if','for','while','switch','catch','else','return']);

function detectFunctionName(line: string): string | null {
  for (const pat of BOUNDARY_PATTERNS) {
    const m = line.match(pat);
    if (m?.[1] && \!SKIP.has(m[1])) return m[1];
  }
  return null;
}

export function chunkByFunctions(diff: ParsedDiff): FunctionChunk[] {
  const chunks = new Map<string, FunctionChunk>();
  for (const hunk of diff.hunks) {
    let current = 'module-level';
    for (const line of hunk.lines) {
      const det = detectFunctionName(line.content);
      if (det) current = det;
    }
    if (\!chunks.has(current)) {
      chunks.set(current, { functionName: current, startLine: hunk.newStart, hunks: [], linesAdded: 0, linesRemoved: 0 });
    }
    const chunk = chunks.get(current)\!;
    chunk.hunks.push(hunk);
    chunk.linesAdded += hunk.lines.filter(l => l.type === 'add').length;
    chunk.linesRemoved += hunk.lines.filter(l => l.type === 'remove').length;
  }
  return Array.from(chunks.values());
}

export function summarizeFunctionChanges(diff: ParsedDiff): string {
  const chunks = chunkByFunctions(diff);
  if (chunks.length === 0) return diff.filePath + ': no changes';
  return diff.filePath + ' -> ' + chunks.map(c => c.functionName + '() +' + c.linesAdded + '/-' + c.linesRemoved).join(', ');
}
```

Commit: feat(chunking): natural boundary chunking for function-level diff analysis

---

## Task 7: cortex_blame mit Function-Level Info

**Files:**
- Modify: server/src/index.ts (cortex_blame Handler, ca. Zeile 907)

1. Imports hinzufügen (falls noch nicht vorhanden):
```typescript
import { summarizeFunctionChanges } from './analyzer/chunk-analyzer.js';
import { parseDiff } from './analyzer/diff-extractor.js';
```

2. Nach dem DIFFS-Block im blame-Handler einfügen:
```typescript
try {
  const rawDiffs = db.prepare(
    'SELECT diff_content FROM diffs WHERE file_path LIKE ? ORDER BY created_at DESC LIMIT 5'
  ).all('%' + file_path + '%') as any[];
  const fnChanges: string[] = [];
  for (const d of rawDiffs) {
    if (!d.diff_content) continue;
    for (const fileDiff of parseDiff(d.diff_content)) {
      const s = summarizeFunctionChanges(fileDiff);
      if (!s.includes('no changes')) fnChanges.push('  ' + s);
    }
  }
  if (fnChanges.length > 0) { lines.push('FUNCTION CHANGES:'); lines.push(...fnChanges); }
} catch {}
```

Build + Commit: feat(blame): function-level diff breakdown in cortex_blame

---

## Task 8: Loop Detector auf Funktionsebene

**Files:**
- Modify: scripts/on-post-tool-use.js

Direkt nach der Stelle wo filePath bekannt ist, vor dem _editTracker-Check einfügen:

```javascript
let changedFunction = '';
try {
  const changedContent = (input?.tool_input?.new_string ?? input?.tool_input?.content ?? '');
  const pats = [/(?:async\s+)?function\s+(\w+)/, /const\s+(\w+)\s*=/, /class\s+(\w+)/];
  for (const p of pats) { const m = changedContent.match(p); if (m?.[1]) { changedFunction = m[1]; break; } }
} catch {}
const trackKey = changedFunction ? (filePath + ':' + changedFunction) : filePath;
const trackLabel = changedFunction ? (filePath + ' -> ' + changedFunction + '()') : filePath;
```

Dann alle Map-Key-Verwendungen von filePath durch trackKey ersetzen, Warning-Text durch trackLabel.

Commit: feat(loop): function-level granularity in loop detector

---

## Task 9: Final Build und Smoke-Test

```bash
cd /c/Users/toasted/Desktop/data/cortex/server && npm run build
node /c/Users/toasted/Desktop/data/cortex/scripts/ensure-db.js
```

Smoke-Tests:
1. cortex_add_learning mit ähnlichem Anti-Pattern -> Warning erwartet
2. cortex_search "typescript" -> BM25-sortierte Ergebnisse
3. cortex_blame server/src/index.ts -> FUNCTION CHANGES Sektion

Final Commit: feat: semantic similarity — TF-IDF + FTS5/BM25 + function-level chunking complete

---

## Dateiübersicht

| Datei | Aktion |
|---|---|
| server/src/utils/similarity.ts | NEU — TF-IDF |
| server/src/analyzer/chunk-analyzer.ts | NEU — Chunking |
| scripts/ensure-db.js | EDIT — FTS5 |
| server/src/modules/learnings.ts | EDIT — Duplikat-Check |
| server/src/modules/decisions.ts | EDIT — Duplikat-Check |
| server/src/index.ts | EDIT — Search + Blame |
| scripts/on-post-tool-use.js | EDIT — Loop Detector |

*Plan: 2026-02-21 | Cortex Semantic Similarity*
