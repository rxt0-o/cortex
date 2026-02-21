# Cortex Plugin Packaging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Cortex als echtes Claude Code Plugin verpacken, sodass andere User es mit `/plugin marketplace add rxt0-o/cortex` + `/plugin install cortex@rxt0-o` in einem Schritt installieren können.

**Architecture:** Das Plugin-System von Claude Code erfordert (1) ein `.claude-plugin/plugin.json` Manifest, (2) eine `.mcp.json` im Plugin-Root mit `${CLAUDE_PLUGIN_ROOT}`-Pfaden für den MCP-Server, (3) eine `marketplace.json` im Repo-Root damit das GitHub-Repo als Marketplace fungiert, und (4) pre-built `dist/`-Verzeichnisse im Repo (kein Build-Step beim User nötig). Skills müssen mit Plugin-Namespace `cortex:skillname` geprefixed werden.

**Tech Stack:** Node.js 22+, TypeScript (pre-built), Claude Code Plugin API (`${CLAUDE_PLUGIN_ROOT}` env var), GitHub als Marketplace-Host.

**Repo:** `C:/Users/toasted/Desktop/data/cortex/`

---

### Task 1: Plugin-Manifest anlegen

**Files:**
- Create: `.claude-plugin/plugin.json`

**Context:** Das ist das Herzstück des Plugin-Systems. Ohne dieses File erkennt Claude Code das Repo nicht als Plugin. Der `name`-Wert wird zum Namespace für alle Skills (`cortex:skillname`). Das Format wurde aus echten Plugins (superpowers, claude-hud) abgeleitet.

**Step 1: Verzeichnis und Manifest anlegen**

```bash
mkdir -p "C:/Users/toasted/Desktop/data/cortex/.claude-plugin"
```

Inhalt von `.claude-plugin/plugin.json`:
```json
{
  "name": "cortex",
  "description": "Persistent memory and autonomous intelligence for Claude Code — remembers sessions, learns from mistakes, maps architecture, and explains files in real-time.",
  "version": "0.2.0",
  "author": {
    "name": "rxt0-o",
    "url": "https://github.com/rxt0-o"
  },
  "homepage": "https://github.com/rxt0-o/cortex",
  "repository": "https://github.com/rxt0-o/cortex",
  "license": "MIT",
  "keywords": ["memory", "sessions", "architecture", "learning", "daemon", "context", "mcp"]
}
```

**Step 2: Verify**

```bash
cat "C:/Users/toasted/Desktop/data/cortex/.claude-plugin/plugin.json"
```
Expected: JSON wird korrekt ausgegeben.

**Step 3: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add .claude-plugin/plugin.json
git commit -m "feat: add .claude-plugin/plugin.json manifest"
```

---

### Task 2: .mcp.json für Plugin-Root anlegen

**Files:**
- Create: `.mcp.json`

**Context:** Claude Code liest `.mcp.json` aus dem Plugin-Verzeichnis und registriert den MCP-Server automatisch wenn das Plugin aktiviert ist. `${CLAUDE_PLUGIN_ROOT}` wird von Claude Code zur Plugin-Installation-Path aufgelöst (z.B. `~/.claude/plugins/cache/rxt0-o/cortex/0.2.0/`). Der `server/dist/index.js` muss bereits existieren (Task 4).

**Step 1: .mcp.json anlegen**

Inhalt von `.mcp.json` im Cortex-Repo-Root:
```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"]
    }
  }
}
```

**Step 2: Verify — Datei korrekt**

```bash
cat "C:/Users/toasted/Desktop/data/cortex/.mcp.json"
```
Expected: JSON mit `${CLAUDE_PLUGIN_ROOT}/server/dist/index.js`.

**Step 3: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add .mcp.json
git commit -m "feat: add .mcp.json with CLAUDE_PLUGIN_ROOT reference"
```

---

### Task 3: hooks/hooks.json — PostToolUse-Matcher fixen

**Files:**
- Modify: `hooks/hooks.json`

**Context:** Der PostToolUse Hook muss `Read|Write|Edit` matchen (nicht nur `Write|Edit`), damit `file_access`-Events für den Kontext-Daemon generiert werden wenn Dateien geöffnet werden. Der SessionStart-Matcher muss leer sein (`""`), nicht `"startup|resume"`, damit er bei jedem Session-Start feuert.

**Step 1: hooks/hooks.json aktualisieren**

Vollständiger neuer Inhalt von `hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/on-session-start.js",
            "timeout": 15
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/on-pre-tool-use.js",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/on-post-tool-use.js",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/on-pre-compact.js",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/on-session-end.js",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ]
  }
}
```

**Step 2: Verify**

```bash
node -e "const h = JSON.parse(require('fs').readFileSync('C:/Users/toasted/Desktop/data/cortex/hooks/hooks.json','utf-8')); console.log('PostToolUse matcher:', h.hooks.PostToolUse[0].matcher); console.log('SessionStart matcher:', JSON.stringify(h.hooks.SessionStart[0].matcher));"
```
Expected:
```
PostToolUse matcher: Read|Write|Edit
SessionStart matcher: ""
```

**Step 3: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add hooks/hooks.json
git commit -m "fix: hooks.json PostToolUse matcher Read|Write|Edit, SessionStart matcher empty"
```

---

### Task 4: server/dist/ pre-built ins Repo aufnehmen

**Files:**
- Modify: `.gitignore`
- Build: `server/dist/`

**Context:** Analog zu `daemon/dist/` (bereits getrackt) muss `server/dist/` auch im Repo liegen, damit nach Plugin-Installation der MCP-Server ohne Build-Step läuft. Die `.gitignore` hat bereits `!daemon/dist/` als Ausnahme — `!server/dist/` wird genauso hinzugefügt.

**Step 1: .gitignore updaten**

In `.gitignore` die bestehende Zeile finden:
```
!daemon/dist/
```
Darunter hinzufügen:
```
!server/dist/
```

**Step 2: server neu bauen**

```bash
cd "C:/Users/toasted/Desktop/data/cortex/server"
npm run build
```
Expected: `tsc` ohne Fehler.

**Step 3: server/dist/ zum Tracking hinzufügen**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add .gitignore server/dist/
git status
```
Expected: Viele neue `server/dist/` Dateien unter "Changes to be committed".

**Step 4: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git commit -m "chore: track server/dist for zero-build-step plugin installation"
```

---

### Task 5: marketplace.json anlegen

**Files:**
- Create: `marketplace.json`

**Context:** Claude Code unterstützt GitHub-Repos als Marketplaces. Das Format wurde aus dem claude-hud Marketplace (`jarrodwatts/claude-hud`) abgeleitet. Die `marketplace.json` muss im Repo-Root liegen. `"source": "./"` bedeutet: das Plugin liegt im Root des gleichen Repos. Nach diesem Task können User das Repo als Marketplace hinzufügen.

**Step 1: marketplace.json anlegen**

Inhalt von `marketplace.json`:
```json
{
  "name": "cortex",
  "owner": {
    "name": "rxt0-o",
    "url": "https://github.com/rxt0-o"
  },
  "metadata": {
    "description": "Persistent memory and autonomous intelligence for Claude Code",
    "version": "0.2.0"
  },
  "plugins": [
    {
      "name": "cortex",
      "source": "./",
      "description": "Persistent memory, autonomous background agents, and real-time architecture insights for Claude Code. Tracks sessions, maps your full-stack, explains files on open, and learns from every mistake.",
      "category": "productivity",
      "tags": ["memory", "sessions", "architecture", "daemon", "mcp", "context", "learning"]
    }
  ]
}
```

**Step 2: Verify**

```bash
node -e "const m = JSON.parse(require('fs').readFileSync('C:/Users/toasted/Desktop/data/cortex/marketplace.json','utf-8')); console.log('Plugin name:', m.plugins[0].name); console.log('Source:', m.plugins[0].source);"
```
Expected:
```
Plugin name: cortex
Source: ./
```

**Step 3: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add marketplace.json
git commit -m "feat: add marketplace.json for /plugin marketplace add rxt0-o/cortex"
```

---

### Task 6: Skills mit Plugin-Namespace prefixen

**Files:**
- Modify: `skills/cortex-conventions/SKILL.md`
- Modify: `skills/cortex-decisions/SKILL.md`
- Modify: `skills/cortex-deps/SKILL.md`
- Modify: `skills/cortex-errors/SKILL.md`
- Modify: `skills/cortex-health/SKILL.md`
- Modify: `skills/cortex-history/SKILL.md`
- Modify: `skills/cortex-map/SKILL.md`
- Modify: `skills/cortex-search/SKILL.md`
- Modify: `skills/cortex-unfinished/SKILL.md`

**Context:** Claude Code prefixed Skills automatisch mit dem Plugin-Namen aus `plugin.json`. Um Konflikte mit anderen Plugins zu vermeiden und die Skills eindeutig auffindbar zu machen, muss das `name`-Feld im Frontmatter jeder SKILL.md von `cortex-search` auf `cortex:cortex-search` geändert werden. Der User ruft sie dann mit `/cortex:cortex-search` auf.

**Step 1: Alle 9 SKILL.md Frontmatter-Namen updaten**

Für jede Datei: `name: cortex-X` → `name: cortex:cortex-X`

Konkret — in `skills/cortex-search/SKILL.md`:
```
name: cortex:cortex-search
```
In `skills/cortex-map/SKILL.md`:
```
name: cortex:cortex-map
```
In `skills/cortex-deps/SKILL.md`:
```
name: cortex:cortex-deps
```
In `skills/cortex-history/SKILL.md`:
```
name: cortex:cortex-history
```
In `skills/cortex-decisions/SKILL.md`:
```
name: cortex:cortex-decisions
```
In `skills/cortex-errors/SKILL.md`:
```
name: cortex:cortex-errors
```
In `skills/cortex-health/SKILL.md`:
```
name: cortex:cortex-health
```
In `skills/cortex-unfinished/SKILL.md`:
```
name: cortex:cortex-unfinished
```
In `skills/cortex-conventions/SKILL.md`:
```
name: cortex:cortex-conventions
```

**Step 2: Verify**

```bash
grep "^name:" C:/Users/toasted/Desktop/data/cortex/skills/*/SKILL.md
```
Expected: Alle zeigen `name: cortex:cortex-X`.

**Step 3: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add skills/
git commit -m "feat: prefix skill names with cortex: namespace"
```

---

### Task 7: README.md — Installationssektion auf Plugin-Flow umschreiben

**Files:**
- Modify: `README.md`

**Context:** Die aktuelle README beschreibt manuelles Klonen + settings.json bearbeiten. Das ist jetzt obsolet. Die neue Installationssektion zeigt den Ein-Befehl-Flow. Die restliche README (Architektur, Tools, Hooks-Tabelle) bleibt unverändert.

**Step 1: Installation-Sektion in README ersetzen**

Den Block von `## Installation` bis zum nächsten `---` ersetzen mit:

```markdown
## Installation

```bash
/plugin marketplace add rxt0-o/cortex
/plugin install cortex@rxt0-o
```

Das war's. Cortex registriert Hooks, MCP-Server und Skills automatisch.

**Requirements:** Node.js >= 22, Claude Code CLI

### Manual Installation (alternative)

Falls du das Plugin lieber manuell einrichten willst:

```bash
git clone https://github.com/rxt0-o/cortex.git
```

Add to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-session-start.js", "timeout": 15 }] }],
    "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-pre-tool-use.js", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "Read|Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-post-tool-use.js", "timeout": 10 }] }],
    "PreCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-pre-compact.js", "timeout": 15 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/cortex/scripts/on-session-end.js", "timeout": 30 }] }]
  }
}
```

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/server/dist/index.js"]
    }
  }
}
```
```

**Step 2: Verify — README öffnen und Installationssektion prüfen**

```bash
grep -A 5 "## Installation" C:/Users/toasted/Desktop/data/cortex/README.md
```
Expected: Zeigt `/plugin marketplace add rxt0-o/cortex`.

**Step 3: Commit**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git add README.md
git commit -m "docs: update README installation to one-command plugin install"
```

---

### Task 8: Push und End-to-End Verify

**Context:** Alle Änderungen pushen und verifizieren dass das Plugin korrekt paketiert ist.

**Step 1: Alles pushen**

```bash
cd "C:/Users/toasted/Desktop/data/cortex"
git push origin main
```

**Step 2: Plugin-Struktur final verifizieren**

```bash
node -e "
const fs = require('fs');
const checks = [
  ['.claude-plugin/plugin.json', 'Plugin-Manifest'],
  ['.mcp.json', 'MCP-Server-Config'],
  ['marketplace.json', 'Marketplace-Definition'],
  ['hooks/hooks.json', 'Hooks-Config'],
  ['server/dist/index.js', 'MCP-Server pre-built'],
  ['daemon/dist/index.js', 'Daemon pre-built'],
];
let ok = true;
for (const [f, label] of checks) {
  const exists = fs.existsSync('C:/Users/toasted/Desktop/data/cortex/' + f);
  console.log((exists ? '✓' : '✗') + ' ' + label + ': ' + f);
  if (!exists) ok = false;
}
console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.');
"
```
Expected: Alle 6 Checks mit ✓.

**Step 3: marketplace.json JSON-Validität prüfen**

```bash
node -e "JSON.parse(require('fs').readFileSync('C:/Users/toasted/Desktop/data/cortex/marketplace.json','utf-8')); console.log('marketplace.json valid JSON');"
node -e "JSON.parse(require('fs').readFileSync('C:/Users/toasted/Desktop/data/cortex/.mcp.json','utf-8')); console.log('.mcp.json valid JSON');"
node -e "JSON.parse(require('fs').readFileSync('C:/Users/toasted/Desktop/data/cortex/.claude-plugin/plugin.json','utf-8')); console.log('plugin.json valid JSON');"
```
Expected: Alle drei zeigen `valid JSON`.
