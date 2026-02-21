#!/usr/bin/env node
// Stop Hook — Summarize session and save to DB + notify daemon

import { readFileSync, existsSync, createReadStream, appendFileSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { openDb } from './ensure-db.js';

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { session_id, transcript_path, cwd } = input;

  const db = openDb(cwd);

  try {
    const toolCalls = [];
    const filesModified = new Set();

    const userMessages = [];
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
          // User-Messages extrahieren für semantische Summary
          if (entry.type === 'human' && Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type === 'text' && block.text && block.text.length > 20) {
                // Hook-injizierte Nachrichten filtern
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
    }

    const fileList = [...filesModified];
    const toolCounts = {};
    for (const t of toolCalls) toolCounts[t] = (toolCounts[t] || 0) + 1;

    const parts = [];
    if (fileList.length > 0) parts.push(`Files: ${fileList.slice(0, 10).join(', ')}${fileList.length > 10 ? ` (+${fileList.length - 10})` : ''}`);
    const actions = Object.entries(toolCounts).sort(([, a], [, b]) => b - a).map(([t, c]) => `${t}:${c}`).join(', ');
    if (actions) parts.push(`Actions: ${actions}`);
    let summary = parts.join(' | ') || 'No significant activity';
    let sessionTags = [];

    // Haiku-Agent für semantische Summary (nur wenn echte Arbeit geleistet)
    if (fileList.length > 0 || toolCalls.length > 3) {
      const aiResult = await buildTranscriptSummary(transcript_path, fileList, toolCounts);
      if (aiResult?.summary) {
        summary = aiResult.summary;
        sessionTags = aiResult.tags;
      }
    }
    const keyChanges = JSON.stringify(fileList.slice(0, 20).map(f => ({ file: f, action: 'modified', description: '' })));
    const ts = new Date().toISOString();

    const session = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(session_id);
    const startedAt = session?.started_at || ts;
    const dur = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);

    db.prepare(`INSERT INTO sessions (id, started_at, ended_at, duration_seconds, summary, key_changes, status, tags)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
      ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, duration_seconds=excluded.duration_seconds,
        summary=excluded.summary, key_changes=excluded.key_changes, status='completed', tags=excluded.tags`
    ).run(session_id, startedAt, ts, dur, summary, keyChanges, JSON.stringify(sessionTags));

    // Track files
    const fStmt = db.prepare(`INSERT INTO project_files (path, change_count, last_changed, last_changed_session) VALUES (?, 1, ?, ?)
      ON CONFLICT(path) DO UPDATE SET change_count = project_files.change_count + 1, last_changed = ?, last_changed_session = ?`);
    for (const f of fileList) fStmt.run(f, ts, session_id, ts, session_id);

    // session_end Event fuer Daemon queuen (Learner-Agent)
    try {
      const queuePath = join(cwd, '.claude', 'cortex-events.jsonl');
      const event = {
        type: 'session_end',
        session_id,
        transcript_path: transcript_path || null,
        ts: ts,
      };
      appendFileSync(queuePath, JSON.stringify(event) + '\n', 'utf-8');
    } catch { /* nicht kritisch */ }

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

// Ruft claude CLI auf um eine semantische Summary zu erzeugen
// Gibt null zurück wenn claude nicht verfügbar oder Timeout
async function buildTranscriptSummary(transcriptPath, fileList, toolCounts) {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const filesStr = fileList.slice(0, 8).join(', ');
    const toolStr = Object.entries(toolCounts)
      .sort(([,a],[,b]) => b-a).slice(0, 5)
      .map(([t,c]) => `${t}:${c}`).join(', ');

    let userMessages = '';
    try {
      const { readFileSync } = await import('fs');
      const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
      const msgs = [];
      for (const line of lines) {
        if (msgs.length >= 5) break;
        try {
          const e = JSON.parse(line);
          if (e.role === 'user' && typeof e.content === 'string' && e.content.length > 10) {
            msgs.push(e.content.slice(0, 120));
          } else if (e.role === 'user' && Array.isArray(e.content)) {
            const text = e.content.find(b => b.type === 'text')?.text;
            if (text && text.length > 10) msgs.push(text.slice(0, 120));
          }
        } catch { /* skip */ }
      }
      userMessages = msgs.join(' | ');
    } catch { /* optional */ }

    const prompt = `Summarize this coding session in 1-2 sentences (English, concise, focus on WHAT was done and WHY):
Files changed: ${filesStr || 'none'}
Tools used: ${toolStr || 'none'}
User requests: ${userMessages || 'unknown'}

Reply with ONLY:
SUMMARY: <1-2 sentence summary>
TAGS: <comma-separated tags from: bugfix,feature,refactor,security,database,frontend,backend,docs,config>`;

    const result = await execFileAsync('claude', [
      '--model', 'claude-haiku-4-5-20251001',
      '--max-tokens', '150',
      '-p', prompt,
    ], { timeout: 20000, encoding: 'utf-8' });

    const output = result.stdout.trim();
    const summaryMatch = output.match(/SUMMARY:\s*(.+)/);
    const tagsMatch = output.match(/TAGS:\s*(.+)/);

    return {
      summary: summaryMatch?.[1]?.trim() ?? null,
      tags: tagsMatch?.[1]?.split(',').map(t => t.trim()).filter(Boolean) ?? [],
    };
  } catch {
    return null;
  }
}

main().catch(err => { process.stderr.write(`Cortex SessionEnd: ${err.message}\n`); process.exit(0); });
