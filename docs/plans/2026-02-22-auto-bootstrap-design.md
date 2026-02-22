# Auto-Bootstrap bei erstem Start

**Datum:** 2026-02-22
**Status:** Approved

## Problem

Wenn Cortex in ein bestehendes Projekt installiert wird, ist die DB leer. Die 3 MCP-Tools (`import_git_history`, `scan_project`, `index_docs`) füllen die DB — das sollte automatisch passieren.

## Design

### Trigger

`on-session-start.js` prüft `SELECT COUNT(*) FROM project_files`. Wenn < 10, wird ein meta-Flag `needs_bootstrap=true` gesetzt.

### Ausführung

Der Daemon liest beim Start das Flag und dispatcht einen neuen `bootstrap`-Agent, der die 3 MCP-Tools via `claude -p` aufruft:
1. `import_git_history` (max 200 Commits)
2. `scan_project`
3. `index_docs`

Nach Erfolg wird das Flag gelöscht. Bei Fehler bleibt es stehen → nächster Daemon-Start versucht es erneut.

### Dashboard-Hinweis

Wenn `needs_bootstrap` gesetzt ist, zeigt der SessionStart-Hook:
```
BOOTSTRAP: Erstmalige Indexierung läuft im Hintergrund...
```

## Komponenten

| Datei | Änderung |
|---|---|
| `scripts/on-session-start.js` | COUNT-Query + meta-Flag setzen + Dashboard-Hinweis |
| `daemon/src/agents/bootstrap.ts` | Neuer Agent: 3 MCP-Tools aufrufen |
| `daemon/src/index.ts` | Nach Architect: Bootstrap-Flag prüfen + Agent dispatchen |
