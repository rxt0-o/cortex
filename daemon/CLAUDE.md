# Cortex Daemon

Autonomer Hintergrundprozess. Startet beim SessionStart-Hook via PID-File-Check.
Pollt `.claude/cortex-events.jsonl` alle 500ms und dispatcht Arbeit an Agenten.

## Build

```bash
npm run build   # erzeugt dist/index.js
```

## Architektur

```
daemon/src/
├── index.ts                    # Entry point: PID-Mgmt, Queue-Polling, Agent-Dispatch
├── runner.ts                   # claude -p Subprozess-Runner (serial queue)
├── queue.ts                    # JSONL event queue reader/writer
└── agents/
    ├── architect.ts            # Einmalig beim Start: Architektur-Mapping
    ├── context.ts              # file_access → File-Summary (60s debounce)
    ├── learner.ts              # session_end → Transcript-Analyse (Sonnet)
    ├── drift-detector.ts       # session_end → Architektur-Drift (max 1x/22h)
    ├── synthesizerAgent.ts     # Alle 10 Sessions → Memory-Verdichtung
    ├── serendipityAgent.ts     # session_end → Zufällige alte Erkenntnisse
    └── moodScorer.ts           # session_end → Session-Stimmung
```

## Event Queue Format

```jsonl
{"type":"file_access","file":"/abs/path","session_id":"abc","ts":"2026-..."}
{"type":"session_end","session_id":"abc","transcript_path":"/path/transcript.jsonl","ts":"..."}
```

Verarbeitete Events werden mit `processed: true` markiert, nicht gelöscht.

## Windows-Regeln (WICHTIG)

```typescript
// claude CLI Pfad:
const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';

// CLAUDECODE env-var unsetzen (verhindert "nested session"-Error):
const env = { ...process.env };
delete env.CLAUDECODE;
spawn(claudeCmd, [...], { env });
```

## Neuen Agent hinzufügen

1. `daemon/src/agents/<name>.ts` erstellen
2. Export: `export async function run<Name>Agent(projectPath: string, ...): Promise<void>`
3. In `daemon/src/index.ts` importieren und im richtigen Event-Handler mit `.catch()` aufrufen
4. `npm run build`

## Modell-Wahl

| Agent | Modell | Grund |
|---|---|---|
| Learner | claude-sonnet-4-5 | Komplexe Analyse, hohe Qualität |
| Architect | claude-haiku-4-5 | Schnell, Struktur-Mapping |
| Context | claude-haiku-4-5 | Debounced, viele Calls |
| DriftDetector | claude-haiku-4-5 | Einfacher Vergleich |
| MoodScorer | claude-haiku-4-5 | Sentimentklassifikation |
