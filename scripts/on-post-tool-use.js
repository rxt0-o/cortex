#!/usr/bin/env node
// PostToolUse Hook (async) — Track file changes + queue events for daemon

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

// Loop Detector — tracks edits per file across hook invocations
const _editTracker = new Map(); // key: filePath, value: { count, firstAt }

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { tool_name, tool_input, session_id, cwd } = input;

  const filePath = tool_input?.file_path;

  // Read-Event: file_access in Queue schreiben + ggf. Feedback lesen
  if (tool_name === 'Read' && filePath) {
    const queuePath = join(cwd, '.claude', 'cortex-events.jsonl');
    const event = { type: 'file_access', file: filePath, tool: 'Read', session_id, ts: new Date().toISOString() };
    try { appendFileSync(queuePath, JSON.stringify(event) + '\n', 'utf-8'); } catch { /* nicht kritisch */ }

    // Feedback aus cortex-feedback.jsonl fuer diese Datei lesen (neueste Zeile)
    const feedbackPath = join(cwd, '.claude', 'cortex-feedback.jsonl');
    if (existsSync(feedbackPath)) {
      try {
        const lines = readFileSync(feedbackPath, 'utf-8').split('\n').filter(l => l.trim());
        // Suche neuesten Feedback-Eintrag fuer diese Datei
        for (let i = lines.length - 1; i >= 0; i--) {
          const fb = JSON.parse(lines[i]);
          if (fb.file === filePath && fb.message) {
            // Feedback an Claude ausgeben
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: `[Cortex] ${fb.message}`,
              },
            }));
            break;
          }
        }
      } catch { /* nicht kritisch */ }
    }
    process.exit(0);
  }

  if (!['Write', 'Edit', 'Bash'].includes(tool_name)) process.exit(0);

  // Bash: fruehzeitig pruefen ob migration-relevant, sonst exit
  if (tool_name === 'Bash') {
    const cmd = tool_input?.command || '';
    const hasMigration = cmd.includes('migrations/');
    const hasGit = /git\s+(?:add|commit)/.test(cmd);
    if (!hasMigration || !hasGit) process.exit(0);
  }

  if (!filePath && tool_name !== 'Bash') process.exit(0);

  const dbPath = join(cwd, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) process.exit(0);

  const db = new DatabaseSync(dbPath);

  try {
    const ts = new Date().toISOString();

    if (tool_name !== 'Bash') {
      // 1. Track file change (Hot Zones)
      db.prepare(`
        INSERT INTO project_files (path, change_count, last_changed, last_changed_session)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          change_count = project_files.change_count + 1, last_changed = ?, last_changed_session = ?
      `).run(filePath, ts, session_id, ts, session_id);

      // 2. Infer file type
      const ft = inferFileType(filePath);
      if (ft) db.prepare('UPDATE project_files SET file_type = COALESCE(file_type, ?) WHERE path = ?').run(ft, filePath);

      // 3. Ensure session exists for FK constraint
      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, ts, 'active');

      // 4. Save diff
      if (tool_name === 'Edit' && tool_input.old_string && tool_input.new_string) {
        db.prepare(`INSERT INTO diffs (session_id, file_path, diff_content, change_type, lines_added, lines_removed, created_at)
          VALUES (?, ?, ?, 'modified', ?, ?, ?)`).run(
          session_id, filePath, `--- a\n+++ b\n-${tool_input.old_string}\n+${tool_input.new_string}`,
          tool_input.new_string.split('\n').length, tool_input.old_string.split('\n').length, ts);
      } else if (tool_name === 'Write') {
        const lines = (tool_input.content || '').split('\n').length;
        db.prepare(`INSERT INTO diffs (session_id, file_path, diff_content, change_type, lines_added, lines_removed, created_at)
          VALUES (?, ?, ?, 'modified', ?, 0, ?)`).run(session_id, filePath, `[Write: ${lines} lines]`, lines, ts);
      }

      // 5. Scan imports + exports (only on Write — full content available)
      const content = tool_input.content || '';
      if (content) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        if (['ts', 'tsx', 'js', 'jsx', 'py'].includes(ext || '')) {
          db.prepare('DELETE FROM dependencies WHERE source_file = ?').run(filePath);
          const stmt = db.prepare('INSERT OR IGNORE INTO dependencies (source_file, target_file, import_type) VALUES (?, ?, ?)');
          for (const imp of scanImports(content, ext)) stmt.run(filePath, imp, 'static');

          // Extract and cache top-level exports/symbols
          const symbols = extractExports(content, ext);
          if (symbols.length > 0) {
            db.prepare('UPDATE project_files SET exports = ? WHERE path = ?').run(JSON.stringify(symbols), filePath);
          }
        }
      }
    }

      // 6b. Loop detector: warn if same file/function edited 3+ times in 5 minutes
      // Inline function detection for granular tracking
      let changedFunction = '';
      try {
        const changedContent = (tool_input?.new_string ?? tool_input?.content ?? '');
        const pats = [/(?:async\s+)?function\s+(\w+)/, /const\s+(\w+)\s*=/, /class\s+(\w+)/];
        for (const p of pats) { const m = changedContent.match(p); if (m?.[1]) { changedFunction = m[1]; break; } }
      } catch {}
      const trackKey = changedFunction ? (filePath + ':' + changedFunction) : filePath;
      const trackLabel = changedFunction ? (filePath + ' -> ' + changedFunction + '()') : filePath;

      const now = Date.now();
      const tracked = _editTracker.get(trackKey) || { count: 0, firstAt: now };
      tracked.count++;
      _editTracker.set(trackKey, tracked);
      if (tracked.count >= 3 && (now - tracked.firstAt) < 5 * 60 * 1000) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `LOOP DETECTED: ${trackLabel} edited ${tracked.count}x in 5 minutes — consider stepping back`,
          },
        }));
      }

    // 7. Impact tracking: check if this file had a recent fix
    if (filePath && tool_name !== 'Bash') {
      try {
        const recentFix = db.prepare(`SELECT e.fix_description, s.started_at FROM errors e LEFT JOIN sessions s ON s.id=e.session_id WHERE e.files_involved LIKE ? AND e.fix_description IS NOT NULL AND s.started_at > datetime('now','-7 days') ORDER BY s.started_at DESC LIMIT 1`).get(`%${filePath}%`);
        if (recentFix) {
          const daysAgo = Math.round((Date.now() - new Date(recentFix.started_at).getTime()) / 86400000);
          const feedbackPath = join(cwd, '.claude', 'cortex-feedback.jsonl');
          appendFileSync(feedbackPath, JSON.stringify({ file: filePath, message: `IMPACT: Fixed ${daysAgo}d ago: Is the fix holding?` }) + '\n', 'utf-8');
        }
      } catch {}
    }

    // 6. Migration-Tracking (Gotcha #133)
    if (tool_name === 'Bash') {
      const cmd = tool_input?.command || '';
      const migrationMatches = cmd.match(/migrations\/[\w_]+\.sql/g);
      if (migrationMatches && /git\s+(?:add|commit)/.test(cmd)) {
        // Ensure session exists for FK constraint
        db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, ts, 'active');
        for (const mig of migrationMatches) {
          const migName = mig.split('/').pop();
          const description = `Deploy migration in Supabase SQL Editor: ${migName}`;
          // Duplikate vermeiden
          const existing = db.prepare(
            "SELECT id FROM unfinished WHERE description = ? AND resolved_at IS NULL"
          ).get(description);
          if (!existing) {
            db.prepare(`
              INSERT INTO unfinished (session_id, created_at, description, context, priority)
              VALUES (?, ?, ?, ?, 'high')
            `).run(
              session_id,
              new Date().toISOString(),
              description,
              'Automatisch erkannt via Cortex Migration-Tracker (Gotcha #133)'
            );
          }
        }
      }
    }
  } finally {
    db.close();
  }
}

function inferFileType(fp) {
  const p = fp.replace(/\\/g, '/').toLowerCase();
  if (p.includes('/components/')) return 'component';
  if (p.includes('/services/') || p.endsWith('service.ts')) return 'service';
  if (p.includes('/hooks/')) return 'hook';
  if (p.includes('/routes/') || p.includes('/api/')) return 'route';
  if (p.includes('/migrations/') || p.endsWith('.sql')) return 'migration';
  if (p.includes('.test.') || p.includes('.spec.')) return 'test';
  if (p.includes('/pages/')) return 'page';
  if (p.includes('/config/')) return 'config';
  return null;
}

function extractExports(content, ext) {
  const symbols = [];
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    const patterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+(?:default\s+)?class\s+(\w+)/g,
      /export\s+const\s+(\w+)/g,
      /export\s+(?:type|interface|enum)\s+(\w+)/g,
    ];
    for (const re of patterns) {
      let m; while ((m = re.exec(content))) symbols.push(m[1]);
    }
  } else if (ext === 'py') {
    const patterns = [
      /^(?:async\s+)?def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
    ];
    for (const re of patterns) {
      let m; while ((m = re.exec(content))) {
        if (!m[1].startsWith('_')) symbols.push(m[1]);
      }
    }
  }
  return [...new Set(symbols)];
}

function scanImports(content, ext) {
  const imports = [];
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    const re = /import\s+(?:type\s+)?(?:\{[^}]*\}|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/g;
    let m; while ((m = re.exec(content))) { if (m[1].startsWith('.') || m[1].startsWith('/')) imports.push(m[1]); }
  } else if (ext === 'py') {
    const re = /from\s+([\w.]+)\s+import/g;
    let m; while ((m = re.exec(content))) { if (m[1].startsWith('app') || m[1].includes('.')) imports.push(m[1]); }
  }
  return imports;
}

try { main(); } catch (err) {
  process.stderr.write(`Cortex PostToolUse error: ${err.message}\n`);
  process.exit(0);
}
