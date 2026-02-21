# Cortex Plugin Packaging — Design

**Datum:** 2026-02-21
**Ziel:** Cortex als echtes Claude Code Plugin veröffentlichen, das andere User mit einem einzigen Befehl installieren können.

## Installationsflow (nach Umsetzung)

```
/plugin marketplace add rxt0-o/cortex
/plugin install cortex@rxt0-o
```

Fertig. Keine manuellen Pfade, kein Clone, kein settings.json bearbeiten.

## Änderungen

### Neu: `.claude-plugin/plugin.json`
Plugin-Manifest — macht das Repo zum offiziellen Claude Code Plugin.

### Neu: `.mcp.json` (Plugin-Root)
MCP-Server-Referenz mit `${CLAUDE_PLUGIN_ROOT}`:
```json
{ "mcpServers": { "cortex": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"] } } }
```

### Update: `hooks/hooks.json`
PostToolUse-Matcher auf `Read|Write|Edit` erweitern (war noch auf altem Stand `Write|Edit`).

### Update: `.gitignore`
`!server/dist/` hinzufügen — pre-built MCP-Server wird getrackt.

### Neu: `marketplace.json`
Damit `/plugin marketplace add rxt0-o/cortex` funktioniert.

### Update: `skills/*/SKILL.md`
Frontmatter-`name` auf `cortex:skillname` setzen (Plugin-Namespace).

### Update: `README.md`
Installationssektion auf Ein-Befehl-Flow umschreiben.

### Build: `server/dist/` committen
Analog zu `daemon/dist/` — einmalig ins Repo.

## Entscheidungen

- **Pre-built dist**: Kein npm install beim User nötig. Einfachster möglicher Installationsflow.
- **`${CLAUDE_PLUGIN_ROOT}`**: Alle Pfade relativ zum Plugin-Verzeichnis — funktioniert für jeden User unabhängig vom Clone-Pfad.
- **Marketplace via eigenem Repo**: `rxt0-o/cortex` dient gleichzeitig als Plugin-Source und Marketplace.
