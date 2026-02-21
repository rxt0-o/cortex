#!/usr/bin/env node
// SessionStart Hook — Loads relevant context and injects it + starts daemon

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { join } from 'path';
import { openDb } from './ensure-db.js';

function ensureDaemonRunning(cwd) {
  try {
    const pidPath = join(cwd, '.claude', 'cortex-daemon.pid');
    const daemonScript = 'C:/Users/toasted/Desktop/data/cortex/daemon/dist/index.js';

    if (!existsSync(daemonScript)) return; // Daemon nicht gebaut

    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      // Pruefen ob Prozess noch laeuft (kill 0 = nur Signal-Check)
      try {
        process.kill(pid, 0);
        return; // Daemon laeuft bereits
      } catch {
        // PID ist veraltet, loeschen
        try { require('fs').unlinkSync(pidPath); } catch { /* ignore */ }
      }
    }

    // Daemon als detached Prozess starten
    const daemon = spawn('node', [daemonScript, '--project', cwd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    daemon.unref();
  } catch { /* nicht kritisch */ }
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { session_id, cwd } = input;

  // Daemon starten (falls nicht bereits laufend)
  ensureDaemonRunning(cwd);

  const db = openDb(cwd);

  try {
    const parts = [];

    // 1. Git status
    let branch = 'unknown';
    let changedFiles = [];
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
      const status = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
      if (status) changedFiles = status.split('\n');
    } catch { /* not a git repo */ }

    // 2. Recent sessions
    const recentSessions = db.prepare(`
      SELECT id, started_at, summary, tags FROM sessions
      WHERE status != 'active' AND summary IS NOT NULL
      ORDER BY started_at DESC LIMIT 3
    `).all();

    if (recentSessions.length > 0) {
      parts.push('RECENT SESSIONS:');
      for (const s of recentSessions) {
        let tagStr = '';
        try {
          const tags = s.tags ? JSON.parse(s.tags) : [];
          if (tags.length > 0) tagStr = ` [${tags.join(', ')}]`;
        } catch { /* ignore */ }
        parts.push(`  [${timeAgo(s.started_at)}] ${s.summary}${tagStr}`);
      }
    }

    // 3. Unfinished business
    const unfinishedItems = db.prepare(`
      SELECT description, priority FROM unfinished
      WHERE resolved_at IS NULL
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END
      LIMIT 5
    `).all();

    if (unfinishedItems.length > 0) {
      parts.push('UNFINISHED:');
      for (const u of unfinishedItems) parts.push(`  - [${u.priority}] ${u.description}`);
    }

    let snoozeDue = [];
    try { snoozeDue = db.prepare(`SELECT id, description FROM unfinished WHERE snooze_until IS NOT NULL AND snooze_until <= datetime('now') AND resolved_at IS NULL ORDER BY snooze_until ASC LIMIT 5`).all(); } catch {}
    if (snoozeDue.length > 0) { parts.push('REMINDERS DUE:'); snoozeDue.forEach(s => parts.push(`  [REMIND] ${s.description}`)); }

    // 4. Errors in changed files
    if (changedFiles.length > 0) {
      const errStmt = db.prepare(`SELECT error_message, fix_description FROM errors WHERE files_involved LIKE ? ORDER BY occurrences DESC LIMIT 2`);
      let hasHeader = false;
      for (const f of changedFiles.slice(0, 5)) {
        const fileErrors = errStmt.all(`%${f}%`);
        for (const e of fileErrors) {
          if (!hasHeader) { parts.push('ERRORS IN CHANGED FILES:'); hasHeader = true; }
          const fix = e.fix_description ? ` Fix: ${e.fix_description}` : '';
          parts.push(`  ! ${e.error_message}${fix}`);
        }
      }
    }

    // 5a. Auto-block Learnings MIT regex (werden in PreToolUse aktiv gecheckt)
    const blockedLearnings = db.prepare(`
      SELECT anti_pattern, correct_pattern FROM learnings
      WHERE auto_block = 1 AND detection_regex IS NOT NULL ORDER BY occurrences DESC LIMIT 6
    `).all();

    // 5b. Auto-block Learnings OHNE regex (müssen manuell beachtet werden)
    const manualLearnings = db.prepare(`
      SELECT anti_pattern, correct_pattern FROM learnings
      WHERE auto_block = 1 AND detection_regex IS NULL ORDER BY occurrences DESC LIMIT 10
    `).all();

    if (blockedLearnings.length > 0) {
      parts.push('AUTO-BLOCKED PATTERNS (regex-enforced):');
      for (const l of blockedLearnings) parts.push(`  X ${l.anti_pattern} -> ${l.correct_pattern}`);
    }

    if (manualLearnings.length > 0) {
      parts.push('CRITICAL RULES (remember — no regex check):');
      for (const l of manualLearnings) parts.push(`  ! ${l.anti_pattern}`);
    }

    // 6. Health
    const health = db.prepare('SELECT score, trend FROM health_snapshots ORDER BY date DESC LIMIT 1').get();

    if (parts.length === 0) {
      // Still register the session even if no context to show
      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, new Date().toISOString(), 'active');
      return;
    }

    const healthStr = health ? ` | Health: ${health.score}/100 (${health.trend === 'up' ? '+' : health.trend === 'down' ? '-' : '='})` : '';

    const context = [
      `-- Project Cortex${healthStr} --`,
      `Branch: ${branch}`,
      '', ...parts, '',
      '/cortex-search, /cortex-map, /cortex-deps for details',
      '---',
    ].join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }));

    // Register session
    db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, new Date().toISOString(), 'active');
  } finally {
    db.close();
  }
}

function timeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

try { main(); } catch (err) {
  process.stderr.write(`Cortex SessionStart error: ${err.message}\n`);
  process.exit(0);
}
