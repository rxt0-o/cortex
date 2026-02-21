---
name: cortex-review
description: Intelligenter Review-Agent — wählt automatisch das passende Modell je nach Komplexität
user_invocable: true
argument: task_description
---

# Cortex Review

Startet einen intelligenten Review-Agenten der das passende Modell wählt.

## Instructions

### Schritt 1: Komplexität einschätzen

Analysiere das Argument und klassifiziere:

**HAIKU** (`claude-haiku-4-5-20251001`) — schnell, günstig, wenn:
- Status-Abfragen: "was passierte letzte Woche", "zeig TODOs", "health check"
- Einfache Suchen: "welche Fehler gibt es zu X"
- Kurze Zusammenfassungen ohne Code-Analyse

**SONNET** (`claude-sonnet-4-6`) — Standard, wenn:
- Code-Analyse: "review letzte Session", "welche Files haben Probleme"
- Empfehlungen: "was sollte ich als nächstes tun", "welche Conventions werden verletzt"
- Mittlere Recherchen mit Mustererkennung

**OPUS** (`claude-opus-4-6`) — tief, langsam, wenn:
- Architektur-Reviews: "vollständige Code-Analyse", "Refactoring-Plan"
- Komplexe Planungen: "migration strategy für Feature X"
- Multi-Datei-Analysen die viel Kontext brauchen
- User fragt explizit nach "deep dive", "vollständig", "gründlich", "komplett"

### Schritt 2: Modell ankündigen

Sage dem User welches Modell verwendet wird und warum:
- "Verwende **Haiku** für diese Abfrage (schnell, ~5s)"
- "Verwende **Sonnet** für diese Analyse"
- "Verwende **Opus** für diese tiefe Analyse (dauert etwas länger)"

### Schritt 3: Kontext sammeln

Rufe die relevanten MCP-Tools auf:

**Immer:**
- `cortex_get_health`
- `cortex_list_sessions` (limit: 5)

**Zusätzlich je nach Aufgabe:**
- Code-Review → `cortex_get_hot_zones`, `cortex_list_errors`
- Convention-Check → `cortex_get_conventions`
- Architecture → `cortex_get_map`, `cortex_list_decisions`
- Security → `cortex_list_errors` (severity: high)
- Weekly Summary → `cortex_list_sessions` (limit: 20), `cortex_get_stats`

### Schritt 4: Review durchführen

Mit dem gesammelten Kontext analysieren und konkrete Empfehlungen geben.

**Ausgabe-Format:**
```
## Review: [Thema]
**Modell:** Haiku / Sonnet / Opus
**Analysiert:** [was wurde angeschaut]

### Befunde
1. [konkreter Befund mit Dateiname wenn möglich]

### Empfehlungen
1. [konkrete, umsetzbare Aktion]

### Nächste Schritte
- [priorisierte Liste]
```

### Schritt 5: Cortex updaten

Wenn der Review neue Erkenntnisse bringt:
- Neue Anti-Patterns → `cortex_add_learning`
- Neue Entscheidungen → `cortex_add_decision`
- Offene TODOs → `cortex_add_unfinished`

## Usage

```
/cortex-review                              — Health Check (Haiku)
/cortex-review was war diese woche          — Weekly Summary (Haiku)
/cortex-review letzte session analysieren   — Session Review (Sonnet)
/cortex-review convention violations        — Convention Check (Sonnet)
/cortex-review komplette architektur        — Deep Architecture Review (Opus)
/cortex-review security audit               — Security Review (Opus)
/cortex-review deep dive supabase           — Supabase Deep Dive (Opus)
```
