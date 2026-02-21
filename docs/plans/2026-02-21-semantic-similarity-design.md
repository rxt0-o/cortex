# Cortex Semantic Similarity — Design

**Datum:** 2026-02-21
**Status:** Genehmigt

---

## Ziel

Cortex bekommt semantische Ähnlichkeitserkennung ohne externe Dependencies und ohne zusätzliche API-Kosten. Drei konkrete Verbesserungen:

1. **Redundancy Detection** — Verhindert doppelte Learnings/Decisions
2. **Semantic Search** — `cortex_search` findet relevante statt nur exakte Substring-Matches
3. **Function-Level Diff** — `cortex_blame` und Diff-Tracking auf Funktionsebene (Comprehend-Chunking)

---

## Architektur

### Schicht 1: TF-IDF inline (Redundancy Detection)

**Datei:** `server/src/utils/similarity.ts`

Pure TypeScript, zero dependencies. Berechnet TF-IDF-Cosine-Similarity on-the-fly beim Speichern neuer Einträge.

```typescript
export function findSimilar(
  query: string,
  corpus: { id: number; text: string }[],
  threshold?: number  // Default: 0.85, via CORTEX_SIMILARITY_THRESHOLD env konfigurierbar
): { id: number; score: number }[]
```

**Algorithmus:**
- Tokenisierung: lowercase, Wörter splitten, Stopwords entfernen (EN + DE)
- TF: Term Frequency pro Dokument
- IDF: `log(N / df)` über alle Dokumente im Corpus
- Cosine Similarity zwischen Query-Vektor und Dokument-Vektoren

**Greift in:**
- `cortex_add_learning` — Query = `anti_pattern + " " + correct_pattern`
- `cortex_add_decision` — Query = `title + " " + reasoning`
- Bei Score > 0.85: Tool gibt Warning zurück mit ID des ähnlichen Eintrags, speichert trotzdem (User entscheidet)

### Schicht 2: SQLite FTS5 + BM25 (Semantic Search)

**Schema-Änderungen in `scripts/ensure-db.js`:**

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  anti_pattern, correct_pattern, context,
  content='learnings', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, reasoning,
  content='decisions', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(
  error_message, root_cause, fix_description,
  content='errors', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  text,
  content='notes', content_rowid='id'
);
```

Trigger synchronisieren FTS-Tabellen bei INSERT auf die Haupttabellen.

**`cortex_search` Upgrade:**
- Ersetzt `LIKE %query%` durch `FTS_TABLE MATCH query`
- BM25-Score via `bm25(learnings_fts)` für Ranking
- Ergebnisse über alle Tabellen gemergt und nach Score sortiert

### Schicht 3: Natural Boundary Chunking (Function-Level Diff)

**Datei:** `server/src/analyzer/chunk-analyzer.ts`

Erkennt semantische Grenzen (Funktionen, Klassen, Methoden) in geänderten Zeilen.

```typescript
export interface FunctionChunk {
  functionName: string;
  language: string;  // inferred from file extension
  hunks: DiffHunk[];
  linesAdded: number;
  linesRemoved: number;
}

export function chunkByFunctions(
  diff: ParsedDiff,
  fileContent?: string
): FunctionChunk[]
```

**Erkannte Patterns (Regex):**
```
function\s+(\w+)         # JS/TS functions
const\s+(\w+)\s*=.*=>    # Arrow functions
class\s+(\w+)            # Classes
async\s+function\s+(\w+) # Async functions
def\s+(\w+)              # Python
export\s+(function|class|const)\s+(\w+)
```

**Greift in:**
- `cortex_blame` — zeigt `Modified: auth.ts → verifyToken(), parseJWT()` statt nur `Modified: auth.ts`
- `on-post-tool-use.js` — speichert geänderte Funktionsnamen in `project_files.description`
- Loop Detector — warnt wenn dieselbe Funktion 3x in 5min editiert wird

---

## Was NICHT implementiert wird

- Kein REPL-Server (SQLite ist Cortex' Persistence-Layer)
- Keine Embedding-Vektoren in der DB gespeichert (TF-IDF on-the-fly)
- Keine parallelen Subagenten für Codebase-Analyse
- Kein externes Embedding-Modell oder externe API

---

## Änderungen im Überblick

| Datei | Aktion | Zweck |
|---|---|---|
| `server/src/utils/similarity.ts` | NEU | TF-IDF Cosine Similarity |
| `server/src/analyzer/chunk-analyzer.ts` | NEU | Function-Level Diff Chunking |
| `scripts/ensure-db.js` | EDIT | FTS5 Tabellen + Trigger |
| `server/src/index.ts` | EDIT | cortex_search auf FTS5 + add_learning/decision mit Duplikat-Check |
| `server/src/modules/learnings.ts` | EDIT | findSimilar aufrufen |
| `server/src/modules/decisions.ts` | EDIT | findSimilar aufrufen |
| `scripts/on-post-tool-use.js` | EDIT | chunkByFunctions für Function-Level Tracking |

---

## Erfolgskriterien

- `cortex_search "auth"` findet Einträge die "authentication", "authorize", "login" enthalten
- `cortex_add_learning` mit einem ähnlichen Anti-Pattern wie ein bestehendes gibt Warning zurück
- `cortex_blame server/src/index.ts` zeigt welche Funktionen geändert wurden
- Kein neuer npm-Package, keine externe API, kein Build-Overhead

---

*Design: 2026-02-21 | Genehmigt vom User*
