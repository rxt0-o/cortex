# Cortex Intelligence Layer — Design

**Datum:** 2026-02-22
**Ziel:** Kontext-Qualitaet verbessern durch KI-basierte Intent-Prediction und automatische Daten-Pipeline
**Ansatz:** Full Intelligence Layer (Ansatz C) — work_patterns, Pattern-Learning, Intent-Prediction

---

## Problem

Die Cortex-DB ist trotz 66 Sessions fast leer: 0 Learnings, 0 Conventions, leere Architecture Map, nur 3 tracked Files. Der Session-Start-Kontext ist generisch und zeigt nicht, woran der User wahrscheinlich arbeiten will. Es fehlt eine proaktive Aufgaben-Erkennung.

## Loesung: 3 Saeulen

### 1. Daten-Pipeline (Auto-Population)

**Convention-Extraktor:** Learner-Agent wird erweitert, um automatisch Conventions aus Code-Patterns abzuleiten und in `conventions`-Tabelle zu schreiben.

**Architecture-Map Refresh:** Nach Sessions mit >5 Diffs wird die Map automatisch aktualisiert. `project_files` bekommt `cluster_id`-Spalte.

**work_patterns Tabelle (NEU):**
```sql
CREATE TABLE IF NOT EXISTS work_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT NOT NULL,
  pattern_data TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  occurrences INTEGER DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  decay_rate REAL DEFAULT 0.95
);
```

Pattern-Typen:
- `file_cluster` — Dateien die oft zusammen bearbeitet werden
- `task_sequence` — Typische Abfolgen (z.B. "Hook-Change -> Server-Build")
- `time_pattern` — Aktivitaetstypen pro Tageszeit-Bucket
- `branch_pattern` — Relevante Dateien pro Branch-Prefix

### 2. Pattern-Learning Engine (PatternAgent)

Neuer Daemon-Agent `patternAgent.ts`. Laeuft bei jedem `session_end`.

**Ablauf:**
1. Liest letzte 5 Sessions (Diffs, Files, Timestamps, Branch)
2. Erkennt File-Cluster via Jaccard-Similarity (>60% Overlap = Cluster staerken)
3. Erkennt Task-Sequenzen via Haiku-Tagging (Branch-Name + Commit-Messages)
4. Aktualisiert bestehende Patterns oder erstellt neue
5. Wendet Decay an: `confidence = confidence * decay_rate ^ days_since_last_seen`
6. Archiviert Patterns mit confidence < 0.1 oder >30 Tage nicht gesehen

**Modell:** Haiku (schnelle Struktur-Analyse).

**Kein Embedding-Store in v1:** Jaccard + Haiku-Tagging erreicht 80% der Qualitaet mit 10% der Komplexitaet. Upgrade-Pfad zu Embeddings bleibt offen (pattern_data ist JSON).

### 3. Intent-Prediction

Teil des PatternAgents. Wird bei `session_end` fuer die *naechste* Session berechnet (Zero-Latenz bei Session-Start).

**Signale:**
- Aktueller Branch
- Letzte 3 Session-Summaries
- Top-5 work_patterns (nach confidence)
- Offene Unfinished-Items
- Tageszeit + Tage seit letzter Session

**Output:**
```json
{
  "predicted_task": "Hook-Script on-pre-tool-use.js erweitern",
  "confidence": 0.82,
  "reasoning": "Branch main, letzte Session: Pins, unfinished: cortex-pins testen",
  "relevant_decisions": [3, 5],
  "relevant_errors": [1],
  "relevant_files": ["scripts/on-pre-tool-use.js", "skills/pin/SKILL.md"],
  "suggested_next_step": "Pin-Workflow end-to-end testen",
  "model_used": "haiku"
}
```

**Sonnet-Fallback:** Wenn confidence < 0.5 ODER >3 Tage Pause ODER Branch-Wechsel.

**Speicherung:** `meta`-Tabelle, key `last_intent_prediction`.

### Dashboard-Integration

`on-session-start.js` liest Intent-Prediction und zeigt:
```
-- Project Cortex | Health: 76/100 (=) --
Branch: main

PREDICTED TASK: Hook-Script erweitern (82% confident)
  -> Suggested: Pin-Workflow end-to-end testen
  -> Relevant: Decision #3 (Hookify-Hybrid), Error #1 (tags-Spalte)
  -> Files: scripts/on-pre-tool-use.js, skills/pin/SKILL.md

RECENT SESSIONS:
  ...
```

## Aenderungen

| Komponente | Aktion | Datei |
|---|---|---|
| Convention-Extraktor | Learner erweitern | `daemon/src/agents/learner.ts` |
| Architecture-Map Refresh | Architect-Trigger erweitern | `daemon/src/agents/architect.ts`, `daemon/src/index.ts` |
| work_patterns Tabelle | Neue Migration | `scripts/ensure-db.js` |
| PatternAgent | Neuer Agent | `daemon/src/agents/patternAgent.ts` (NEU) |
| Intent-Prediction | Teil von PatternAgent | `daemon/src/agents/patternAgent.ts` |
| Dashboard | Prediction anzeigen | `scripts/on-session-start.js` |
| Event-Dispatch | PatternAgent bei session_end | `daemon/src/index.ts` |
| cluster_id | Neue Spalte | `scripts/ensure-db.js` |

## Modell-Budget

| Agent | Modell | Wann | Ca. Kosten |
|---|---|---|---|
| PatternAgent (Standard) | Haiku | Jede session_end | ~$0.001 |
| PatternAgent (Fallback) | Sonnet | Branch-Wechsel, lange Pause | ~$0.01 |
| Learner (erweitert) | Sonnet | Jede session_end (existiert) | +$0 (schon vorhanden) |

## Upgrade-Pfad zu v2 (Embeddings)

- Neue Tabelle `embeddings` (file_path, embedding BLOB, model, created_at)
- sqlite-vss oder sqlite-vec fuer Vector-Search
- Cosine-Similarity statt Jaccard
- Pattern-Matching wird: "finde 5 aehnlichste vergangene Sessions"
- v1 beweist Wert, v2 verbessert Praezision
