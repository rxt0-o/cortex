# Cortex Mega-Upgrade: Hook-Qualität + Hookify-Hybrid + Agenten-Kontext-Pipeline

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cortex durch drei unabhängige Verbesserungen signifikant stärken: Hook-Validierung, hookify-kompatibles `/pin`, und reichhaltigere Agenten-Kontext-Pipeline.

**Architecture:**
- **A) Hook-Qualität:** `plugin-dev` installieren, `hooks/hooks.json` mit Schema-Validator prüfen, Befunde bereinigen
- **B) Hookify-Hybrid:** `/pin`-Skill schreibt DB-Learning (wie bisher) + `.claude/cortex-pins.local.md` (hookify-Format); Pre-Tool-Use-Hook lädt diese Rules live
- **C) Agenten-Kontext-Pipeline:** `runner.ts` erhält `buildAgentContext()`-Funktion; Learner + DriftDetector erhalten strukturierten Context-Block mit Diffs, Hot Zones, Session-Delta

**Tech Stack:** Node.js ESM, TypeScript (daemon/server), SQLite node:sqlite, hookify YAML-Frontmatter

---

## Teil A: Hook-Qualität via plugin-dev

### Task A1: plugin-dev installieren

**Files:**
- Kein File-Change — Installation via Claude Code CLI

**Step 1: plugin-dev installieren**

```bash
/plugin install plugin-dev@claude-code-marketplace
```

Expected: Plugin erscheint in Claude Code, Skills wie `plugin-dev:hook-development` verfügbar

**Step 2: Hook-Schema validieren**

Frage den plugin-dev Skill: "Validate my hooks.json against the hook schema"

Zeige ihm den Inhalt von `hooks/hooks.json`.

**Step 3: Befunde dokumentieren**

Notiere alle Schema-Probleme als Cortex-Learnings:
```
/pin Hookify-Schema: [gefundene Issues]
```

**Step 4: Commit (falls hooks.json geändert)**

```bash
git add hooks/hooks.json
git commit -m "fix: hooks.json schema validation via plugin-dev"
```

---

## Teil B: Hookify-Hybrid für /pin

### Task B1: /pin Skill erweitern — hookify .md-File schreiben

**Files:**
- Modify: `skills/pin/SKILL.md`

**Aktueller Skill-Inhalt:**
```
Extract the rule from user message.
Call cortex_add_learning with:
- anti_pattern: negative form of rule
- correct_pattern: correct alternative or Avoid: [rule]
- context: Pinned by user
- severity: high
Confirm: Pinned permanently. Will block future violations.
```

**Step 1: Neuen Skill-Inhalt schreiben**

Ersetze `skills/pin/SKILL.md` mit:

```markdown
---
name: pin
description: Pin a rule as permanent high-severity auto-blocking learning
---
Extract the rule from the user message.

Step 1 — DB Learning:
Call cortex_add_learning with:
- anti_pattern: negative form of rule
- correct_pattern: correct alternative or "Avoid: [rule]"
- context: Pinned by user
- severity: high
- auto_block: true
- detection_regex: derive a regex if possible, else null

Step 2 — Hookify File:
Append to `.claude/cortex-pins.local.md` (create if not exists):

```yaml
---
name: pin-[slugified-rule]
enabled: true
event: all
action: block
pattern: [detection_regex or key term]
---

🚫 **Pinned Rule Violation**
Rule: [anti_pattern]
Correct: [correct_pattern]
```

Step 3 — Confirm:
"Pinned permanently in DB + hookify file. Auto-blocks future violations."
```

**Step 2: Commit**

```bash
git add skills/pin/SKILL.md
git commit -m "feat: /pin schreibt hookify-kompatible .md-Rule zusaetzlich zur DB"
```

---

### Task B2: on-pre-tool-use.js — cortex-pins.local.md laden

**Files:**
- Modify: `scripts/on-pre-tool-use.js`

**Step 1: Aktuelle on-pre-tool-use.js lesen**

```bash
cat scripts/on-pre-tool-use.js
```

**Step 2: Hook-Loading für cortex-pins.local.md hinzufügen**

Füge am Anfang des Pre-Tool-Use Hooks eine Funktion hinzu, die `.claude/cortex-pins.local.md` parst und gegen den aktuellen Tool-Input matcht:

```javascript
// Hookify-kompatible cortex-pins laden
function loadPinRules(claudeDir) {
  const pinsFile = join(claudeDir, 'cortex-pins.local.md');
  if (!existsSync(pinsFile)) return [];
  try {
    const content = readFileSync(pinsFile, 'utf-8');
    const rules = [];
    // YAML-Frontmatter-Blöcke parsen: --- ... ---
    const blocks = content.split(/^---$/m).filter(Boolean);
    for (let i = 0; i < blocks.length - 1; i += 2) {
      const yaml = blocks[i].trim();
      const message = blocks[i + 1]?.trim() ?? '';
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      const patternMatch = yaml.match(/^pattern:\s*(.+)$/m);
      const enabledMatch = yaml.match(/^enabled:\s*(.+)$/m);
      if (!patternMatch) continue;
      const enabled = enabledMatch ? enabledMatch[1].trim() !== 'false' : true;
      if (!enabled) continue;
      rules.push({
        name: nameMatch?.[1]?.trim() ?? 'unnamed',
        pattern: patternMatch[1].trim(),
        message,
      });
    }
    return rules;
  } catch { return []; }
}
```

Dann im Haupt-Check: Wenn `toolName` `Write` oder `Edit` ist, prüfe neuen Content gegen alle Pin-Rules:

```javascript
const pinRules = loadPinRules(claudeDir);
for (const rule of pinRules) {
  try {
    const regex = new RegExp(rule.pattern, 'i');
    const contentToCheck = input?.content ?? input?.new_string ?? '';
    if (regex.test(contentToCheck)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: `Pinned Rule: ${rule.name}\n${rule.message}`,
        }
      }));
      process.exit(0);
    }
  } catch { /* ungültige Regex ignorieren */ }
}
```

**Step 3: Testen**

Erstelle manuell eine Test-Pin-Rule in `.claude/cortex-pins.local.md`:
```yaml
---
name: pin-test-rule
enabled: true
event: all
action: block
pattern: CORTEX_TEST_BLOCK_ME
---

🚫 Test-Rule — wird wieder gelöscht
```

Versuche dann eine Datei zu schreiben mit dem Text `CORTEX_TEST_BLOCK_ME` — Hook muss blockieren.

**Step 4: Test-Rule löschen, committen**

```bash
# Test-Rule aus .claude/cortex-pins.local.md löschen
git add scripts/on-pre-tool-use.js
git commit -m "feat: on-pre-tool-use laedt cortex-pins.local.md hookify-Rules"
```

---

## Teil C: Agenten-Kontext-Pipeline

### Task C1: buildAgentContext() in runner.ts

**Files:**
- Modify: `daemon/src/runner.ts`

**Step 1: `buildAgentContext()` Funktion hinzufügen**

Füge nach den bestehenden Imports und vor `findClaudeBin()` ein:

```typescript
export interface AgentContext {
  recentDiffs: Array<{ file_path: string; created_at: string; diff_preview: string }>;
  hotZones: Array<{ path: string; access_count: number }>;
  sessionDelta: {
    newErrors: number;
    newLearnings: number;
    newDecisions: number;
  };
  lastAgentRun: { agent_name: string; started_at: string; success: boolean } | null;
}

export function buildAgentContext(projectPath: string, agentName?: string): AgentContext {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) {
    return { recentDiffs: [], hotZones: [], sessionDelta: { newErrors: 0, newLearnings: 0, newDecisions: 0 }, lastAgentRun: null };
  }
  try {
    const db = new DatabaseSync(dbPath);

    // Letzte 10 Diffs (letzte 2h)
    const recentDiffs = db.prepare(`
      SELECT file_path, created_at, SUBSTR(diff_text, 1, 200) as diff_preview
      FROM diffs
      WHERE created_at > datetime('now', '-2 hours')
      ORDER BY created_at DESC
      LIMIT 10
    `).all() as Array<{ file_path: string; created_at: string; diff_preview: string }>;

    // Top 5 Hot Zones
    const hotZones = db.prepare(`
      SELECT path, access_count FROM project_files
      WHERE access_count > 0
      ORDER BY access_count DESC
      LIMIT 5
    `).all() as Array<{ path: string; access_count: number }>;

    // Session-Delta: neue Items in letzten 2h
    const newErrors = (db.prepare(`SELECT COUNT(*) as n FROM errors WHERE first_seen > datetime('now', '-2 hours')`).get() as any)?.n ?? 0;
    const newLearnings = (db.prepare(`SELECT COUNT(*) as n FROM learnings WHERE created_at > datetime('now', '-2 hours') AND archived = 0`).get() as any)?.n ?? 0;
    const newDecisions = (db.prepare(`SELECT COUNT(*) as n FROM decisions WHERE created_at > datetime('now', '-2 hours') AND archived != 1`).get() as any)?.n ?? 0;

    // Letzter Lauf dieses Agents
    const lastAgentRun = agentName
      ? db.prepare(`SELECT agent_name, started_at, success FROM agent_runs WHERE agent_name = ? ORDER BY started_at DESC LIMIT 1`).get(agentName) as any
      : null;

    db.close();
    return {
      recentDiffs,
      hotZones,
      sessionDelta: { newErrors, newLearnings, newDecisions },
      lastAgentRun,
    };
  } catch {
    return { recentDiffs: [], hotZones: [], sessionDelta: { newErrors: 0, newLearnings: 0, newDecisions: 0 }, lastAgentRun: null };
  }
}

export function formatAgentContext(ctx: AgentContext): string {
  const parts: string[] = [];

  if (ctx.recentDiffs.length > 0) {
    parts.push(`<recent_diffs>\n${ctx.recentDiffs.map(d =>
      `${d.file_path} [${d.created_at.slice(11, 16)}]: ${d.diff_preview?.replace(/\n/g, ' ').slice(0, 100) ?? ''}`
    ).join('\n')}\n</recent_diffs>`);
  }

  if (ctx.hotZones.length > 0) {
    parts.push(`<hot_zones>\n${ctx.hotZones.map(h => `${h.path} (${h.access_count}x)`).join('\n')}\n</hot_zones>`);
  }

  const { newErrors, newLearnings, newDecisions } = ctx.sessionDelta;
  if (newErrors + newLearnings + newDecisions > 0) {
    parts.push(`<session_delta>Letzte 2h: ${newErrors} neue Errors, ${newLearnings} neue Learnings, ${newDecisions} neue Decisions</session_delta>`);
  }

  return parts.length > 0 ? `\n<agent_context>\n${parts.join('\n')}\n</agent_context>\n` : '';
}
```

**Step 2: Bauen und prüfen**

```bash
cd daemon && npm run build 2>&1
```

Expected: Kein TypeScript-Fehler.

**Step 3: Commit**

```bash
git add daemon/src/runner.ts daemon/dist/index.js
git commit -m "feat: buildAgentContext + formatAgentContext in runner.ts"
```

---

### Task C2: Learner-Agent — Context-Block einbinden

**Files:**
- Modify: `daemon/src/agents/learner.ts`

**Step 1: Import ergänzen**

Füge am Anfang von `learner.ts` hinzu:

```typescript
import { buildAgentContext, formatAgentContext } from '../runner.js';
```

**Step 2: Context vor dem Prompt aufbauen**

Direkt nach dem `db`-Open in `runLearnerAgent`, füge ein:

```typescript
const agentCtx = buildAgentContext(projectPath, 'learner');
const contextBlock = formatAgentContext(agentCtx);
```

**Step 3: Context in den Prompt einbetten**

Ersetze in der `prompt`-Variable den Abschnitt `<session_data>` so, dass der Context-Block am Anfang eingefügt wird:

```typescript
const prompt = `<role>
Du bist ein Code-Qualitaets-Analyst. Analysiere die letzte Coding-Session und extrahiere strukturiertes Wissen.
</role>
${contextBlock}
<session_data>
...
```

**Step 4: Bauen**

```bash
cd daemon && npm run build 2>&1
```

**Step 5: Commit**

```bash
git add daemon/src/agents/learner.ts daemon/dist/index.js
git commit -m "feat: learner-agent erhaelt strukturierten context-block (diffs, hot zones, delta)"
```

---

### Task C3: DriftDetector-Agent — Context-Block einbinden

**Files:**
- Modify: `daemon/src/agents/drift-detector.ts`

**Step 1: Import ergänzen**

```typescript
import { buildAgentContext, formatAgentContext } from '../runner.js';
```

**Step 2: Context aufbauen und in Prompt einbetten**

Direkt nach dem 22h-Check, vor dem eigentlichen Prompt:

```typescript
const agentCtx = buildAgentContext(projectPath, 'drift-detector');
const contextBlock = formatAgentContext(agentCtx);
```

Füge `${contextBlock}` am Anfang des DriftDetector-Prompts ein — nach der Einleitung, vor `ARCHITECTURAL DECISIONS:`.

**Step 3: Bauen**

```bash
cd daemon && npm run build 2>&1
```

**Step 4: Commit**

```bash
git add daemon/src/agents/drift-detector.ts daemon/dist/index.js
git commit -m "feat: drift-detector erhaelt strukturierten context-block"
```

---

### Task C4: Final-Commit und Release-Vorbereitung

**Step 1: Alle Änderungen prüfen**

```bash
git log --oneline -8
git status
```

**Step 2: cortex_add_decision**

```
cortex_add_decision:
- title: "Hookify-Hybrid: /pin schreibt DB + .md-File"
- category: architecture
- reasoning: "DB-Eintrag für cortex_check_regression beibehalten, hookify .md für Portabilität und Live-Loading ohne DB-Abhängigkeit"
```

**Step 3: cortex_add_decision**

```
cortex_add_decision:
- title: "buildAgentContext() zentralisiert Context-Aufbereitung für alle Agenten"
- category: architecture
- reasoning: "Alle Agenten erhalten denselben strukturierten Context-Block (Diffs, Hot Zones, Session-Delta) — bessere Inputs = bessere Agent-Outputs ohne Prompt-Engineering"
```

**Step 4: Daemon bauen (final)**

```bash
cd daemon && npm run build 2>&1
```
