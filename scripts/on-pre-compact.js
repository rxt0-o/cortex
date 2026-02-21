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
    const userMessages = [];

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
        if (entry.type === 'human' && Array.isArray(entry.content)) {
          for (const block of entry.content) {
            if (block.type === 'text' && block.text && block.text.length > 20) {
              if (!block.text.startsWith('-- Project Cortex') &&
                  !block.text.startsWith('Cortex') &&
                  !block.text.includes('hookSpecificOutput') &&
                  !block.text.includes('SessionStart hook')) {
                userMessages.push(block.text.slice(0, 200));
              }
            }
          }
        }
      } catch { /* skip */ }
    }

    const fileList = [...filesModified];
    const existing = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(session_id);
    if (!existing?.summary) {
      let summary;
      if (userMessages.length > 0) {
        const lastRequest = userMessages[userMessages.length - 1].split('\n')[0].slice(0, 150);
        const fileContext = fileList.length > 0
          ? ` [${fileList.slice(0, 3).map(f => f.split('/').pop()).join(', ')}]`
          : '';
        summary = `[Interim] ${lastRequest}${fileContext}`;
      } else {
        summary = `[Interim] ${toolCallCount} tools, ${fileList.length} files: ${fileList.slice(0, 5).join(', ')}`;
      }
      db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(summary, session_id);
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
