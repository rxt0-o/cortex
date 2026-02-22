# MCP Tool Search — Design

**Datum:** 2026-02-22
**Status:** Approved

---

## Problem

Cortex hat 55 MCP-Tools. Die `CORTEX_INSTRUCTIONS` im Server listet alle Tools mit Beschreibungen — das frisst bei jedem Tool-Call Token-Budget und erhöht das Context-Window unnötig.

**Zwei Schmerzpunkte:**
1. Context-Window-Größe — Instructions zu lang
2. Tool-Überflutung — Claude hat zu viele Tools gleichzeitig im Blick

---

## Lösung

**Ansatz: CORTEX_INSTRUCTIONS kürzen + `cortex_load_tools` Meta-Tool**

Alle 55 Tools bleiben mit vollen MCP-Descriptions registriert — kein Breaking Change, kein Datenverlust wenn Claude ein Tool aufruft ohne vorher `cortex_load_tools` zu rufen.

`CORTEX_INSTRUCTIONS` wird von ~50 Zeilen auf ~10 Zeilen gekürzt: nur Kategorien-Übersicht + Hinweis auf `cortex_load_tools`.

`cortex_load_tools(categories[])` gibt detaillierte Nutzungs-Guidance zurück (wann welches Tool, Beispiele) — als Text-Response, nicht als neue Tool-Registrierung.

SessionStart preloaded `memory` + `tracking` Guidance automatisch via Hook (additionalContext).

---

## Kategorien

| Kategorie | Tools | Auto-preload |
|---|---|---|
| `memory` | snapshot, get_context, list_sessions, search | ja |
| `decisions` | add_decision, list_decisions, mark_decision_reviewed | nein |
| `errors` | add_error, add_learning, check_regression, list_errors, list_learnings | nein |
| `map` | scan_project, get_map, get_deps, get_hot_zones, get_file_history, blame | nein |
| `tracking` | add_unfinished, get_unfinished, resolve_unfinished, add_intent, snooze | ja |
| `notes` | add_note, list_notes, delete_note, onboard, update_profile, get_profile | nein |
| `intelligence` | dejavu, check_blind_spots, get_mood, forget, cross_project_search | nein |
| `stats` | get_health, get_stats, get_access_stats, run_pruning, get_timeline | nein |

---

## Komponenten

### 1. `server/src/modules/tool-registry.ts` (neu)
- Exportiert `TOOL_CATEGORIES`: Record mit Kategorie → Nutzungs-Guidance (Markdown)
- Exportiert `getToolGuidance(categories[])`: gibt kombinierten Markdown-Text zurück

### 2. `server/src/index.ts` (ändern)
- `CORTEX_INSTRUCTIONS` auf ~10 Zeilen kürzen
- Neues Tool `cortex_load_tools` registrieren mit `categories[]` Parameter
- Tool ruft `getToolGuidance()` auf und gibt Text zurück

### 3. `scripts/on-session-start.js` (ändern)
- Nach DB-Open: Guidance für `memory` + `tracking` als `additionalContext` injizieren

---

## Was sich NICHT ändert

- Alle 55 Tools bleiben registriert mit vollen Descriptions
- Tool-Behavior und DB-Logik unverändert
- Kein MCP-Protokoll-Hack, kein dynamisches Re-Register

---

## Erwartete Einsparung

CORTEX_INSTRUCTIONS: ~50 Zeilen → ~10 Zeilen
Pro Tool-Call gespart: ~1.5–2 KB Token-Overhead
Kein Risiko: Claude kann alle Tools weiterhin fehlerfrei aufrufen

---

## Nicht im Scope

- Tool-Descriptions im MCP-Schema kürzen
- Dynamische Tool-Registrierung
- Lazy Stubs / Stub-Tools
