#!/usr/bin/env node
// PreToolUse Hook — Pattern Enforcer + Regression Guard

import { readFileSync, existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

// Hookify-kompatible cortex-pins.local.md laden
function loadPinRules(claudeDir) {
  const pinsFile = join(claudeDir, 'cortex-pins.local.md');
  if (!existsSync(pinsFile)) return [];
  try {
    const content = readFileSync(pinsFile, 'utf-8');
    const rules = [];
    // blocks[0] ist immer vor dem ersten '---' (leer oder Preamble) — überspringen
    const blocks = content.split(/^---$/m).slice(1);
    for (let i = 0; i < blocks.length - 1; i += 2) {
      const yaml = blocks[i].trim();
      const message = blocks[i + 1]?.trim() ?? '';
      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      const patternMatch = yaml.match(/^pattern:\s*(.+)$/m);
      const enabledMatch = yaml.match(/^enabled:\s*(.+)$/m);
      if (!patternMatch) continue;
      const enabled = enabledMatch ? enabledMatch[1].trim() !== 'false' : true;
      if (!enabled) continue;
      rules.push({ name: nameMatch?.[1]?.trim() ?? 'unnamed', pattern: patternMatch[1].trim(), message });
    }
    return rules;
  } catch { return []; }
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { tool_name, tool_input, cwd } = input;

  if (!['Write', 'Edit'].includes(tool_name)) process.exit(0);

  const content = tool_input.content || tool_input.new_string || '';
  if (!content) process.exit(0);

  const claudeDir = join(cwd, '.claude');

  // Pin-Rules aus cortex-pins.local.md (hookify-Format) — blockieren sofort
  const pinRules = loadPinRules(claudeDir);
  for (const rule of pinRules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(content)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `[CORTEX PIN] ${rule.name}\n${rule.message}`,
          },
        }));
        process.exit(0);
      }
    } catch { /* ungültige Regex ignorieren */ }
  }

  const dbPath = join(claudeDir, 'cortex.db');
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

    const filePath = tool_input.file_path || '';
    const isDocFile = /\.(md|txt|rst|adoc)$/i.test(filePath);

    for (const l of learnings) {
      if (isDocFile) continue; // Docs/Plans enthalten Code-Snippets — keine false positives
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

    // 5. Passive file warnings (non-blocking context)
    const targetFile = tool_input.file_path || '';
    if (targetFile) {
      const passiveCtx = [];
      try {
        const hf = db.prepare(`SELECT change_count FROM project_files WHERE path LIKE ?`).get(`%${targetFile}%`);
        if (hf && hf.change_count > 10) passiveCtx.push(`HOT ZONE: "${targetFile}" changed ${hf.change_count}x — high churn file`);
      } catch {}
      try {
        const recentErr = db.prepare(`SELECT error_message FROM errors WHERE files_involved LIKE ? AND last_seen > datetime('now','-7 days') LIMIT 1`).get(`%${targetFile}%`);
        if (recentErr) passiveCtx.push(`RECENT ERROR in this file (last 7d): ${recentErr.error_message}`);
      } catch {}
      try {
        const dec = db.prepare(`SELECT title FROM decisions WHERE files_affected LIKE ? ORDER BY created_at DESC LIMIT 1`).get(`%${targetFile}%`);
        if (dec) passiveCtx.push(`DECISION for this file: ${dec.title}`);
      } catch {}
      if (passiveCtx.length > 0) {
        const existing = warnings.map(w => w.message).join(' ');
        for (const p of passiveCtx) {
          if (!existing.includes(p)) warnings.push({ type: 'passive', severity: 'info', message: p });
        }
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
