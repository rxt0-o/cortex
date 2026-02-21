#!/usr/bin/env node
// PostToolUse Hook (async) — Track file changes

import { readFileSync, existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { tool_name, tool_input, session_id, cwd } = input;

  if (!['Write', 'Edit'].includes(tool_name)) process.exit(0);
  const filePath = tool_input?.file_path;
  if (!filePath) process.exit(0);

  const dbPath = join(cwd, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) process.exit(0);

  const db = new DatabaseSync(dbPath);

  try {
    const ts = new Date().toISOString();

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

    // 5. Scan imports
    const content = tool_input.content || '';
    if (content) {
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (['ts', 'tsx', 'js', 'jsx', 'py'].includes(ext || '')) {
        db.prepare('DELETE FROM dependencies WHERE source_file = ?').run(filePath);
        const stmt = db.prepare('INSERT OR IGNORE INTO dependencies (source_file, target_file, import_type) VALUES (?, ?, ?)');
        for (const imp of scanImports(content, ext)) stmt.run(filePath, imp, 'static');
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
