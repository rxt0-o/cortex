#!/usr/bin/env node
// Stop hook: summarize session and persist state.

import { readFileSync, existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { openDb } from './ensure-db.js';

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { session_id, transcript_path, cwd, stop_hook_active } = input;
  if (stop_hook_active) process.exit(0);

  const db = openDb(cwd);

  try {
    const toolCalls = [];
    const filesModified = new Set();
    const userMessages = [];

    if (transcript_path && existsSync(transcript_path)) {
      const rl = createInterface({
        input: createReadStream(transcript_path, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type !== 'tool_use') continue;
              toolCalls.push(block.name);
              if (['Write', 'Edit'].includes(block.name) && block.input?.file_path) {
                filesModified.add(block.input.file_path);
              }
            }
          }

          if (entry.type === 'human' && Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type !== 'text' || !block.text || block.text.length <= 20) continue;
              if (
                !block.text.startsWith('-- Project Cortex') &&
                !block.text.startsWith('Cortex') &&
                !block.text.includes('hookSpecificOutput') &&
                !block.text.includes('SessionStart hook')
              ) {
                userMessages.push(block.text.slice(0, 200));
              }
            }
          }
        } catch {
          // Ignore malformed transcript entries.
        }
      }
    }

    const fileList = [...filesModified];
    const ts = new Date().toISOString();
    let summary = '';

    if (userMessages.length > 0) {
      summary = userMessages.slice(0, 3).map((m) => m.slice(0, 80)).join(' / ');
    } else {
      const touched = fileList.length > 0 ? ` | files: ${fileList.slice(0, 4).join(', ')}` : '';
      summary = `[Auto] ${toolCalls.length} tool calls, ${fileList.length} file changes${touched}`;
    }

    const keyChanges = JSON.stringify(
      fileList.slice(0, 20).map((file) => ({ file, action: 'modified', description: '' }))
    );

    const session = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(session_id);
    const startedAt = session?.started_at || ts;
    const durationSeconds = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);

    db.prepare(`
      INSERT INTO sessions (id, started_at, ended_at, duration_seconds, summary, key_changes, status)
      VALUES (?, ?, ?, ?, ?, ?, 'completed')
      ON CONFLICT(id) DO UPDATE SET
        ended_at = excluded.ended_at,
        duration_seconds = excluded.duration_seconds,
        summary = excluded.summary,
        key_changes = excluded.key_changes,
        status = 'completed'
    `).run(session_id, startedAt, ts, durationSeconds, summary, keyChanges);

    const fileStmt = db.prepare(`
      INSERT INTO project_files (path, change_count, last_changed, last_changed_session)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        change_count = project_files.change_count + 1,
        last_changed = ?,
        last_changed_session = ?
    `);
    for (const file of fileList) {
      fileStmt.run(file, ts, session_id, ts, session_id);
    }

    try {
      db.prepare(`
        UPDATE decisions
        SET stale = 1
        WHERE stale != 1
          AND created_at < datetime('now','-90 days')
          AND (reviewed_at IS NULL OR reviewed_at < datetime('now','-90 days'))
      `).run();
    } catch {
      // Non-critical.
    }

    try {
      const last = db.prepare('SELECT date FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
      if (!last || (Date.now() - new Date(last.date).getTime()) > 6 * 3600 * 1000) {
        const openErrors = db.prepare('SELECT COUNT(*) as c FROM errors WHERE fix_description IS NULL').get().c;
        const openUnfinished = db.prepare('SELECT COUNT(*) as c FROM unfinished WHERE resolved_at IS NULL').get().c;
        const score = Math.max(0, Math.min(100, 100 - openErrors * 5 - openUnfinished * 2));
        const today = ts.split('T')[0];
        const prev = db.prepare('SELECT score FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
        const trend = !prev ? 'stable' : score > prev.score + 2 ? 'up' : score < prev.score - 2 ? 'down' : 'stable';
        db.prepare(`
          INSERT INTO health_snapshots (date, score, metrics, trend)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(date) DO UPDATE SET
            score = excluded.score,
            metrics = excluded.metrics,
            trend = excluded.trend
        `).run(today, score, JSON.stringify({ openErrors, openUnfinished }), trend);
      }
    } catch {
      // Non-critical.
    }

    try {
      db.prepare(`
        UPDATE learnings
        SET archived = 1, archived_at = datetime('now')
        WHERE auto_block = 1
          AND theoretical_hits = 0
          AND created_at < datetime('now','-30 days')
          AND core_memory != 1
          AND archived_at IS NULL
      `).run();
      db.prepare('UPDATE learnings SET core_memory = 1 WHERE theoretical_hits >= 10').run();
    } catch {
      // Non-critical.
    }

    try {
      db.prepare(`
        UPDATE learnings
        SET confidence = MAX(0.3, confidence - 0.01)
        WHERE auto_block = 1
          AND core_memory != 1
          AND archived_at IS NULL
      `).run();
    } catch {
      // Non-critical.
    }

    try {
      db.prepare(`
        UPDATE unfinished
        SET priority_score = COALESCE(priority_score, 50) + 5
        WHERE resolved_at IS NULL
          AND created_at < datetime('now','-3 days')
          AND priority = 'high'
      `).run();
      db.prepare(`
        UPDATE unfinished
        SET priority_score = COALESCE(priority_score, 50) + 2
        WHERE resolved_at IS NULL
          AND created_at < datetime('now','-7 days')
          AND priority = 'medium'
      `).run();
    } catch {
      // Non-critical.
    }

    try {
      const { runAutoRegex } = await import('./auto-regex.js');
      await runAutoRegex(cwd);
    } catch {
      // Non-critical.
    }

    // Phase 5: Auto-Extraction from transcript
    try {
      extractFromTranscript(db, session_id, transcript_path);
    } catch {
      // Non-critical — extraction failure must not block session end.
    }
  } finally {
    db.close();
  }
}

// Phase 5: Auto-Extraction patterns and logic

const EXTRACTION_PATTERNS = [
  { type: 'error',      regex: /\b(?:error|bug|broke|crash|failed)\b/i,                          base_confidence: 0.6 },
  { type: 'decision',   regex: /\b(?:we decided|going with|let's use|chose to|decision:)\b/i,    base_confidence: 0.5 },
  { type: 'learning',   regex: /\b(?:learned that|TIL|turns out|gotcha|important:)\b/i,           base_confidence: 0.5 },
  { type: 'convention', regex: /\b(?:convention:|always use|never use|must always|rule:)\b/i,      base_confidence: 0.4 },
];

const SKIP_PATTERNS = [
  /^(?:fix|feat|chore|docs|refactor|test)\(.+\):/i,
  /^\s*\d+ errors?.*\d+ warnings?/i,
  /eslint|prettier|tsc/i,
];

function extractFromTranscript(db, sessionId, transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  // Read transcript synchronously for simplicity (already parsed above in async context,
  // but we need the assistant text blocks here)
  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  const chunks = [];
  // Track retry-detector data from edit_tracker
  let retryFiles = [];
  try {
    retryFiles = db.prepare(
      `SELECT tracker_key, count FROM edit_tracker WHERE count >= 3`
    ).all().map(r => r.tracker_key);
  } catch { /* edit_tracker may not exist */ }

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (block.type === 'text' && block.text) {
            // Split into paragraphs/chunks
            const paragraphs = block.text.split(/\n{2,}/).filter(p => p.trim().length >= 50);
            for (const p of paragraphs) {
              chunks.push(p.trim().slice(0, 500));
            }
          }
        }
      }
    } catch {
      // Malformed line.
    }
  }

  if (chunks.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO auto_extractions (session_id, type, content, confidence, status, source_context, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let extracted = 0;
  const MAX_EXTRACTIONS = 20;

  for (const chunk of chunks) {
    if (extracted >= MAX_EXTRACTIONS) break;

    // Skip patterns
    if (SKIP_PATTERNS.some(re => re.test(chunk))) continue;

    for (const pattern of EXTRACTION_PATTERNS) {
      if (!pattern.regex.test(chunk)) continue;

      let confidence = pattern.base_confidence;

      // Confidence modifiers
      if (/```/.test(chunk)) confidence += 0.2;  // Code block
      if (/[\w-]+\.\w{1,4}/.test(chunk)) confidence += 0.1;  // Filename
      if (retryFiles.some(f => chunk.includes(f.split(':')[0]))) confidence += 0.15;  // Retry-detector
      if (chunk.length < 50) confidence -= 0.1;  // Short

      confidence = Math.round(Math.min(1.0, Math.max(0, confidence)) * 100) / 100;

      // Threshold: drop below 0.4
      if (confidence < 0.4) continue;

      const status = confidence >= 0.7 ? 'promoted' : 'pending';
      const sourceContext = chunk.slice(0, 200);

      try {
        const insertResult = insertStmt.run(sessionId, pattern.type, chunk.slice(0, 300), confidence, status, sourceContext);
        const extractionId = Number(insertResult.lastInsertRowid);
        extracted++;

        // Auto-promote high-confidence items
        if (status === 'promoted') {
          const promoted = autoPromote(db, sessionId, pattern.type, chunk.slice(0, 300));
          if (promoted) {
            db.prepare(`
              UPDATE auto_extractions
              SET promoted_to_type = ?, promoted_to_id = ?
              WHERE id = ?
            `).run(promoted.type, promoted.id, extractionId);
          } else {
            // Promotion failed; keep item reviewable instead of leaving a broken "promoted" record.
            db.prepare(`UPDATE auto_extractions SET status = 'pending' WHERE id = ?`).run(extractionId);
          }
        }
      } catch {
        // Duplicate or constraint error — skip.
      }

      break; // One pattern match per chunk
    }
  }
}

function autoPromote(db, sessionId, type, content) {
  const ts = new Date().toISOString();
  try {
    if (type === 'error') {
      const sig = `auto-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = db.prepare(
        `INSERT INTO errors (session_id, first_seen, last_seen, error_signature, error_message, severity)
         VALUES (?, ?, ?, ?, ?, 'medium')`
      ).run(sessionId, ts, ts, sig, content);
      return { type: 'error', id: Number(result.lastInsertRowid) };
    } else if (type === 'decision') {
      const result = db.prepare(
        `INSERT INTO decisions (session_id, created_at, category, title, reasoning, confidence)
         VALUES (?, ?, 'auto-extracted', ?, '[auto-extracted]', 'low')`
      ).run(sessionId, ts, content);
      return { type: 'decision', id: Number(result.lastInsertRowid) };
    } else if (type === 'learning' || type === 'convention') {
      const result = db.prepare(
        `INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, context, confidence)
         VALUES (?, ?, ?, '[auto-extracted]', 'auto-extracted from transcript', 0.4)`
      ).run(sessionId, ts, content);
      return { type: 'learning', id: Number(result.lastInsertRowid) };
    }
  } catch {
    // Non-critical.
  }
  return null;
}

main().catch((err) => {
  process.stderr.write(`Cortex SessionEnd: ${err.message}\n`);
  process.exit(0);
});
