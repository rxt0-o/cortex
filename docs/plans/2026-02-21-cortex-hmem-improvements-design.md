# Design: Cortex hmem-Verbesserungen

**Datum:** 2026-02-21
**Inspiration:** [hmem – Humanlike Memory für AI-Agenten](https://github.com/Bumblebiber/hmem)
**Status:** Approved

---

## Übersicht

Drei Verbesserungen inspiriert durch das hmem-Projekt, die Cortex token-effizienter und selbstverwaltender machen:

1. **Access-Counter** — Zugriffshäufigkeit auf Decisions/Learnings/Errors tracken
2. **Ebbinghaus-Pruning** — Automatische Archivierung ungenutzter Einträge beim Session-Start
3. **Recency-Gradient im Snapshot** — Neuere Einträge mit mehr Detail, ältere komprimiert

---

## Feature 1: Access-Counter

### Schema-Änderungen

Tabellen `decisions`, `learnings`, `errors` bekommen zwei neue Spalten:

```sql
access_count INTEGER DEFAULT 0
last_accessed TEXT
```

### Verhalten

- `getDecision(id)`, `getLearning(id)`, `getError(id)` (single-item reads) inkrementieren `access_count` und setzen `last_accessed = now()`
- Listen-Abfragen (`list_*`) zählen **nicht** — zu viel Rauschen, da sie oft viele Items auf einmal liefern
- Neues Tool `cortex_get_access_stats` zeigt Top-10 meistgenutzte Items pro Typ

### Zweck

Basis für das Pruning-System: Einträge ohne Zugriffe werden als "vergessen" markiert.

---

## Feature 2: Ebbinghaus-Pruning (automatisch)

### Schema-Änderungen

Tabellen `decisions`, `learnings`, `errors` bekommen:

```sql
archived_at TEXT  -- NULL = aktiv, ISO-timestamp = archiviert
```

### Pruning-Formel

Ein Eintrag wird archiviert wenn eine der folgenden Bedingungen zutrifft:

- Alter > 90 Tage **UND** `access_count = 0` (nie zugegriffen)
- Alter > 365 Tage **UND** `access_count < 3` (selten zugegriffen)

Auto-block Learnings (`auto_block = 1`) sind **immer** ausgenommen vom Pruning.

### Trigger

- **Automatisch:** `cortex_save_session` mit `status='active'` ruft intern `runPruning()` auf
- **Manuell:** Tool `cortex_run_pruning` für on-demand Ausführung (z.B. nach erstem Setup)

### Verhalten

- Alle `list_*` Queries filtern automatisch `WHERE archived_at IS NULL`
- `cortex_run_pruning` gibt Bericht zurück: wie viele Einträge pro Typ archiviert wurden
- Archivierte Einträge bleiben in der DB — sie sind nur aus normalen Abfragen ausgeblendet

---

## Feature 3: Recency-Gradient im Snapshot

### Erweiterter `cortex_snapshot`

**Sessions:**
- Letzte 3 Sessions: vollständiger Context (summary + key_changes)
- Ältere Sessions: nur Datum + Kurzusammenfassung (erste 100 Zeichen)

**Decisions & Learnings:**
- Erstellt/geändert in den letzten 7 Tagen: vollständige Details
- Ältere: nur Gesamtanzahl als Zahl

**Immer dabei (unabhängig vom Alter):**
- Alle `auto_block = 1` Learnings (sicherheitsrelevant, müssen immer präsent sein)
- Alle offenen `unfinished` Items (Priorität: high/medium)

### Zweck

Token-Effizienz: Der Snapshot wird kleiner und relevanter. Frische Arbeit bekommt mehr Kontext, alte Arbeit nur eine Zusammenfassung.

---

## Schema-Migration

- `SCHEMA_VERSION` wird von `1` auf `2` erhöht
- `initSchema()` bekommt eine Migration die per `ALTER TABLE ADD COLUMN` die neuen Spalten hinzufügt
- Non-destructiv: bestehende Daten bleiben unverändert, neue Spalten haben sinnvolle Defaults (`0` / `NULL`)

---

## Betroffene Dateien

| Datei | Änderung |
|-------|----------|
| `server/src/db.ts` | Schema v2, Migration, neue Spalten |
| `server/src/modules/decisions.ts` | access_count tracken, archived_at filtern |
| `server/src/modules/learnings.ts` | access_count tracken, archived_at filtern, Pruning-Logik |
| `server/src/modules/errors.ts` | access_count tracken, archived_at filtern |
| `server/src/index.ts` | cortex_snapshot erweitern, cortex_run_pruning Tool, auto-pruning bei session start |

---

## Nicht im Scope

- Kein hierarchisches L1-L5 Speichermodell (zu großer Umbau der Kernarchitektur)
- Kein Kurator-Agent (würde externe LLM-Calls erfordern)
- Kein per-Agent Isolation (Cortex ist per-Projekt, nicht per-Agent)
