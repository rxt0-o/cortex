#!/usr/bin/env node
// SessionStart Hook — Loads relevant context and injects it + starts daemon

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './ensure-db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Preloaded Tool Guidance (memory + tracking) — aus tool-registry.ts generiert
const PRELOADED_TOOL_GUIDANCE = `## Memory & Context Tools

Use these at session start or when resuming work.

- **cortex_snapshot** → Full brain state: open items, recent sessions, decisions, learnings. Call this first in complex sessions.
- **cortex_get_context** → Relevant context for specific files. Pass file paths to get related decisions/errors/sessions.
- **cortex_list_sessions** → Recent work history with summaries.
- **cortex_search** → BM25/FTS5 full-text search across all stored data (sessions, decisions, errors, learnings).

---

## Tracking & TODOs Tools

Use when noting unfinished work or setting reminders.

- **cortex_add_unfinished** → Track something that needs to be done later. Fields: description, priority (low/medium/high), context.
- **cortex_get_unfinished** → List open/unresolved items.
- **cortex_resolve_unfinished** → Mark an unfinished item as done.
- **cortex_add_intent** → Store what you plan to do next session (shown at next SessionStart).
- **cortex_snooze** → Schedule a future session reminder. Use relative (3d/1w) or ISO date.`;

function ensureWatcherRunning(cwd) {
  try {
    const pidPath = join(cwd, '.claude', 'cortex-watcher.pid');
    const watcherScript = join(__dirname, '..', 'daemon', 'dist', 'watcher.js');

    if (!existsSync(watcherScript)) return; // Watcher nicht gebaut

    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 0);
        return; // Watcher läuft bereits
      } catch {
        try { unlinkSync(pidPath); } catch { /* ignore */ }
      }
    }

    const watcher = spawn('node', [watcherScript, '--project', cwd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true,
    });
    watcher.unref();
  } catch { /* nicht kritisch */ }
}

function ensureDaemonRunning(cwd) {
  try {
    const pidPath = join(cwd, '.claude', 'cortex-daemon.pid');
    const daemonScript = join(__dirname, '..', 'daemon', 'dist', 'index.js');

    if (!existsSync(daemonScript)) return; // Daemon nicht gebaut

    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      // Pruefen ob Prozess noch laeuft (kill 0 = nur Signal-Check)
      try {
        process.kill(pid, 0);
        return; // Daemon laeuft bereits
      } catch {
        // PID ist veraltet, loeschen
        try { unlinkSync(pidPath); } catch { /* ignore */ }
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
  const { session_id, cwd, source } = input;
  const isCompact = source === 'compact';

  // Daemon starten (falls nicht bereits laufend — nicht bei Compaction)
  if (!isCompact) ensureDaemonRunning(cwd);
  if (!isCompact) ensureWatcherRunning(cwd);

  const db = openDb(cwd);

  // Auto-Bootstrap: Flag setzen wenn DB quasi leer
  try {
    const filesTracked = db.prepare(`SELECT COUNT(*) as c FROM project_files`).get()?.c ?? 0;
    if (filesTracked < 10) {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('needs_bootstrap', 'true') ON CONFLICT(key) DO NOTHING`).run();
    }
  } catch { /* ignore */ }

  // Active project from meta (optional)
  let activeProject = '';
  try { activeProject = db.prepare(`SELECT value FROM meta WHERE key='active_project'`).get()?.value || ''; } catch {}

  // Compact-Branch: kompakter Re-inject nach Context-Compaction
  if (isCompact) {
    try {
      const parts = [];

      // Letzte Session
      const lastSession = db.prepare(`SELECT summary FROM sessions WHERE status != 'active' AND summary IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get();
      if (lastSession) parts.push(`LAST SESSION: ${lastSession.summary}`);

      // Unfinished (nur High-Priority)
      const urgent = db.prepare(`SELECT description FROM unfinished WHERE resolved_at IS NULL AND priority='high' ORDER BY created_at DESC LIMIT 3`).all();
      if (urgent.length > 0) { parts.push('OPEN (high):'); urgent.forEach(u => parts.push(`  - ${u.description}`)); }

      // Auto-block rules
      const rules = db.prepare(`SELECT anti_pattern, correct_pattern FROM learnings WHERE auto_block=1 AND detection_regex IS NOT NULL ORDER BY occurrences DESC LIMIT 4`).all();
      if (rules.length > 0) { parts.push('AUTO-BLOCKED:'); rules.forEach(r => parts.push(`  X ${r.anti_pattern} -> ${r.correct_pattern}`)); }

      const context = [
        `-- Cortex re-injected after compaction${activeProject ? ` [${activeProject}]` : ''} --`,
        ...parts,
        '---',
        '',
        '## Preloaded Tool Guidance',
        PRELOADED_TOOL_GUIDANCE,
      ].join('\n');

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      }));

      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, new Date().toISOString(), 'active');
    } finally {
      db.close();
    }
    return;
  }

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

    // 1b. Intent-Prediction (vom PatternAgent pre-computed)
    try {
      const intentRow = db.prepare(`SELECT value FROM meta WHERE key='last_intent_prediction'`).get();
      if (intentRow?.value) {
        const intent = JSON.parse(intentRow.value);
        if (intent.predicted_task && intent.confidence > 0.2) {
          const confPct = Math.round((intent.confidence ?? 0) * 100);
          parts.push(`PREDICTED TASK: ${intent.predicted_task} (${confPct}% confident)`);
          if (intent.suggested_next_step) parts.push(`  -> Suggested: ${intent.suggested_next_step}`);
          if (intent.relevant_files?.length > 0) parts.push(`  -> Files: ${intent.relevant_files.slice(0, 5).join(', ')}`);
          const refs = [];
          if (intent.relevant_decision_ids?.length > 0) refs.push(`Decision ${intent.relevant_decision_ids.map(id => '#' + id).join(', ')}`);
          if (intent.relevant_error_ids?.length > 0) refs.push(`Error ${intent.relevant_error_ids.map(id => '#' + id).join(', ')}`);
          if (refs.length > 0) parts.push(`  -> Relevant: ${refs.join(', ')}`);
          parts.push('');
        }
      }
    } catch { /* keine Prediction vorhanden */ }

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

    // Surface open intents
    let openIntents = [];
    try {
      openIntents = db.prepare(`SELECT description FROM unfinished WHERE context='intent' AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 3`).all();
    } catch {}
    if (openIntents.length > 0) {
      parts.push('OPEN INTENTS:');
      openIntents.forEach(i => parts.push(`  -> ${i.description.replace('[INTENT] ', '')}`));
    }

    // Proactive nudges: anchors not touched in 7 days
    try {
      const staleAnchors = db.prepare(`SELECT topic FROM attention_anchors WHERE last_touched IS NULL OR last_touched < datetime('now','-7 days') ORDER BY priority DESC LIMIT 3`).get();
      if (staleAnchors) parts.push(`  NUDGE: Anchor not touched in 7d: "${staleAnchors.topic}"`);
    } catch {}

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

    // Low-confidence Learnings: User fragen ob behalten oder archivieren
    const lowConfidence = db.prepare(`
      SELECT id, anti_pattern, correct_pattern, COALESCE(confidence, 0.7) as confidence
      FROM learnings WHERE COALESCE(confidence, 0.7) <= 0.4 AND core_memory != 1 AND archived != 1
      ORDER BY confidence ASC LIMIT 3
    `).all();

    if (lowConfidence.length > 0) {
      parts.push('REVIEW NEEDED (low confidence):');
      for (const l of lowConfidence) {
        parts.push(`  ? Learning #${l.id} (${(l.confidence * 100).toFixed(0)}%): "${l.anti_pattern}" — keep or archive?`);
      }
    }

    // 6. Health
    // Weekly digest (Monday or 7+ days since last digest)
    try {
      const lastDigest = db.prepare(`SELECT value FROM meta WHERE key='last_weekly_digest'`).get()?.value;
      const daysSince = lastDigest ? (Date.now() - new Date(lastDigest).getTime()) / 86400000 : 999;
      if (new Date().getDay() === 1 || daysSince >= 7) {
        const s7 = db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE started_at > datetime('now','-7 days') AND status='completed'`).get()?.c || 0;
        const f7 = db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM diffs WHERE created_at > datetime('now','-7 days')`).get()?.c || 0;
        const fix7 = db.prepare(`SELECT COUNT(*) as c FROM errors WHERE fix_description IS NOT NULL AND session_id IN (SELECT id FROM sessions WHERE started_at > datetime('now','-7 days'))`).get()?.c || 0;
        const crit = db.prepare(`SELECT COUNT(*) as c FROM errors WHERE fix_description IS NULL AND severity='critical' AND archived!=1`).get()?.c || 0;
        parts.push('');
        parts.push('WEEKLY DIGEST:');
        parts.push(`  ${s7} sessions | ${f7} files | ${fix7} bugs fixed${crit > 0 ? ' | ' + crit + ' critical open' : ''}`);
        db.prepare(`INSERT INTO meta (key,value) VALUES ('last_weekly_digest',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
      }
    } catch {}

    // Bootstrap-Hinweis
    try {
      const needsBootstrap = db.prepare(`SELECT value FROM meta WHERE key='needs_bootstrap'`).get();
      if (needsBootstrap) {
        parts.push('');
        parts.push('BOOTSTRAP: Erstmalige Indexierung laeuft im Hintergrund...');
      }
    } catch {}

    const health = db.prepare('SELECT score, trend FROM health_snapshots ORDER BY date DESC LIMIT 1').get();

    // Stale decisions warning
    let staleCount = 0;
    try { staleCount = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE stale=1`).get()?.c || 0; } catch {}
    if (staleCount > 0) parts.push(`  STALE: ${staleCount} decisions >90 days — still current? (/cortex decisions)`);

    // First-run onboarding hint
    try {
      const onboarded = db.prepare(`SELECT value FROM meta WHERE key='onboarding_complete'`).get();
      if (!onboarded) {
        parts.push('');
        parts.push('SETUP: Run cortex_onboard() to personalize Cortex with your profile and attention anchors.');
      }
    } catch {}

    if (parts.length === 0) {
      // Still register the session even if no context to show
      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(session_id, new Date().toISOString(), 'active');
      return;
    }

    const healthStr = health ? ` | Health: ${health.score}/100 (${health.trend === 'up' ? '+' : health.trend === 'down' ? '-' : '='})` : '';

    // Circadian awareness
    const hour = new Date().getHours();
    if (hour < 12) parts.push('  MODE: Morning — focus mode active');
    else if (hour >= 17) parts.push('  MODE: Evening — review mode active');

    const context = [
      `-- Project Cortex${activeProject ? ` [${activeProject}]` : ''}${healthStr} --`,
      `Branch: ${branch}`,
      '', ...parts, '',
      '/cortex-search, /cortex-map, /cortex-deps for details',
      '---',
      '',
      '## Preloaded Tool Guidance',
      PRELOADED_TOOL_GUIDANCE,
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
