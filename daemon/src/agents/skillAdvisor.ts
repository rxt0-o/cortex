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

  // Skills-Übersicht für Prompt (auf 400 Zeichen pro Skill kürzen)
  const skillsOverview = skills.map(s =>
    `### ${s.path}\n${s.content.slice(0, 400)}${s.content.length > 400 ? '\n...(gekürzt)' : ''}`
  ).join('\n\n');

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
}
