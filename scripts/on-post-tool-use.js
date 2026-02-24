#!/usr/bin/env node
// PostToolUse Hook (async) - Track file changes and queue events for daemon

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { openDb } from './ensure-db.js';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { tool_name, tool_input, session_id, cwd } = input;

  const filePath = tool_input?.file_path;

  if (tool_name === 'Read') process.exit(0);
  if (!['Write', 'Edit', 'Bash'].includes(tool_name)) process.exit(0);

  // Bash: only continue for migration-related git commands.
  if (tool_name === 'Bash') {
    const cmd = tool_input?.command || '';
    const hasMigration = cmd.includes('migrations/');
    const hasGit = /git\s+(?:add|commit)/.test(cmd);
    if (!hasMigration || !hasGit) process.exit(0);
  }

  if (!filePath && tool_name !== 'Bash') process.exit(0);

  const dbPath = join(cwd, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) process.exit(0);

  const db = openDb(cwd);

  try {
    ensureEditTrackerTable(db);
    const ts = new Date().toISOString();

    if (tool_name !== 'Bash') {
      // 1) Track file change (Hot Zones)
      db.prepare(`
        INSERT INTO project_files (path, change_count, last_changed, last_changed_session)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          change_count = project_files.change_count + 1,
          last_changed = ?,
          last_changed_session = ?
      `).run(filePath, ts, session_id, ts, session_id);

      // 2) Infer file type
      const ft = inferFileType(filePath);
      if (ft) {
        db.prepare('UPDATE project_files SET file_type = COALESCE(file_type, ?) WHERE path = ?').run(ft, filePath);
      }

      // 3) Ensure session exists for FK constraints
      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, ts, 'active');

      // 4) Save diff snapshot
      if (tool_name === 'Edit' && tool_input.old_string && tool_input.new_string) {
        db.prepare(`
          INSERT INTO diffs (session_id, file_path, diff_content, change_type, lines_added, lines_removed, created_at)
          VALUES (?, ?, ?, 'modified', ?, ?, ?)
        `).run(
          session_id,
          filePath,
          `--- a\n+++ b\n-${tool_input.old_string}\n+${tool_input.new_string}`,
          tool_input.new_string.split('\n').length,
          tool_input.old_string.split('\n').length,
          ts
        );
      } else if (tool_name === 'Write') {
        const lines = (tool_input.content || '').split('\n').length;
        db.prepare(`
          INSERT INTO diffs (session_id, file_path, diff_content, change_type, lines_added, lines_removed, created_at)
          VALUES (?, ?, ?, 'modified', ?, 0, ?)
        `).run(session_id, filePath, `[Write: ${lines} lines]`, lines, ts);
      }

      // 5) Scan imports + exports (only on Write where full content is available)
      const content = tool_input.content || '';
      if (content) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        if (['ts', 'tsx', 'js', 'jsx', 'py'].includes(ext || '')) {
          db.prepare('DELETE FROM dependencies WHERE source_file = ?').run(filePath);
          const depStmt = db.prepare('INSERT OR IGNORE INTO dependencies (source_file, target_file, import_type) VALUES (?, ?, ?)');
          for (const imp of scanImports(content, ext)) depStmt.run(filePath, imp, 'static');

          const symbols = extractExports(content, ext);
          if (symbols.length > 0) {
            db.prepare('UPDATE project_files SET exports = ? WHERE path = ?').run(JSON.stringify(symbols), filePath);
          }
        }
      }

      // 6) Loop detector: warn if same file/function is edited repeatedly in a short window.
      let changedFunction = '';
      try {
        const changedContent = (tool_input?.new_string ?? tool_input?.content ?? '');
        const patterns = [/(?:async\s+)?function\s+(\w+)/, /const\s+(\w+)\s*=/, /class\s+(\w+)/];
        for (const pat of patterns) {
          const m = changedContent.match(pat);
          if (m?.[1]) {
            changedFunction = m[1];
            break;
          }
        }
      } catch {
        // ignore parse issues
      }

      const trackKey = changedFunction ? `${filePath}:${changedFunction}` : filePath;
      const trackLabel = changedFunction ? `${filePath} -> ${changedFunction}()` : filePath;
      const tracked = bumpEditTracker(db, trackKey, ts);
      if (tracked.count >= 3 && tracked.withinWindow) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `LOOP DETECTED: ${trackLabel} edited ${tracked.count}x in 5 minutes - consider stepping back`,
          },
        }));
      }
    }

    // 7) Migration tracking (Gotcha #133)
    if (tool_name === 'Bash') {
      const cmd = tool_input?.command || '';
      const migrationMatches = cmd.match(/migrations\/[\w_]+\.sql/g);
      if (migrationMatches && /git\s+(?:add|commit)/.test(cmd)) {
        db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, ts, 'active');

        for (const mig of migrationMatches) {
          const migName = mig.split('/').pop();
          const description = `Deploy migration in Supabase SQL Editor: ${migName}`;

          const existing = db.prepare(
            'SELECT id FROM unfinished WHERE description = ? AND resolved_at IS NULL'
          ).get(description);

          if (!existing) {
            db.prepare(`
              INSERT INTO unfinished (session_id, created_at, description, context, priority)
              VALUES (?, ?, ?, ?, 'high')
            `).run(
              session_id,
              ts,
              description,
              'Automatically detected via Cortex migration tracker (Gotcha #133)'
            );
          }
        }
      }
    }
  } finally {
    db.close();
  }
}

function ensureEditTrackerTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edit_tracker (
      tracker_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);
}

function bumpEditTracker(db, trackerKey, nowIso) {
  const nowMs = Date.parse(nowIso);
  const windowMs = 5 * 60 * 1000;

  const prev = db.prepare(`
    SELECT count, first_seen_at
    FROM edit_tracker
    WHERE tracker_key = ?
  `).get(trackerKey);

  let count = 1;
  let firstSeenAt = nowIso;

  if (prev) {
    const firstMs = Date.parse(prev.first_seen_at);
    if (Number.isFinite(firstMs) && (nowMs - firstMs) < windowMs) {
      count = Number(prev.count) + 1;
      firstSeenAt = prev.first_seen_at;
    }
  }

  db.prepare(`
    INSERT INTO edit_tracker (tracker_key, count, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tracker_key) DO UPDATE SET
      count = excluded.count,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at
  `).run(trackerKey, count, firstSeenAt, nowIso);

  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM edit_tracker WHERE last_seen_at < ?').run(cutoff);

  return {
    count,
    withinWindow: (nowMs - Date.parse(firstSeenAt)) < windowMs,
  };
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
      let m;
      while ((m = re.exec(content))) symbols.push(m[1]);
    }
  } else if (ext === 'py') {
    const patterns = [
      /^(?:async\s+)?def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content))) {
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
    let m;
    while ((m = re.exec(content))) {
      if (m[1].startsWith('.') || m[1].startsWith('/')) imports.push(m[1]);
    }
  } else if (ext === 'py') {
    const re = /from\s+([\w.]+)\s+import/g;
    let m;
    while ((m = re.exec(content))) {
      if (m[1].startsWith('app') || m[1].includes('.')) imports.push(m[1]);
    }
  }
  return imports;
}

try {
  main();
} catch (err) {
  process.stderr.write(`Cortex PostToolUse error: ${err.message}\n`);
  process.exit(0);
}
