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
  process.stdout.write('[cortex-daemon] SkillAdvisor: starting\n');
}
