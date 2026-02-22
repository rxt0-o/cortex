# MCP Tool Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** CORTEX_INSTRUCTIONS auf ~10 Zeilen kürzen + `cortex_load_tools` Meta-Tool hinzufügen, das detaillierte Nutzungs-Guidance pro Kategorie liefert; SessionStart preloaded `memory` + `tracking` automatisch.

**Architecture:** Alle 55 Tools bleiben mit vollen MCP-Descriptions registriert (kein Behavior-Change). Ein neues Modul `tool-registry.ts` enthält die Guidance-Texte pro Kategorie. `cortex_load_tools(categories[])` gibt diese als Text zurück. `on-session-start.js` injiziert beim Start automatisch Guidance für `memory` und `tracking`.

**Tech Stack:** TypeScript (server), plain Node.js ESM (scripts), esbuild bundle

---

## Task 1: `tool-registry.ts` Modul erstellen

**Files:**
- Create: `server/src/modules/tool-registry.ts`

**Step 1: Datei erstellen**

```typescript
// server/src/modules/tool-registry.ts

export const TOOL_CATEGORIES: Record<string, string> = {
  memory: `## Memory & Context Tools

Use these at session start or when resuming work.

- **cortex_snapshot** → Full brain state: open items, recent sessions, decisions, learnings. Call this first in complex sessions.
- **cortex_get_context** → Relevant context for specific files. Pass file paths to get related decisions/errors/sessions.
- **cortex_list_sessions** → Recent work history with summaries.
- **cortex_search** → BM25/FTS5 full-text search across all stored data (sessions, decisions, errors, learnings).`,

  decisions: `## Decisions Tools

Use when making architectural or design choices.

- **cortex_add_decision** → Log WHY a decision was made. Required fields: title, reasoning, category (architecture/convention/bugfix/feature/config/security).
- **cortex_list_decisions** → Review existing decisions before making new ones. Check for duplicates.
- **cortex_mark_decision_reviewed** → Confirm a decision is still current (resets stale flag).`,

  errors: `## Errors & Learnings Tools

Use when bugs occur or anti-patterns are identified.

- **cortex_add_error** → Record a bug with root cause, fix description, and prevention rule.
- **cortex_update_error** → Add fix description or prevention rule to existing error.
- **cortex_list_errors** → List known errors, filter by severity or file.
- **cortex_add_learning** → Record an anti-pattern with correct alternative. Set detection_regex for auto-blocking.
- **cortex_update_learning** → Update existing learning (add regex, change severity, toggle auto_block).
- **cortex_delete_learning** → Remove a learning entry.
- **cortex_list_learnings** → Review known anti-patterns.
- **cortex_check_regression** → Check code against known anti-patterns BEFORE writing/editing. ALWAYS call this first.`,

  map: `## Project Map & Files Tools

Use when exploring or navigating the codebase.

- **cortex_scan_project** → Scan filesystem and populate architecture map. Run once to index project.
- **cortex_get_map** → Architecture overview: modules, layers, files.
- **cortex_update_map** → Re-scan and update map after structural changes.
- **cortex_get_deps** → Dependency tree and impact analysis for a specific file.
- **cortex_get_hot_zones** → Most frequently changed files — refactoring candidates.
- **cortex_get_file_history** → Full history for a file: sessions, diffs, errors.
- **cortex_blame** → Same as get_file_history with diff details.
- **cortex_import_git_history** → Import git log to populate hot zones.
- **cortex_index_docs** → Read CLAUDE.md and docs/ and store as searchable learnings.`,

  tracking: `## Tracking & TODOs Tools

Use when noting unfinished work or setting reminders.

- **cortex_add_unfinished** → Track something that needs to be done later. Fields: description, priority (low/medium/high), context.
- **cortex_get_unfinished** → List open/unresolved items.
- **cortex_resolve_unfinished** → Mark an unfinished item as done.
- **cortex_add_intent** → Store what you plan to do next session (shown at next SessionStart).
- **cortex_snooze** → Schedule a future session reminder. Use relative (3d/1w) or ISO date.`,

  notes: `## Notes & Profile Tools

- **cortex_add_note** → Save scratch pad note with optional tags.
- **cortex_list_notes** → List notes, filter by search term.
- **cortex_delete_note** → Delete note by id.
- **cortex_onboard** → First-time setup: name, role, working style, expertise, anchors.
- **cortex_update_profile** → Update user profile fields.
- **cortex_get_profile** → Get current user profile.
- **cortex_export** → Export brain data as JSON or Markdown.`,

  intelligence: `## Intelligence Tools

Advanced analysis and pattern detection.

- **cortex_dejavu** → Check if a task looks similar to past sessions (deja-vu detection). Pass task description.
- **cortex_check_blind_spots** → Find project files not touched in recent sessions.
- **cortex_get_mood** → Current system mood based on rolling average of last 7 sessions.
- **cortex_forget** → Archive decisions/errors/learnings matching a topic keyword.
- **cortex_cross_project_search** → Search across all projects in this Cortex DB.
- **cortex_add_anchor** → Add attention anchor — topic that always gets priority context.
- **cortex_remove_anchor** → Remove an attention anchor.
- **cortex_list_anchors** → List all attention anchors.`,

  stats: `## Health & Stats Tools

- **cortex_get_health** → Project health score with metrics and trend.
- **cortex_get_stats** → Overall counts: sessions, decisions, errors, files, learnings.
- **cortex_get_access_stats** → Top accessed decisions/learnings/errors.
- **cortex_run_pruning** → Manually run Ebbinghaus pruning — archives unused items.
- **cortex_get_timeline** → Monthly activity timeline.
- **cortex_compare_periods** → Compare activity between two date ranges.
- **cortex_suggest_claude_md** → Suggest CLAUDE.md updates based on new learnings.
- **cortex_set_project** → Set active project name for context tagging.
- **cortex_get_conventions** → List active coding conventions with violation counts.
- **cortex_add_convention** → Add or update a coding convention.`,
};

export const VALID_CATEGORIES = Object.keys(TOOL_CATEGORIES);

export function getToolGuidance(categories: string[]): string {
  const results: string[] = [];
  for (const cat of categories) {
    if (TOOL_CATEGORIES[cat]) {
      results.push(TOOL_CATEGORIES[cat]);
    } else {
      results.push(`Unknown category: "${cat}". Valid categories: ${VALID_CATEGORIES.join(', ')}`);
    }
  }
  return results.join('\n\n---\n\n');
}

export const PRELOAD_GUIDANCE = getToolGuidance(['memory', 'tracking']);
```

**Step 2: Prüfen dass die Datei korrekt angelegt ist**

```bash
ls server/src/modules/tool-registry.ts
```
Expected: Datei vorhanden

**Step 3: Commit**

```bash
git add server/src/modules/tool-registry.ts
git commit -m "feat: tool-registry Modul mit Kategorie-Guidance"
```

---

## Task 2: `CORTEX_INSTRUCTIONS` kürzen + `cortex_load_tools` registrieren

**Files:**
- Modify: `server/src/index.ts`

**Step 1: CORTEX_INSTRUCTIONS ersetzen (Zeilen 29-77)**

Die gesamte `const CORTEX_INSTRUCTIONS = ...` Variable ersetzen:

```typescript
import { getToolGuidance, VALID_CATEGORIES } from './modules/tool-registry.js';

const CORTEX_INSTRUCTIONS = `Cortex is a persistent memory and intelligence system for Claude Code.

TOOL CATEGORIES (call cortex_load_tools to get detailed guidance):
- memory: snapshot, get_context, list_sessions, search
- decisions: add_decision, list_decisions, mark_decision_reviewed
- errors: add_error, add_learning, check_regression, list_errors, list_learnings
- map: scan_project, get_map, get_deps, get_hot_zones, file_history, blame
- tracking: add_unfinished, get_unfinished, resolve_unfinished, add_intent, snooze
- notes: add_note, list_notes, onboard, update_profile, get_profile
- intelligence: dejavu, check_blind_spots, get_mood, forget, cross_project_search
- stats: get_health, get_stats, get_access_stats, run_pruning, get_timeline

RULES: Always call cortex_check_regression before writing/editing files.
Use cortex_load_tools(['category']) to get detailed usage guidance for any category.`;
```

**Step 2: `cortex_load_tools` Tool registrieren** — direkt nach der letzten Tool-Registrierung, vor `server.connect(...)`:

```typescript
server.tool(
  'cortex_load_tools',
  'Get detailed usage guidance for one or more Cortex tool categories. Call this before using tools in an unfamiliar category.',
  {
    categories: z.array(
      z.enum(VALID_CATEGORIES as [string, ...string[]])
        .describe(`Category name. Valid values: ${VALID_CATEGORIES.join(', ')}`)
    ).describe('List of categories to load guidance for. Example: ["memory", "decisions"]'),
  },
  async ({ categories }) => {
    const guidance = getToolGuidance(categories);
    return { content: [{ type: 'text' as const, text: guidance }] };
  }
);
```

**Step 3: Import oben in index.ts hinzufügen** (nach den bestehenden Modul-Imports, Zeile ~16):

```typescript
import { getToolGuidance, VALID_CATEGORIES } from './modules/tool-registry.js';
```

**Step 4: Build ausführen**

```bash
cd server && npm run build
```

Expected: `dist/bundle.js` wird ohne Fehler erzeugt

**Step 5: Commit**

```bash
git add server/src/index.ts server/dist/bundle.js
git commit -m "feat: CORTEX_INSTRUCTIONS gekuerzt + cortex_load_tools Meta-Tool"
```

---

## Task 3: SessionStart Hook — Auto-Preload memory + tracking

**Files:**
- Modify: `scripts/on-session-start.js`

**Step 1: Datei lesen und Einfügeposition finden**

Die Datei injiziert am Ende `additionalContext` via:
```javascript
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
```

**Step 2: PRELOAD_GUIDANCE importieren und an context anhängen**

Da `on-session-start.js` kein npm nutzt und `tool-registry.ts` TypeScript ist, wird der Guidance-Text direkt als Konstante in das Hook-Script kopiert (kein Import von server/).

Direkt nach den bestehenden Imports am Anfang der Datei einfügen:

```javascript
// Preloaded Tool Guidance (memory + tracking) — aus tool-registry.ts generiert
const PRELOADED_TOOL_GUIDANCE = `## Memory & Context Tools

Use these at session start or when resuming work.

- **cortex_snapshot** → Full brain state: open items, recent sessions, decisions, learnings. Call this first in complex sessions.
- **cortex_get_context** → Relevant context for specific files. Pass file paths to get related decisions/errors/sessions.
- **cortex_list_sessions** → Recent work history with summaries.
- **cortex_search** → BM25/FTS5 full-text search across all stored data (sessions, decisions, errors, learnings).

---

## Tracking & TODOs Tools

Use when noting unfinished work or setting reminders.

- **cortex_add_unfinished** → Track something that needs to be done later. Fields: description, priority (low/medium/high), context.
- **cortex_get_unfinished** → List open/unresolved items.
- **cortex_resolve_unfinished** → Mark an unfinished item as done.
- **cortex_add_intent** → Store what you plan to do next session (shown at next SessionStart).
- **cortex_snooze** → Schedule a future session reminder. Use relative (3d/1w) or ISO date.`;
```

**Step 3: context-String erweitern**

Die bestehende `context`-Zusammenstellung am Ende der Datei:

```javascript
const context = [
  `-- Project Cortex...`,
  ...parts,
  '/cortex-search, /cortex-map, /cortex-deps for details',
  '---',
].join('\n');
```

Ändern zu:

```javascript
const context = [
  `-- Project Cortex...`,
  ...parts,
  '/cortex-search, /cortex-map, /cortex-deps for details',
  '---',
  '',
  '## Preloaded Tool Guidance',
  PRELOADED_TOOL_GUIDANCE,
].join('\n');
```

**Step 4: Testen — neuen Session-Start simulieren**

```bash
echo '{"session_id":"test-123","cwd":"C:/Users/toasted/Desktop/data/cortex"}' | node scripts/on-session-start.js
```

Expected: JSON-Output enthält `additionalContext` mit dem Guidance-Text am Ende

**Step 5: Commit**

```bash
git add scripts/on-session-start.js
git commit -m "feat: SessionStart preloaded memory+tracking Guidance"
```

---

## Task 4: CORTEX_INSTRUCTIONS in CLAUDE.md aktualisieren

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Tool-Kategorien-Tabelle in CLAUDE.md aktualisieren**

Im Abschnitt `## Cortex-Tool-Nutzungsregeln` die "Wichtige Tool-Gruppen" Sektion anpassen:

```markdown
### Wichtige Tool-Gruppen
cortex_load_tools(['memory'])      → snapshot, get_context, list_sessions, search
cortex_load_tools(['decisions'])   → add/list/mark_reviewed
cortex_load_tools(['errors'])      → add_error, add_learning, check_regression
cortex_load_tools(['map'])         → scan, get_map, get_deps, hot_zones
cortex_load_tools(['tracking'])    → add/get/resolve_unfinished, add_intent, snooze
cortex_load_tools(['intelligence'])→ dejavu, blind_spots, mood, forget
cortex_load_tools(['stats'])       → get_health, get_stats, access_stats
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md Tool-Gruppen auf cortex_load_tools umgestellt"
```

---

## Task 5: Unfinished-Item als erledigt markieren

**Step 1: MCP Tool Search als resolved markieren**

```
cortex_get_unfinished aufrufen → ID des "MCP Tool Search evaluieren" Items finden
cortex_resolve_unfinished(id) aufrufen
```

**Step 2: Decision loggen**

```
cortex_add_decision(
  title: "MCP Tool Search: CORTEX_INSTRUCTIONS kürzen statt Tool-Descriptions",
  reasoning: "Alle 55 Tools bleiben mit vollen Descriptions registriert — kein Breaking Change. Nur CORTEX_INSTRUCTIONS wird gekürzt (~50→10 Zeilen). cortex_load_tools liefert Guidance on-demand. Spart ~1.5-2KB Token pro Tool-Call ohne Risiko.",
  category: "architecture",
  files_affected: ["server/src/index.ts", "server/src/modules/tool-registry.ts", "scripts/on-session-start.js"]
)
```

**Step 3: Push**

```bash
git push
```

---

## Zusammenfassung der Änderungen

| Datei | Änderung |
|---|---|
| `server/src/modules/tool-registry.ts` | Neu — Kategorie-Guidance als Konstanten + `getToolGuidance()` |
| `server/src/index.ts` | CORTEX_INSTRUCTIONS ~50→10 Zeilen, `cortex_load_tools` registriert |
| `server/dist/bundle.js` | Neu gebaut |
| `scripts/on-session-start.js` | PRELOADED_TOOL_GUIDANCE am Ende von additionalContext |
| `CLAUDE.md` | Tool-Gruppen-Tabelle aktualisiert |
