---
name: cortex
description: Cortex Master-Dashboard — Health, Decisions, Errors, Conventions, Unfinished, Map
user_invocable: true
argument: section
---

# Cortex Dashboard

Zeigt je nach Argument die passende Cortex-Ansicht. Kein Argument = vollständiges Dashboard.

## Instructions

Auswertung des Arguments:

| Argument | Aktion |
|---|---|
| (leer) | Vollständiges Dashboard: Health + letzte Sessions + offene Items |
| `health` | `cortex_get_health` + History-Trend |
| `decisions [N\|category]` | `cortex_list_decisions` |
| `errors [severity\|file]` | `cortex_list_errors` |
| `conventions [scope]` | `cortex_get_conventions` |
| `todo` / `unfinished` | `cortex_get_unfinished` |
| `map [module]` | `cortex_get_map` |
| `stats` | `cortex_get_stats` |

**Für das vollständige Dashboard** (kein Argument):
1. `cortex_get_health` → Score + Trend
2. `cortex_list_sessions` (limit: 5) → Letzte Aktivität
3. `cortex_get_unfinished` → Offene TODOs
4. `cortex_list_errors` (limit: 3) → Aktive Fehler
5. Alles kompakt in einer Tabellen-Übersicht darstellen

## Modell-Hinweis

Diese Befehle sind reine Daten-Abfragen. Kein externer Agent nötig — direkte MCP-Tool-Calls.

## Usage

```
/cortex              — Vollständiges Dashboard
/cortex health       — Health Score Details
/cortex decisions    — Alle Architektur-Entscheidungen
/cortex decisions security  — Nur Security-Entscheidungen
/cortex errors       — Bekannte Fehler
/cortex errors high  — Nur kritische Fehler
/cortex conventions  — Coding Conventions
/cortex todo         — Offene TODOs
/cortex map          — Architektur-Übersicht
/cortex map frontend/src/services  — Modul-Detail
/cortex stats        — Projekt-Statistiken
```
