#!/usr/bin/env node
// Stop Hook — Summarize session and save to DB

import { readFileSync, existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { openDb } from './ensure-db.js';

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { session_id, transcript_path, cwd } = input;

  const db = openDb(cwd);

  try {
    const toolCalls = [];
    const filesModified = new Set();

    if (transcript_path && existsSync(transcript_path)) {
      const rl = createInterface({ input: createReadStream(transcript_path, { encoding: 'utf-8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type === 'tool_use') {
                toolCalls.push(block.name);
                if (['Write', 'Edit'].includes(block.name) && block.input?.file_path) filesModified.add(block.input.file_path);
              }
            }
          }
        } catch { /* skip */ }
      }
    }

    const fileList = [...filesModified];
    const toolCounts = {};
    for (const t of toolCalls) toolCounts[t] = (toolCounts[t] || 0) + 1;

    const parts = [];
    if (fileList.length > 0) parts.push(`Files: ${fileList.slice(0, 10).join(', ')}${fileList.length > 10 ? ` (+${fileList.length - 10})` : ''}`);
    const actions = Object.entries(toolCounts).sort(([, a], [, b]) => b - a).map(([t, c]) => `${t}:${c}`).join(', ');
    if (actions) parts.push(`Actions: ${actions}`);
    const summary = parts.join(' | ') || 'No significant activity';
    const keyChanges = JSON.stringify(fileList.slice(0, 20).map(f => ({ file: f, action: 'modified', description: '' })));
    const ts = new Date().toISOString();

    const session = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(session_id);
    const startedAt = session?.started_at || ts;
    const dur = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);

    db.prepare(`INSERT INTO sessions (id, started_at, ended_at, duration_seconds, summary, key_changes, status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed')
      ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, duration_seconds=excluded.duration_seconds,
        summary=excluded.summary, key_changes=excluded.key_changes, status='completed'`
    ).run(session_id, startedAt, ts, dur, summary, keyChanges);

    // Track files
    const fStmt = db.prepare(`INSERT INTO project_files (path, change_count, last_changed, last_changed_session) VALUES (?, 1, ?, ?)
      ON CONFLICT(path) DO UPDATE SET change_count = project_files.change_count + 1, last_changed = ?, last_changed_session = ?`);
    for (const f of fileList) fStmt.run(f, ts, session_id, ts, session_id);

    // Health snapshot
    try {
      const last = db.prepare('SELECT date FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
      if (!last || (Date.now() - new Date(last.date).getTime()) > 6 * 3600 * 1000) {
        const oe = db.prepare('SELECT COUNT(*) as c FROM errors WHERE fix_description IS NULL').get().c;
        const ou = db.prepare('SELECT COUNT(*) as c FROM unfinished WHERE resolved_at IS NULL').get().c;
        let score = Math.max(0, Math.min(100, 100 - oe * 5 - ou * 2));
        const today = ts.split('T')[0];
        const prev = db.prepare('SELECT score FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
        const trend = !prev ? 'stable' : score > prev.score + 2 ? 'up' : score < prev.score - 2 ? 'down' : 'stable';
        db.prepare(`INSERT INTO health_snapshots (date, score, metrics, trend) VALUES (?, ?, ?, ?)
          ON CONFLICT(date) DO UPDATE SET score=excluded.score, metrics=excluded.metrics, trend=excluded.trend`
        ).run(today, score, JSON.stringify({ openErrors: oe, openUnfinished: ou }), trend);
      }
    } catch { /* non-critical */ }
  } finally {
    db.close();
  }
}

main().catch(err => { process.stderr.write(`Cortex SessionEnd: ${err.message}\n`); process.exit(0); });
