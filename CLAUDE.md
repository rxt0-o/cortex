# Cortex — Persistent Memory for Claude Code

## Dashboard-Ausgabe-Regel (WICHTIG)

Wenn du am Anfang einer Session einen Cortex-Block im Kontext siehst (beginnt mit `-- Project Cortex`), gib ihn **wortgetreu als allererste Antwort** aus — bevor du irgendetwas anderes tust oder antwortest.

Beispiel: Du siehst im system-reminder:
```
-- Project Cortex | Health: 82/100 (+) --
Branch: main
...
```
Dann ist deine erste Antwort genau dieser Block, ohne Präambel.

---

## Was ist Cortex?

Cortex ist ein persistentes Memory- und Intelligence-System für Claude Code. Es besteht aus vier Layern:

| Layer | Wo | Was |
|---|---|---|
| **Hooks** | `scripts/` | 6 plain-JS Scripts, kein npm, laufen synchron als Claude-Code-Hooks |
| **Daemon** | `daemon/` | Autonomer Hintergrundprozess, startet via PID-Check beim Session-Start |
| **MCP-Server** | `server/` | TypeScript, 55 Tools, kommuniziert via stdio |
| **Skills** | `skills/` | Slash-Commands für Claude Code (`/cortex-search`, `/resume`, etc.) |

Die SQLite-DB liegt pro Projekt unter `.claude/cortex.db` (Node.js built-in `node:sqlite`, kein native addon).

---

## Architektur-Überblick

```
SessionStart Hook
  └─ on-session-start.js
       ├─ DB öffnen / erstellen (ensure-db.js)
       ├─ Kontext zusammenbauen + als additionalContext injizieren
       └─ Daemon starten (wenn nicht bereits laufend, via PID-File)

PreToolUse Hook (Write/Edit)
  └─ on-pre-tool-use.js
       ├─ Auto-Block: Learnings mit detection_regex
       ├─ Regression-Guard: Error prevention_rules
       ├─ Convention-Check (warn only)
       └─ Passive Kontext: Hot Zones, recent Errors, Decisions

PostToolUse Hook (Read/Write/Edit)
  └─ on-post-tool-use.js
       ├─ Diffs speichern
       ├─ Import-Graph aktualisieren
       └─ file_access Event → Daemon-Queue

SessionEnd Hook
  └─ on-session-end.js
       ├─ Session-Summary speichern
       ├─ Health-Snapshot berechnen
       └─ session_end Event → Daemon-Queue

Daemon (background)
  ├─ Architect Agent (beim Start, einmalig)
  ├─ Context Agent (pro file_access, 60s debounce)
  ├─ Learner Agent (pro session_end, Sonnet)
  ├─ Drift Detector Agent (pro session_end, max 1x/22h)
  ├─ Synthesizer Agent (alle 10 Sessions)
  ├─ Serendipity Agent (pro session_end)
  └─ MoodScorer Agent (pro session_end)

MCP Server (55 Tools)
  └─ server/src/index.ts → modules/ → SQLite
```

---

## Entwicklungskonventionen

### Hook-Scripts (`scripts/`)
- **Kein npm** — nur `node:sqlite`, `fs`, `path`, `child_process` aus Node stdlib
- **ESM** — `import` statt `require`
- **stdin lesen:** `JSON.parse(readFileSync(0, 'utf-8'))` für Hook-Input
- **stdout:** nur valides JSON mit `hookSpecificOutput` oder `systemMessage`
- **Fehler:** immer auf stderr, niemals process.exit(1) — stattdessen process.exit(0) damit der Hook nicht blockiert
- **DB:** immer über `openDb()` aus `ensure-db.js` öffnen, nie direkt `new DatabaseSync()`

### Server (`server/`)
- TypeScript, strict mode
- Build: `cd server && npm run build` — erzeugt `server/dist/bundle.js`
- Schema-Änderungen: **immer** in `ensure-db.js` als Migration, nie direkt im Server
- Tool-Definitionen: Zod-Schema mit `.describe()` und `input_examples` für jeden Parameter
- Neue Tools: in `server/src/index.ts` registrieren, dann bauen

### Daemon (`daemon/`)
- TypeScript, Build: `cd daemon && npm run build`
- Alle `claude`-Aufrufe: `process.platform === 'win32' ? 'claude.cmd' : 'claude'`
- `CLAUDECODE` env-Variable vor Subprozessen unsetzen (verhindert "nested session"-Error)
- Neue Agents: Datei in `daemon/src/agents/`, importieren in `daemon/src/index.ts`

### DB-Schema
- Migrationen in `scripts/ensure-db.js` → `openDb()` → try/catch pro ALTER TABLE
- Schema-Version in Tabelle `schema_version` tracken
- Niemals Daten löschen — immer `archived = 1` setzen

---

## Cortex-Tool-Nutzungsregeln (für Claude)

### Pflicht-Calls
| Wann | Tool |
|---|---|
| Vor jedem Write/Edit | check_regression läuft automatisch im PreToolUse-Hook |
| Bei Architektur-Entscheidungen | `cortex_store(type:'decision', ...)` |
| Nach Bug-Fixes | `cortex_store(type:'error', ...)` mit prevention_rule |
| Bei Session-Start (komplex) | `cortex_context()` |

### Tools
- `cortex_store(type, ...)` — decision / error / learning / todo / intent / note
- `cortex_search(query)` — FTS5-Suche
- `cortex_context(files?)` — Kontext abrufen
- `cortex_list(type)` — decisions / errors / learnings / todos / notes
- `cortex_resolve(type, id)` — abschließen/aktualisieren
- `cortex_snooze(description, until)` — Reminder setzen

---

## Slash Commands (Skills)

| Command | Was es tut |
|---|---|
| `/resume` | Kurz-Brief: letzte Session, offene Items, geänderte Dateien |
| `/cortex-search <query>` | FTS5/BM25-Suche über alle Cortex-Daten |
| `/cortex-health` | Health-Score, Decisions, Errors, Conventions, Unfinished |
| `/cortex-file <datei>` | File-History, Dependencies, Impact-Analyse |
| `/cortex-review` | Code-Review mit automatischer Modell-Auswahl |
| `/note <text>` | Scratch-Pad-Notiz speichern |
| `/pin <regel>` | Regel als auto-blocking Learning pinnen |
| `/snooze <text> <zeit>` | Reminder für spätere Session setzen |
| `/timeline` | Monatliche Aktivitäts-Übersicht |

---

## Häufige Workflows

### Neuen MCP-Tool hinzufügen
1. Tool in `server/src/index.ts` mit Zod-Schema + `.describe()` registrieren
2. `cd server && npm run build`
3. Tool in MCP-Server-Instructions (`CORTEX_INSTRUCTIONS` in index.ts) dokumentieren
4. Falls nötig: DB-Migration in `scripts/ensure-db.js`
5. `cortex_add_decision` mit Begründung loggen

### Neuen Daemon-Agent hinzufügen
1. Datei `daemon/src/agents/<name>.ts` erstellen
2. In `daemon/src/index.ts` importieren und im richtigen Event-Handler aufrufen
3. `cd daemon && npm run build`
4. Auf Windows: claude.cmd + CLAUDECODE unset beachten

### Neues Hook-Script hinzufügen / ändern
1. Script in `scripts/` anlegen/editieren (kein npm!)
2. In `hooks/hooks.json` registrieren
3. In `README.md` dokumentieren

### Plugin-Release vorbereiten
1. `server/dist/` und `daemon/dist/` neu bauen
2. Version in `.claude-plugin/plugin.json` und `marketplace.json` bumpen
3. `README.md` aktualisieren
4. Tag + GitHub Release erstellen

---

## Bekannte Gotchas

- **Windows:** Hook-Scripts laufen in bash (Git Bash), aber Daemon braucht `claude.cmd`
- **node:sqlite:** Nur ab Node.js 22 verfügbar — immer Version prüfen
- **Nested Sessions:** `CLAUDECODE` env-var muss vor `claude -p` Subprozessen ungesetzt sein
- **DB WAL-Mode:** `.claude/cortex.db-shm` und `.claude/cortex.db-wal` sind normal, nicht löschen
- **Hook-Timeout:** SessionStart hat 15s, Stop hat 30s — Learner/Architect laufen im Daemon async
- **auto_block ohne regex:** Nur manuelle Beachtung, kein PreToolUse-Check — immer `detection_regex` setzen
