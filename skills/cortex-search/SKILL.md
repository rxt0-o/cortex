---
name: cortex-search
description: Suche in allen Cortex-Daten — Sessions, Decisions, Errors, Learnings
user_invocable: true
argument: query
---

# Cortex Search

Volltextsuche in allen Project-Cortex-Daten.

## Instructions

1. `cortex_search` mit dem Query aufrufen
2. Ergebnisse nach Typ gruppieren: Sessions → Decisions → Errors → Learnings
3. Relevanteste zuerst
4. Kontext zeigen: wann, welche Files, Tags der Session
5. Wenn keine Ergebnisse: alternative Suchbegriffe vorschlagen

## Modell-Hinweis

Einfache Suche = direkter MCP-Call, kein Subagent nötig.

## Usage

```
/cortex-search auth         — Alles zu Authentication
/cortex-search migration    — Alle Migration-Themen
/cortex-search supabase rls — RLS-bezogene Einträge
```
