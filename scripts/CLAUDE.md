# Cortex Hook-Scripts

6 plain Node.js Scripts. Kein npm. Nur Node.js stdlib (`node:sqlite`, `fs`, `path`, `child_process`).
Laufen synchron als Claude Code Hooks. Zero Latenz ist Pflicht.

## Scripts

| Script | Hook | Timeout | Kann blockieren? |
|---|---|---|---|
| `on-session-start.js` | SessionStart | 15s | Nein |
| `on-user-prompt-submit.js` | UserPromptSubmit | 5s | Nein |
| `on-pre-tool-use.js` | PreToolUse (Write/Edit) | 5s | Ja (deny) |
| `on-post-tool-use.js` | PostToolUse (Read/Write/Edit) | 10s | Nein |
| `on-pre-compact.js` | PreCompact | 15s | Nein |
| `on-session-end.js` | Stop | 30s | Nein |
| `ensure-db.js` | (wird von anderen importiert) | — | — |

## Hook-Input lesen

```js
import { readFileSync } from 'fs';
const input = JSON.parse(readFileSync(0, 'utf-8'));
const { session_id, cwd, tool_name, tool_input, source } = input;
```

## Hook-Output Format

```js
// Kontext für Claude injizieren (unsichtbar für User):
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'Text den Claude sieht',
  }
}));

// Tool blockieren (PreToolUse only):
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: '[CORTEX] Grund für Block',
    additionalContext: 'Detaillierter Kontext für Claude',
  }
}));

// Warning ohne Block (PreToolUse):
process.stdout.write(JSON.stringify({
  systemMessage: 'Cortex warning: ...',
}));
```

## Fehlerbehandlung

```js
// IMMER so — niemals process.exit(1):
try { main(); } catch (err) {
  process.stderr.write(`Cortex <HookName> error: ${err.message}\n`);
  process.exit(0);  // 0 = Hook läuft weiter, blockiert nicht
}
```

## DB öffnen

```js
import { openDb } from './ensure-db.js';
const db = openDb(cwd);  // Erstellt DB falls nicht vorhanden, führt Migrationen aus
try {
  // ... queries
} finally {
  db.close();
}
```

## Schema-Migration hinzufügen

In `ensure-db.js` → `openDb()` → Array `migrations`:
```js
`ALTER TABLE <tabelle> ADD COLUMN <spalte> <typ>`,
```
Jede Migration in eigenem try/catch (schlägt fehl wenn Spalte bereits existiert — das ist OK).
