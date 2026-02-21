#!/usr/bin/env node
// PreToolUse Hook — Pattern Enforcer + Regression Guard

import { readFileSync, existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { tool_name, tool_input, cwd } = input;

  if (!['Write', 'Edit'].includes(tool_name)) process.exit(0);

  const content = tool_input.content || tool_input.new_string || '';
  if (!content) process.exit(0);

  const dbPath = join(cwd, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) process.exit(0);

  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const warnings = [];
    let shouldBlock = false;

    // 1. Learnings with auto_block
    const learnings = db.prepare(`
      SELECT id, anti_pattern, correct_pattern, detection_regex, severity
      FROM learnings WHERE (auto_block = 1 OR core_memory = 1) AND archived != 1 AND detection_regex IS NOT NULL
    `).all();

    for (const l of learnings) {
      try {
        if (new RegExp(l.detection_regex, 'gm').test(content)) {
          warnings.push({ type: 'anti-pattern', severity: l.severity,
            message: `Anti-pattern: "${l.anti_pattern}" -> Use: "${l.correct_pattern}"` });
          if (l.severity === 'high') shouldBlock = true;
        }
      } catch { /* invalid regex */ }
    }

    // 2. Error prevention rules
    const rules = db.prepare(`
      SELECT id, prevention_rule, error_message, fix_description FROM errors WHERE prevention_rule IS NOT NULL
    `).all();

    for (const r of rules) {
      try {
        if (new RegExp(r.prevention_rule, 'm').test(content)) {
          const fix = r.fix_description ? ` Fix: ${r.fix_description}` : '';
          warnings.push({ type: 'regression', severity: 'error',
            message: `Pattern caused Error #${r.id}: "${r.error_message}"${fix}` });
          shouldBlock = true;
        }
      } catch { /* invalid regex */ }
    }

    // 3. Convention violations (warn only)
    const conventions = db.prepare(`
      SELECT id, name, description, violation_pattern FROM conventions WHERE violation_pattern IS NOT NULL
    `).all();

    for (const c of conventions) {
      try {
        if (new RegExp(c.violation_pattern, 'm').test(content)) {
          warnings.push({ type: 'convention-violation', severity: 'warning',
            message: `Convention "${c.name}": ${c.description}` });
        }
      } catch { /* invalid regex */ }
    }

    // 4. SQL-Migration spezifische Checks
    const isSqlFile = (tool_input.file_path || '').toLowerCase().endsWith('.sql');
    if (isSqlFile) {
      // Fehlende NOTIFY pgrst nach Schema-Änderungen (Gotcha #102)
      const hasSchemaChange = /CREATE TABLE|ALTER TABLE|CREATE VIEW|DROP TABLE/i.test(content);
      const hasNotify = /NOTIFY pgrst/i.test(content);
      if (hasSchemaChange && !hasNotify) {
        warnings.push({ type: 'sql-migration', severity: 'warning',
          message: 'Schema change without NOTIFY pgrst — PostgREST wont reload schema. Gotcha #102' });
      }
      // Bare auth.uid() statt (select auth.uid()) (Gotcha #126)
      // Lookbehind: auth.uid() das NICHT von "(select " vorangestellt wird
      if (/auth\.uid\(\)/.test(content) && !/\(select auth\.uid\(\)\)/.test(content)) {
        warnings.push({ type: 'sql-migration', severity: 'warning',
          message: 'Bare auth.uid() in RLS — use (select auth.uid()) for performance. Gotcha #126' });
      }
      // FK auf auth.users statt profiles (Gotcha #127)
      if (/REFERENCES\s+auth\.users/i.test(content)) {
        warnings.push({ type: 'sql-migration', severity: 'warning',
          message: 'FK references auth.users — should reference profiles(id). Gotcha #127' });
      }
    }

    if (warnings.length === 0) process.exit(0);

    if (shouldBlock) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: warnings.filter(w => w.severity === 'error' || w.severity === 'high')
            .map(w => `[CORTEX] ${w.message}`).join('\n'),
          additionalContext: `Cortex: ${warnings.length} issue(s):\n${warnings.map(w => `- ${w.message}`).join('\n')}`,
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({
        systemMessage: `Cortex warnings:\n${warnings.map(w => `[${w.type}] ${w.message}`).join('\n')}`,
      }));
    }
  } finally {
    db.close();
  }
}

try { main(); } catch (err) {
  process.stderr.write(`Cortex PreToolUse error: ${err.message}\n`);
  process.exit(0);
}
