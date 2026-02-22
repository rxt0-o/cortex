# Cortex — Architecture Reference

## Datenfluss

```
User-Session
    │
    ▼
SessionStart Hook (on-session-start.js, 15s timeout)
    ├── ensure-db.js → .claude/cortex.db (erstellen + migrieren)
    ├── DB abfragen → Dashboard zusammenbauen
    ├── additionalContext → Claude (unsichtbar für User)
    └── Daemon starten (PID-Check → spawn node daemon/dist/index.js)
    │
    ▼
Claude-Session läuft
    │
    ├── PreToolUse (Write/Edit) → on-pre-tool-use.js
    │       ├── Learnings mit detection_regex → Block (severity: high) oder Warn
    │       ├── Error prevention_rules → Block
    │       ├── Convention violation_pattern → Warn
    │       └── Passive: Hot Zone / Recent Error / Decision → Info
    │
    ├── PostToolUse (Read/Write/Edit) → on-post-tool-use.js
    │       ├── Diff speichern → diffs Tabelle
    │       ├── Import-Graph aktualisieren → dependencies Tabelle
    │       └── file_access Event → .claude/cortex-events.jsonl
    │
    └── UserPromptSubmit → on-user-prompt-submit.js
            └── Context-Window-Größe warnen (Schwellen: 0.75/0.92/1.03 MB)
    │
    ▼
SessionEnd Hook (on-session-end.js, 30s timeout)
    ├── Session-Summary + Health-Snapshot speichern
    └── session_end Event → .claude/cortex-events.jsonl
    │
    ▼ (parallel, im Daemon)
Daemon-Agenten (daemon/dist/index.js, 500ms Queue-Poll)
    ├── file_access → Context Agent (60s debounce pro Datei)
    └── session_end →
            ├── Learner Agent (Transcript → Learnings/Facts/Insights, Sonnet)
            ├── Drift Detector Agent (max 1x/22h)
            ├── Synthesizer Agent (alle 10 Sessions)
            ├── Serendipity Agent (zufällige alte Erkenntnisse)
            └── MoodScorer Agent (Session-Stimmung)
```

## DB-Tabellen (15)

| Tabelle | Inhalt |
|---|---|
| `sessions` | Session-Summaries, Status, Tags, Sentiment |
| `decisions` | Architektur-Entscheidungen mit Reasoning |
| `errors` | Bugs + Root Cause + Fix + Prevention Rule |
| `learnings` | Anti-Patterns + detection_regex (auto_block) |
| `facts` | Konkrete Beobachtungen (File-Rollen, Patterns) |
| `insights` | Breitere Erkenntnisse (vom Learner Agent) |
| `project_modules` | Architektur-Module |
| `project_files` | Bekannte Dateien + change_count |
| `dependencies` | Import-Graph (Datei → importiert von) |
| `diffs` | Gespeicherte Änderungen pro Session |
| `conventions` | Coding-Konventionen + violation_pattern |
| `unfinished` | Offene Tasks + Snooze + Intent |
| `health_snapshots` | Täglicher Health-Score + Trend |
| `notes` | Scratch-Pad-Notizen |
| `schema_version` | Migrations-Tracking |

## Hook-Sequenz

```
SessionStart → [PreToolUse / PostToolUse / UserPromptSubmit]* → PreCompact? → Stop
```

Jeder Hook liest Input via `stdin` (JSON), schreibt Output via `stdout` (JSON) oder `stderr` (Fehler).
Timeout-Überschreitung → Hook wird abgebrochen, Session läuft weiter.

## Event Queue

Datei: `.claude/cortex-events.jsonl` (append-only, ein JSON-Objekt pro Zeile)

```jsonl
{"type":"file_access","file":"/abs/path/file.ts","session_id":"abc","ts":"2026-02-22T10:00:00Z"}
{"type":"session_end","session_id":"abc","transcript_path":"/path/.claude/projects/.../transcript.jsonl","session_id":"abc","ts":"2026-02-22T11:00:00Z"}
```

Daemon markiert verarbeitete Events mit `"processed":true` — Datei wird nicht geleert.

## MCP-Server

Kommunikation: stdio (stdin/stdout JSON-RPC)
Registrierung: `.mcp.json` im Projektverzeichnis
Tools: 55 (siehe README.md für vollständige Liste)
Build: `cd server && npm run build` → `server/dist/bundle.js`

## Wichtige Dateipfade

| Pfad | Was |
|---|---|
| `.claude/cortex.db` | SQLite-Datenbank (pro Projekt) |
| `.claude/cortex-events.jsonl` | Event-Queue für Daemon |
| `.claude/cortex-feedback.jsonl` | Context-Agent-Output (PostToolUse) |
| `.claude/cortex-daemon.pid` | PID des laufenden Daemons |
| `scripts/ensure-db.js` | DB-Init + Schema-Migrationen |
| `server/dist/bundle.js` | Kompilierter MCP-Server |
| `daemon/dist/index.js` | Kompilierter Daemon |
| `.claude-plugin/plugin.json` | Plugin-Manifest |
| `marketplace.json` | Marketplace-Listing |
