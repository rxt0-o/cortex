# Cortex Monitoring-Erweiterung — Design

**Datum:** 2026-02-22
**Inspiration:** anthropics/riv2025-long-horizon-coding-agent-demo, anthropics/claude-code-monitoring-guide

---

## Ziel

Drei Monitoring-Features für Cortex:
1. **Daemon Heartbeat + Watcher** — Auto-Restart bei Absturz
2. **Session-Metriken via OTEL** — Token/Kosten-Tracking
3. **Agent Health-Monitoring** — Sichtbarkeit über Daemon-Agent-Läufe

---

## 1. Daemon Heartbeat + Watcher

### Daemon-Seite
- `daemon/src/index.ts`: `setInterval` alle 30s schreibt `Date.now()` in `.claude/cortex-daemon.heartbeat`
- Beim sauberen Stop: Heartbeat-Datei löschen

### Watcher-Prozess (`daemon/src/watcher.ts`)
- Separater schlanker Node.js-Prozess (kein Claude-Aufruf, kein npm-Dependency)
- Eigene PID-Datei: `.claude/cortex-watcher.pid`
- Pollt alle 15s:
  - Heartbeat-Datei vorhanden? Timestamp < 90s? → OK
  - Sonst: Daemon-PID prüfen, falls tot → Daemon neu starten
- Watcher hat kein eigenes Recovery (bewusst minimal)

### Hook-Seite (`scripts/on-session-start.js`)
- Watcher starten (analog zur heutigen Daemon-Start-Logik)
- PID-Check: Falls Watcher bereits läuft → überspringen

### Dateien
- `.claude/cortex-daemon.heartbeat` — Timestamp (Unix ms, plain text)
- `.claude/cortex-watcher.pid` — PID des Watcher-Prozesses

---

## 2. Session-Metriken via OTEL

### Datenquelle
Claude Code exportiert Telemetry via OpenTelemetry wenn `CLAUDE_CODE_ENABLE_TELEMETRY=1` gesetzt ist. Events landen als JSONL in einer lokalen Datei (Standard: `~/.claude/telemetry.jsonl` oder via `OTEL_EXPORTER_OTLP_ENDPOINT`).

### on-session-end.js
- Liest OTEL-JSONL der letzten Session
- Filtert nach aktuellem `session_id`
- Extrahiert: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `duration_ms`
- Speichert in `session_metrics` Tabelle
- Graceful wenn OTEL nicht aktiv ist (kein Fehler, kein Eintrag)

### DB-Schema (neu in ensure-db.js)
```sql
CREATE TABLE IF NOT EXISTS session_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  recorded_at TEXT NOT NULL
);
```

### MCP-Tool: `cortex_session_metrics`
- Parameter: `limit` (default 10), `aggregate` (bool — Ø-Werte über alle Sessions)
- Output: Token-Trends, Kosten pro Session, Cache-Effizienz-Rate

### cortex_get_health-Erweiterung
- Neuer Block: Ø `cost_usd` letzte 7 Sessions, gesamt `output_tokens`, Cache-Hit-Rate

---

## 3. Agent Health-Monitoring

### DB-Schema (neu in ensure-db.js)
```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  items_saved INTEGER DEFAULT 0
);
```

### runner.ts-Erweiterung
- `RunnerOptions` bekommt optionales `agentName` Feld
- Vor dem Spawn: `agent_runs` Eintrag anlegen, ID zurückgeben
- Nach `proc.on('close')`: Eintrag mit `finished_at`, `duration_ms`, `success`, `error_message` updaten
- DB-Verbindung im Runner: direkt per `DatabaseSync` (projektPath als Parameter)

### Jeder Agent übergibt `items_saved`
- `runLearnerAgent` gibt `saved` Count zurück (bereits vorhanden, nur noch loggen)
- Andere Agents analog

### MCP-Tool: `cortex_agent_status`
- Parameter: `limit` (default letzte 5 Sessions), `agent_name` (optional Filter)
- Output: Agent-Runs mit Dauer, Erfolg/Fehler, Items-Count

### cortex_get_health-Erweiterung
- Neuer Block: Agent-Erfolgsrate letzte 30 Tage, letzte Fehler

---

## Gesamtübersicht der Änderungen

| Datei | Änderung |
|---|---|
| `daemon/src/watcher.ts` | Neu: Watcher-Prozess |
| `daemon/src/index.ts` | Heartbeat-Writes alle 30s + Watcher-Build |
| `daemon/src/runner.ts` | agentName-Parameter + agent_runs-Logging |
| `scripts/on-session-start.js` | Watcher starten (PID-Check) |
| `scripts/on-session-end.js` | OTEL-Metriken lesen + in session_metrics speichern |
| `scripts/ensure-db.js` | 2 neue Tabellen: session_metrics, agent_runs |
| `server/src/tools/stats.ts` | cortex_session_metrics + cortex_agent_status |
| `server/src/index.ts` | Neue Tools registrieren |
| `daemon/package.json` | Watcher als zweites Build-Target |

---

## Nicht-Ziele

- Kein Prometheus/Grafana — Daten bleiben in SQLite
- Kein externer OTEL-Collector — nur lokale JSONL-Datei lesen
- Kein Watcher-Recovery (Watcher selbst wird nicht überwacht)
