#!/usr/bin/env node
// PreCompact Hook — Save important data before context compaction

import { readFileSync, existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { openDb } from './ensure-db.js';

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { session_id, transcript_path, cwd } = input;

  const db = openDb(cwd);

  try {
    db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, new Date().toISOString(), 'active');

    if (!transcript_path || !existsSync(transcript_path)) return;

    const filesModified = new Set();
    let toolCallCount = 0;

    const rl = createInterface({ input: createReadStream(transcript_path, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block.type === 'tool_use') {
              toolCallCount++;
              if (['Write', 'Edit'].includes(block.name) && block.input?.file_path) filesModified.add(block.input.file_path);
            }
          }
        }
      } catch { /* skip */ }
    }

    const fileList = [...filesModified];
    const existing = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(session_id);
    if (!existing?.summary) {
      db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(
        `[Interim] ${toolCallCount} tools, ${fileList.length} files: ${fileList.slice(0, 5).join(', ')}`, session_id);
    }

    const ts = new Date().toISOString();
    const fStmt = db.prepare(`INSERT INTO project_files (path, change_count, last_changed, last_changed_session) VALUES (?, 1, ?, ?)
      ON CONFLICT(path) DO UPDATE SET change_count = project_files.change_count + 1, last_changed = ?, last_changed_session = ?`);
    for (const f of fileList) fStmt.run(f, ts, session_id, ts, session_id);
  } finally {
    db.close();
  }
}

main().catch(err => { process.stderr.write(`Cortex PreCompact: ${err.message}\n`); process.exit(0); });
