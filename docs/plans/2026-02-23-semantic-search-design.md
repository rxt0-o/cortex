# Semantic Search für Cortex — Design

**Datum:** 2026-02-23
**Status:** Approved
**Ziel:** cortex_search von reinem BM25 auf semantische Suche upgraden

## Problem

Die aktuelle Suche hat drei Hauptlücken:
1. **Keine semantische Ähnlichkeit** — "DB Problem" findet nicht "SQLite timeout"
2. **Unvollständiges FTS** — Sessions und Unfinished fallen auf LIKE zurück
3. **Schlechte Ergebnis-Qualität** — kein Cross-Entity Ranking, keine Snippets, zu wenig Kontext

## Lösung: 2-Phasen-Ansatz

### Phase 1 — FTS-Upgrade

#### 1.1 Fehlende FTS-Tabellen
- `sessions_fts` erstellen (Felder: `summary`, `key_changes`)
- `unfinished_fts` erstellen (Felder: `description`, `context`)
- INSERT/DELETE Trigger + Backfill analog zu bestehenden FTS-Tabellen

#### 1.2 Unified Cross-Entity Ranking
- Alle FTS-Ergebnisse in eine gemeinsame Liste
- BM25-Score pro Entity normalisieren
- Nach Score sortieren statt nach Entity-Typ
- Ergebnis-Objekt: `{ type, id, score, title, snippet, metadata }`

#### 1.3 Snippet-Generierung
- FTS5 `snippet()` Funktion nutzen
- Match-Stellen mit Markern hervorheben

#### 1.4 Ergebnis-Format
- Statt `[LEARNING] anti_pattern` → strukturierte Ausgabe mit Score, Snippet, Zeitstempel

### Phase 2 — Lokale Embeddings + RRF-Fusion

#### 2.1 Embedding-Infrastruktur
- **Library:** `@xenova/transformers` (npm)
- **Modell:** `all-MiniLM-L6-v2` (384-dimensional, 22MB, MIT-Lizenz)
- **Tabelle:** `embeddings(entity_type TEXT, entity_id INTEGER, embedding BLOB, model TEXT, created_at TEXT)`
- Embedding bei jedem INSERT im Tool-Handler berechnen

#### 2.2 Backfill
- Einmaliger Backfill aller bestehenden Daten beim ersten Start
- Progress-Tracking für Abbruch + Fortsetzen
- Batch-Processing (z.B. 50 Einträge gleichzeitig)

#### 2.3 RRF-Fusion (Reciprocal Rank Fusion)
- Bei Suche: BM25 Top-20 + Cosine-Similarity Top-20 parallel holen
- RRF-Score: `1/(k + rank_bm25) + 1/(k + rank_cosine)` mit k=60
- Finale Liste nach RRF-Score sortieren

#### 2.4 Provider-Abstraction
- Lokales Modell als Default-Provider
- Interface für spätere API-Provider (OpenAI, Anthropic)

## Constraints
- **Lokal first** — kein API-Key erforderlich, kein Internet nötig
- **~50MB extra** für transformers.js + Modell (akzeptiert)
- **Rückwärtskompatibel** — bestehende FTS-Suche bleibt als Fallback
- **DB-Schema** — nur additive Änderungen (neue Tabellen/Trigger)

## Nicht-Ziele
- LLM-basiertes Reranking (braucht API)
- Manuelle Synonym-Pflege
- Vector-DB (SQLite BLOB reicht für unsere Datenmenge)
