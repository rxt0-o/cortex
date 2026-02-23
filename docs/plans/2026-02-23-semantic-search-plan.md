# Semantic Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** cortex_search von reinem BM25 auf semantische Suche upgraden (2 Phasen: FTS-Fix + Embeddings/RRF)

**Architecture:** Phase 1 fixt FTS-Luecken (Sessions/Unfinished FTS, Cross-Entity Ranking, Snippets). Phase 2 fuegt lokale Embeddings via `@huggingface/transformers` hinzu und kombiniert BM25 + Cosine Similarity via RRF-Fusion.

**Tech Stack:** SQLite FTS5, `@huggingface/transformers` (all-MiniLM-L6-v2), RRF-Fusion, Node.js `node:sqlite`

---

## Phase 1: FTS-Upgrade

### Task 1: Sessions + Unfinished FTS-Tabellen + Trigger

**Files:**
- Modify: `scripts/ensure-db.js:142-151` (FTS-Migrationen erweitern)
- Modify: `scripts/ensure-db.js:215-224` (Backfill erweitern)

**Step 1: FTS-Tabellen und Trigger in ensure-db.js hinzufuegen**

In `scripts/ensure-db.js`, im `v04migrations` Array (nach den bestehenden FTS-Eintraegen bei ~Zeile 151):

- `sessions_fts` Virtual Table mit Feldern: summary, key_changes (content='sessions', content_rowid='rowid')
- `unfinished_fts` Virtual Table mit Feldern: description, context (content='unfinished', content_rowid='id')
- Sessions INSERT Trigger (`sessions_ai`): COALESCE auf summary und key_changes
- Sessions UPDATE Trigger (`sessions_au`): Bei UPDATE OF summary/key_changes — erst alten Eintrag aus FTS entfernen, dann neuen einfuegen
- Unfinished INSERT Trigger (`unfinished_ai`): description + COALESCE(context,'')

**Hinweis:** Sessions hat `id TEXT PRIMARY KEY`. FTS5 nutzt die implizite SQLite `rowid`.

**Step 2: Backfill in ensure-db.js erweitern**

Nach dem bestehenden notes_fts Backfill (Zeile ~222):
- sessions_fts Backfill: alle Sessions mit status != 'active', COALESCE auf summary/key_changes
- unfinished_fts Backfill: alle unresolved Items (resolved_at IS NULL)

Jeweils mit eigenem try/catch und COUNT-Check (nur wenn leer).

**Step 3: Build + manuell testen**

Run: `cd server && npm run build`

**Step 4: Commit**

```bash
git add scripts/ensure-db.js
git commit -m "feat: add sessions_fts + unfinished_fts tables with triggers and backfill"
```

---

### Task 2: Unified Search mit Cross-Entity BM25 Ranking

**Files:**
- Create: `server/src/modules/search.ts` (neue Search-Engine)
- Modify: `server/src/tools/sessions.ts:61-103` (cortex_search refactoren)

**Step 1: Search-Modul erstellen**

Erstelle `server/src/modules/search.ts` mit folgender Struktur:

**SearchResult Interface:**
```typescript
interface SearchResult {
  type: 'learning' | 'decision' | 'error' | 'note' | 'session' | 'todo';
  id: number | string;
  score: number;
  title: string;
  snippet: string;
  created_at: string | null;
  metadata: Record<string, unknown>;
}
```

**FtsConfig Array:** Konfiguration pro Entity-Typ:
- type, ftsTable, sourceTable, joinColumn, titleFn, snippetColumns, metadataFn, createdAtColumn
- 6 Eintraege: learning, decision, error, note, session, todo

**searchAll(query, limit) Funktion:**
- Iteriert ueber FTS_CONFIGS
- Pro Config: JOIN sourceTable mit ftsTable, ORDER BY bm25(), LIMIT
- bm25() gibt negative Werte zurueck (naeher an 0 = besser) — flip zu positiv
- Alle Ergebnisse in eine Liste, nach Score sortieren, Top-N zurueckgeben

**buildSnippet(row, columns, query) Funktion:**
- Query-Terms extrahieren
- Beste Spalte finden (meiste Term-Matches)
- ~150 Zeichen Kontext-Fenster um den ersten Match extrahieren

**formatResults(results) Funktion:**
- Nummerierte Ausgabe mit Type-Tag, Score, Age, Metadata, Snippet
- Format: `1. [LEARNING] Title\n   (score: 0.42) 3d ago [severity:high]\n   Snippet text...`

**Step 2: cortex_search Tool refactoren**

In `server/src/tools/sessions.ts`:
- Import von search Modul hinzufuegen
- cortex_search Handler ersetzen: `search.searchAll(query, limit)` + `search.formatResults()`
- Query-Parameter description: 'Search query — supports FTS5 syntax (AND, OR, NOT, "phrase")'
- Default limit: 15

**Step 3: Build + testen**

Run: `cd server && npm run build`

**Step 4: Commit**

```bash
git add server/src/modules/search.ts server/src/tools/sessions.ts
git commit -m "feat: unified cross-entity search with BM25 ranking and snippets"
```

---

### Task 3: Server Build + Phase 1 Integration Test

**Step 1:** `cd server && npm run build`

**Step 2: Manueller Test**
1. Query die in Session-Summary vorkommt -> Session-Ergebnis
2. Query die in Unfinished vorkommt -> TODO-Ergebnis
3. Query in mehreren Entity-Typen -> gemischte Ergebnisse nach Score
4. Leere Query -> "No results."

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: complete Phase 1 — unified FTS search with sessions, unfinished, cross-entity ranking"
```

---

## Phase 2: Lokale Embeddings + RRF-Fusion

### Task 4: transformers.js Dependency + Embedding-Modul

**Files:**
- Modify: `server/package.json` (neue Dependency)
- Create: `server/src/modules/embeddings.ts` (Embedding-Engine)
- Modify: `scripts/ensure-db.js` (embeddings Tabelle)
- Modify: `server/src/db.ts` (Schema v3 Migration)

**Step 1: Dependency installieren**

```bash
cd server && npm install @huggingface/transformers
```

Falls Probleme: Fallback auf `@xenova/transformers@2.17.2`.

**Step 2: Embedding-Modul erstellen**

Erstelle `server/src/modules/embeddings.ts`:

- Modell: `Xenova/all-MiniLM-L6-v2` (384-dimensional)
- Lazy-loaded Pipeline (dynamic import, ~2-3s beim ersten Aufruf)
- `embed(text)` -> Float32Array
- `cosineSimilarity(a, b)` -> number (dot product, da normalisiert)
- `storeEmbedding(entityType, entityId, embedding)` -> INSERT OR REPLACE in embeddings
- `getAllEmbeddings()` -> Array von {entity_type, entity_id, embedding}
- `findSimilar(queryText, limit)` -> Top-N nach Cosine Similarity
- `buildEmbeddingText(entityType, fields)` -> kombinierter Text, max 512 chars
- `isAvailable()` -> boolean (embeddings Tabelle existiert?)

**Step 3: DB-Migration fuer embeddings-Tabelle**

In `scripts/ensure-db.js` v04migrations Array:
- embeddings Tabelle: id, entity_type TEXT, entity_id TEXT, embedding BLOB, model TEXT, created_at TEXT, UNIQUE(entity_type, entity_id)
- Index auf (entity_type, entity_id)

In `server/src/db.ts`: SCHEMA_VERSION auf 3 erhoehen, v3 Migration mit gleicher Tabelle.

**Step 4: esbuild externals anpassen**

In `server/package.json` den bundle-Befehl erweitern:
```
--external:onnxruntime-node --external:@huggingface/transformers
```

**Step 5: Build**

```bash
cd server && npm run build
```

**Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/modules/embeddings.ts scripts/ensure-db.js server/src/db.ts
git commit -m "feat: add embedding module with local transformers.js + embeddings table"
```

---

### Task 5: Auto-Embed bei Insert + Backfill

**Files:**
- Create: `server/src/modules/embed-hooks.ts` (shared auto-embed logic)
- Modify: `server/src/tools/learnings.ts` (embed bei add_learning)
- Modify: `server/src/tools/decisions.ts` (embed bei add_decision)
- Modify: `server/src/tools/errors.ts` (embed bei add_error)
- Modify: `server/src/tools/sessions.ts` (embed bei save_session)
- Modify: `server/src/tools/tracking.ts` (embed bei add_unfinished)
- Modify: `server/src/tools/profile.ts` (embed bei add_note)
- Modify: `server/src/tools/stats.ts` (backfill tool)

**Step 1: Shared embed-hooks Modul**

Erstelle `server/src/modules/embed-hooks.ts`:
- `embedAsync(entityType, entityId, fields)`: Fire-and-forget — baut Text, erzeugt Embedding, speichert. Fehler werden ignoriert (best-effort).

**Step 2: Hook in alle relevanten Tool-Handler**

Nach jedem erfolgreichen INSERT in den Tool-Handlern `embedAsync` aufrufen:
- add_learning: fields = {anti_pattern, correct_pattern, context}
- add_decision: fields = {title, reasoning}
- add_error: fields = {error_message, root_cause, fix_description}
- save_session (wenn summary gesetzt): fields = {summary, key_changes}
- add_note: fields = {text}
- add_unfinished: fields = {description, context}

**Step 3: Backfill-Tool**

In `server/src/tools/stats.ts` neues Tool `cortex_backfill_embeddings` registrieren:
- Iteriert ueber alle Entity-Tabellen
- Prueft ob Embedding schon existiert (skip wenn ja)
- Generiert Embedding + speichert
- Gibt Zaehler zurueck: "Backfill complete: X embeddings generated, Y errors."

**Step 4: Build + testen**

```bash
cd server && npm run build
```

Test: `cortex_backfill_embeddings` aufrufen.

**Step 5: Commit**

```bash
git add server/src/modules/embed-hooks.ts server/src/tools/*.ts
git commit -m "feat: auto-embed on insert + backfill tool for existing data"
```

---

### Task 6: RRF-Fusion in searchAll integrieren

**Files:**
- Modify: `server/src/modules/search.ts` (RRF-Fusion hinzufuegen)

**Step 1: searchAll um Embedding-Suche erweitern**

In `server/src/modules/search.ts`:

- `searchAll` wird `async`
- Zuerst BM25-Ergebnisse holen (synchron, wie bisher)
- Dann: embeddings.findSimilar() aufrufen (async, best-effort)
- Falls keine Embeddings: BM25-Ergebnisse direkt zurueckgeben

**RRF-Fusion Algorithmus:**
- RRF_K = 60 (Standard-Konstante)
- Fuer jedes BM25-Ergebnis: RRF-Score += 1/(K + rank + 1)
- Fuer jedes Embedding-Ergebnis: RRF-Score += 1/(K + rank + 1)
- Ergebnisse die in beiden Listen auftauchen bekommen beide Scores addiert
- Embedding-only Ergebnisse mit Score > 0.5: Entity aus DB laden und hinzufuegen
- Finale Liste nach RRF-Score sortieren

**resolveEntity(entityType, entityId) Hilfsfunktion:**
- Laedt Entity aus DB fuer Embedding-only Ergebnisse
- Nutzt FTS_CONFIGS fuer Tabellen/Feld-Mapping

**Step 2: Build + testen**

```bash
cd server && npm run build
```

Test: Semantisch aehnliche Query (z.B. "Datenbank Probleme" wenn ein Error "SQLite timeout" existiert).

**Step 3: Commit**

```bash
git add server/src/modules/search.ts
git commit -m "feat: RRF-Fusion combining BM25 + embedding similarity for semantic search"
```

---

### Task 7: Finaler Integrationstest

**Step 1:** `cd server && npm run build`

**Step 2: Test-Checkliste**
1. `cortex_search "FTS"` -> FTS-bezogene Ergebnisse
2. `cortex_search "Datenbank Problem"` -> semantisch aehnliche Errors/Learnings
3. `cortex_search "TODO"` -> Unfinished-Items
4. `cortex_backfill_embeddings` -> laeuft ohne Fehler
5. Neues Learning hinzufuegen -> Embedding automatisch erstellt
6. Semantische Suche nach dem neuen Learning

**Step 3: Finaler Commit**

```bash
git add -A
git commit -m "feat: complete semantic search — Phase 1 (unified FTS) + Phase 2 (local embeddings + RRF)"
```

---

## Aenderungs-Uebersicht

| Datei | Aktion | Was |
|---|---|---|
| `scripts/ensure-db.js` | Modify | sessions_fts, unfinished_fts, embeddings Tabelle + Trigger |
| `server/src/db.ts` | Modify | Schema v3 Migration fuer embeddings |
| `server/src/modules/search.ts` | Create | Unified Search Engine mit BM25 + RRF |
| `server/src/modules/embeddings.ts` | Create | Lokale Embedding-Engine (transformers.js) |
| `server/src/modules/embed-hooks.ts` | Create | Fire-and-forget Auto-Embed Helper |
| `server/src/tools/sessions.ts` | Modify | cortex_search refactored |
| `server/src/tools/learnings.ts` | Modify | embedAsync bei add_learning |
| `server/src/tools/decisions.ts` | Modify | embedAsync bei add_decision |
| `server/src/tools/errors.ts` | Modify | embedAsync bei add_error |
| `server/src/tools/tracking.ts` | Modify | embedAsync bei add_unfinished |
| `server/src/tools/profile.ts` | Modify | embedAsync bei add_note |
| `server/src/tools/stats.ts` | Modify | cortex_backfill_embeddings Tool |
| `server/package.json` | Modify | @huggingface/transformers + esbuild externals |
