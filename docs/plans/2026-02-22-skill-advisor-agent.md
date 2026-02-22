# skillAdvisor Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Einen neuen Daemon-Agent `skillAdvisor.ts` implementieren, der nach jeder Session Transcript + Diffs analysiert und Skills in `skills/` autonom verbessert oder neu erstellt.

**Architecture:** Agent läuft bei `session_end` wie Learner/DriftDetector. Liest Transcript + geänderte Dateien + alle vorhandenen SKILL.md-Dateien. Gibt JSON mit gezielten String-Replacements aus. Schreibt SKILL.md-Dateien direkt (kein Auto-Commit). Neue Skills werden als neue Verzeichnisse in `skills/` angelegt.

**Tech Stack:** TypeScript, node:sqlite, node:fs, runClaudeAgent() aus runner.ts, buildAgentContext() aus runner.ts

---

### Task 1: skillAdvisor.ts Grundgerüst + JSON-Schema

**Files:**
- Create: `daemon/src/agents/skillAdvisor.ts`

**Step 1: Datei anlegen**

```typescript
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { runClaudeAgent, buildAgentContext, formatAgentContext } from '../runner.js';

const SKILL_ADVISOR_SCHEMA = {
  type: 'object',
  properties: {
    skill_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          skill_path: { type: 'string', description: 'Relativer Pfad zur SKILL.md, z.B. skills/resume/SKILL.md' },
          find: { type: 'string', description: 'Exakter Text-Abschnitt der ersetzt werden soll' },
          replace: { type: 'string', description: 'Neuer Text der den find-Abschnitt ersetzt' },
          reason: { type: 'string', description: 'Warum diese Änderung sinnvoll ist' },
        },
        required: ['skill_path', 'find', 'replace', 'reason'],
      },
    },
    new_skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          skill_path: { type: 'string', description: 'Relativer Pfad zur neuen SKILL.md, z.B. skills/mein-skill/SKILL.md' },
          content: { type: 'string', description: 'Vollständiger Inhalt der neuen SKILL.md mit YAML-Frontmatter' },
          reason: { type: 'string', description: 'Warum dieser neue Skill sinnvoll ist' },
        },
        required: ['skill_path', 'content', 'reason'],
      },
    },
  },
  required: ['skill_updates', 'new_skills'],
};
```

**Step 2: Funktion zum Laden aller Skills**

Füge nach dem Schema hinzu:

```typescript
function loadAllSkills(projectPath: string): Array<{ path: string; content: string }> {
  const skillsDir = join(projectPath, 'skills');
  if (!existsSync(skillsDir)) return [];
  const result: Array<{ path: string; content: string }> = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const content = readFileSync(skillFile, 'utf-8');
      result.push({ path: `skills/${entry.name}/SKILL.md`, content });
    }
  } catch { /* ignore */ }
  return result;
}
```

**Step 3: Export-Funktion Stub**

```typescript
export async function runSkillAdvisorAgent(projectPath: string, transcriptPath?: string): Promise<void> {
  process.stdout.write('[cortex-daemon] SkillAdvisor: starting\n');
}
```

**Step 4: Bauen**

```bash
cd /c/Users/toasted/Desktop/data/cortex/daemon && npm run build 2>&1
```

Expected: Kein TypeScript-Fehler.

**Step 5: Commit**

```bash
cd /c/Users/toasted/Desktop/data/cortex
git add daemon/src/agents/skillAdvisor.ts daemon/dist/index.js
git commit -m "feat: skillAdvisor.ts Grundgeruest + JSON-Schema + loadAllSkills"
```

---

### Task 2: Prompt-Aufbau + Agent-Call

**Files:**
- Modify: `daemon/src/agents/skillAdvisor.ts`

**Step 1: Transcript + Context laden (in runSkillAdvisorAgent)**

Ersetze den Stub durch:

```typescript
export async function runSkillAdvisorAgent(projectPath: string, transcriptPath?: string): Promise<void> {
  // Transcript (letzte 6000 Zeichen)
  let transcriptSample = '';
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      transcriptSample = readFileSync(transcriptPath, 'utf-8').slice(-6000);
    } catch { /* nicht lesbar */ }
  }

  // Alle vorhandenen Skills laden
  const skills = loadAllSkills(projectPath);
  if (skills.length === 0 && !transcriptSample) {
    process.stdout.write('[cortex-daemon] SkillAdvisor: no skills or transcript, skipping\n');
    return;
  }

  // Context-Block (Diffs, Hot Zones, Delta)
  const agentCtx = buildAgentContext(projectPath, 'skill-advisor');
  const contextBlock = formatAgentContext(agentCtx);

  // Geänderte Dateien aus letzter Session
  let recentFiles: string[] = [];
  try {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      recentFiles = (db.prepare(`
        SELECT path FROM project_files
        WHERE last_changed > datetime('now', '-2 hours')
        ORDER BY last_changed DESC LIMIT 15
      `).all() as Array<{ path: string }>).map(r => r.path);
      db.close();
    }
  } catch { /* ignore */ }
```

**Step 2: Skills-Übersicht für Prompt aufbereiten**

```typescript
  const skillsOverview = skills.map(s =>
    `### ${s.path}\n${s.content.slice(0, 400)}${s.content.length > 400 ? '\n...(gekürzt)' : ''}`
  ).join('\n\n');
```

**Step 3: Prompt zusammenbauen**

```typescript
  const prompt = `<role>
Du bist ein Skill-Optimierer für Claude Code. Analysiere die letzte Coding-Session und verbessere gezielt bestehende Skills oder erstelle neue.
</role>
${contextBlock}
<session_data>
<changed_files>
${recentFiles.join('\n') || '(keine)'}
</changed_files>
${transcriptSample ? `<transcript>\n${transcriptSample}\n</transcript>` : ''}
</session_data>

<existing_skills>
${skillsOverview || '(keine Skills vorhanden)'}
</existing_skills>

<instructions>
Analysiere ob in dieser Session:
1. Ein Skill unvollständig war (fehlende Regel, falscher Ablauf, veraltete Information)
2. Ein wiederkehrendes Muster existiert das einen neuen Skill rechtfertigt

Für skill_updates: Gib EXAKT den zu ersetzenden Text (find) und den neuen Text (replace) an.
Der find-Text muss wörtlich in der SKILL.md vorhanden sein.
Nur wirklich sinnvolle Verbesserungen — lieber leere Arrays als schlechte Vorschläge.
Neue Skills nur wenn dasselbe Muster mind. 2x in dieser Session vorkam.

Antworte NUR mit dem JSON-Schema. Leere Arrays sind OK.
</instructions>`;
```

**Step 4: Agent aufrufen**

```typescript
  const result = await runClaudeAgent({
    prompt,
    projectPath,
    timeoutMs: 90_000,
    jsonSchema: SKILL_ADVISOR_SCHEMA,
    model: 'claude-haiku-4-5-20251001',
    agentName: 'skill-advisor',
  });

  if (!result.success || !result.output) {
    process.stderr.write(`[cortex-daemon] SkillAdvisor: agent failed: ${result.error ?? 'no output'}\n`);
    return;
  }
```

**Step 5: Bauen**

```bash
cd /c/Users/toasted/Desktop/data/cortex/daemon && npm run build 2>&1
```

**Step 6: Commit**

```bash
cd /c/Users/toasted/Desktop/data/cortex
git add daemon/src/agents/skillAdvisor.ts daemon/dist/index.js
git commit -m "feat: skillAdvisor Prompt-Aufbau + Agent-Call (haiku)"
```

---

### Task 3: Output verarbeiten — Skills schreiben

**Files:**
- Modify: `daemon/src/agents/skillAdvisor.ts`

**Step 1: JSON parsen**

Füge nach dem Agent-Call hinzu:

```typescript
  let output: {
    skill_updates?: Array<{ skill_path: string; find: string; replace: string; reason: string }>;
    new_skills?: Array<{ skill_path: string; content: string; reason: string }>;
  };

  try {
    const parsed = JSON.parse(result.output);
    output = parsed?.structured_output ?? parsed;
    if (!output || typeof output !== 'object') throw new Error('invalid');
  } catch {
    try {
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      output = JSON.parse(jsonMatch[0]);
    } catch { return; }
  }

  let changed = 0;
```

**Step 2: Bestehende Skills updaten**

```typescript
  if (output.skill_updates) {
    for (const update of output.skill_updates) {
      if (!update.skill_path || !update.find || !update.replace) continue;
      const fullPath = join(projectPath, update.skill_path);
      if (!existsSync(fullPath)) {
        process.stderr.write(`[cortex-daemon] SkillAdvisor: skill not found: ${update.skill_path}\n`);
        continue;
      }
      // Sicherheitscheck: nur skills/ Verzeichnis erlaubt
      if (!update.skill_path.startsWith('skills/')) {
        process.stderr.write(`[cortex-daemon] SkillAdvisor: rejected path outside skills/: ${update.skill_path}\n`);
        continue;
      }
      try {
        const current = readFileSync(fullPath, 'utf-8');
        if (!current.includes(update.find)) {
          process.stderr.write(`[cortex-daemon] SkillAdvisor: find-text not found in ${update.skill_path}, skipping\n`);
          continue;
        }
        const updated = current.replace(update.find, update.replace);
        writeFileSync(fullPath, updated, 'utf-8');
        process.stdout.write(`[cortex-daemon] SkillAdvisor: updated ${update.skill_path} — ${update.reason.slice(0, 60)}\n`);
        changed++;
      } catch (err: any) {
        process.stderr.write(`[cortex-daemon] SkillAdvisor: write error ${update.skill_path}: ${err.message}\n`);
      }
    }
  }
```

**Step 3: Neue Skills erstellen**

```typescript
  if (output.new_skills) {
    for (const newSkill of output.new_skills) {
      if (!newSkill.skill_path || !newSkill.content) continue;
      if (!newSkill.skill_path.startsWith('skills/')) {
        process.stderr.write(`[cortex-daemon] SkillAdvisor: rejected new skill path outside skills/: ${newSkill.skill_path}\n`);
        continue;
      }
      const fullPath = join(projectPath, newSkill.skill_path);
      if (existsSync(fullPath)) {
        process.stderr.write(`[cortex-daemon] SkillAdvisor: new skill already exists, skipping: ${newSkill.skill_path}\n`);
        continue;
      }
      try {
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, newSkill.content, 'utf-8');
        process.stdout.write(`[cortex-daemon] SkillAdvisor: created ${newSkill.skill_path} — ${newSkill.reason.slice(0, 60)}\n`);
        changed++;
      } catch (err: any) {
        process.stderr.write(`[cortex-daemon] SkillAdvisor: create error ${newSkill.skill_path}: ${err.message}\n`);
      }
    }
  }

  process.stdout.write(`[cortex-daemon] SkillAdvisor: done — ${changed} skill(s) modified\n`);
}
```

**Step 4: Bauen**

```bash
cd /c/Users/toasted/Desktop/data/cortex/daemon && npm run build 2>&1
```

Expected: Kein Fehler.

**Step 5: Commit**

```bash
cd /c/Users/toasted/Desktop/data/cortex
git add daemon/src/agents/skillAdvisor.ts daemon/dist/index.js
git commit -m "feat: skillAdvisor schreibt skill_updates + new_skills nach skills/"
```

---

### Task 4: In daemon/src/index.ts registrieren

**Files:**
- Modify: `daemon/src/index.ts`

**Step 1: Import hinzufügen**

Füge nach den bestehenden Imports (Zeilen 6-10) hinzu:

```typescript
import { runSkillAdvisorAgent } from './agents/skillAdvisor.js';
```

**Step 2: Bei session_end registrieren**

Im `session_end`-Handler (nach dem letzten bestehenden Agent-Call), direkt nach `runMoodScorerAgent`:

```typescript
      runSkillAdvisorAgent(projectPath, event.transcript_path).catch(err => {
        process.stderr.write(`[cortex-daemon] SkillAdvisor error: ${err}\n`);
      });
```

**Step 3: Bauen**

```bash
cd /c/Users/toasted/Desktop/data/cortex/daemon && npm run build 2>&1
```

**Step 4: Commit**

```bash
cd /c/Users/toasted/Desktop/data/cortex
git add daemon/src/index.ts daemon/dist/index.js
git commit -m "feat: skillAdvisor in session_end Event-Handler registriert"
```

---

### Task 5: Decisions loggen + Abschluss

**Step 1: cortex_add_decision aufrufen**

```
cortex_add_decision:
- title: "skillAdvisor Agent: autonome Skill-Verbesserung nach jeder Session"
- category: architecture
- reasoning: "Inspiriert von one-skill-to-rule-them-all. Haiku analysiert Transcript + Diffs, gibt JSON mit find/replace Änderungen aus. Nur skills/ Verzeichnis erlaubt (Sicherheitscheck). Kein Auto-Commit — User sieht Änderungen via git diff. loadAllSkills() liefert alle SKILL.md als Kontext."
- files_affected: ["daemon/src/agents/skillAdvisor.ts", "daemon/src/index.ts"]
```

**Step 2: Finale Commit-Historie prüfen**

```bash
cd /c/Users/toasted/Desktop/data/cortex && git log --oneline -6
```

**Step 3: git status prüfen**

```bash
git status
```

Expected: clean working tree.
