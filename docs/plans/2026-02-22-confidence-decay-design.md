# Confidence Decay für Learnings

**Datum:** 2026-02-22
**Status:** Approved
**Ansatz:** Hook-only (kein Daemon, kein LLM-Call)

## Zusammenfassung

Learnings bekommen einen `confidence` Score (0.3–0.9). Neue Learnings starten bei 0.7. Confidence steigt bei Treffern (+0.1), sinkt pro Session (-0.01). Gepinnte Learnings (`core_memory=1`) sind immun. Bei confidence ≤ 0.4 wird der User beim nächsten Session-Start gefragt ob das Learning behalten oder archiviert werden soll — es blockt dann nicht mehr, bleibt aber als Warning sichtbar.

## DB-Schema

```sql
ALTER TABLE learnings ADD COLUMN confidence REAL DEFAULT 0.7
```

Range: 0.3–0.9. Default 0.7 für neue Einträge.

## Hook-Änderungen

### on-pre-tool-use.js — Boost + Block-Gate

- Bei Regex-Match: `UPDATE learnings SET confidence = MIN(0.9, confidence + 0.1) WHERE id = ?`
- Block nur wenn `confidence > 0.4` (sonst Warning only)
- DB muss als readWrite geöffnet werden (aktuell readOnly)

### on-session-end.js — Decay

- Pro Session-Ende: `UPDATE learnings SET confidence = MAX(0.3, confidence - 0.01) WHERE core_memory != 1 AND archived != 1`
- Rate 0.01/Session = ~50 Sessions bis Review-Schwellwert bei Start 0.7

### on-session-start.js — Review-Prompt

- Query: `SELECT * FROM learnings WHERE confidence <= 0.4 AND core_memory != 1 AND archived != 1`
- Als additionalContext: "Diese Learnings wurden lange nicht getriggert. Behalten oder archivieren?"

## MCP-Server

- `cortex_add_learning`: Setzt `confidence = 0.7`
- `cortex_update_learning`: Erlaubt `confidence` als Feld
- `cortex_list_learnings`: Zeigt `confidence` an

## Unverändert

- `/pin` Skill: `core_memory=1` → immun gegen Decay
- `cortex_run_pruning`: Bleibt access-count-basiert
- Daemon: Keine neuen Agents

## Entscheidungen

| Entscheidung | Begründung |
|---|---|
| Hook-only statt Daemon | Reine Arithmetik, kein LLM nötig |
| Decay-Rate 0.01/Session | Viele Sessions pro Tag, langsamer Decay verhindert vorschnelles Vergessen |
| Pins immun | Bewusst vom User gesetzt, sollen persistent bleiben |
| Review statt Auto-Archiv | User behält Kontrolle, nichts geht verloren ohne Zustimmung |
| Startwert 0.7 | Mitte des Bereichs, muss sich erst beweisen |
