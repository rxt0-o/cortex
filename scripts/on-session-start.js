#!/usr/bin/env node
// SessionStart hook: inject context with ranked char-budget memory.

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { openDb } from './ensure-db.js';

const CHAR_BUDGET = 2500;
const COMPACT_CHAR_BUDGET = 1000;
const AUTO_BLOCK_CHAR_BUDGET = 400;

const PRELOADED_TOOL_GUIDANCE = `## Memory & Context Tools

Use these at session start or when resuming work.

- **cortex_context** -> session context (recent sessions, active TODOs, learnings, health, project map)
- **cortex_search** -> BM25/FTS5 search across sessions, decisions, errors, learnings, notes, todos
- **cortex_list** -> browse saved items by type (decisions/errors/learnings/todos/notes)

---

## Tracking & TODOs Tools

Use when noting unfinished work or setting reminders.

- **cortex_store(type:'todo', ...)** -> add unfinished items
- **cortex_store(type:'intent', ...)** -> save next-session intent
- **cortex_resolve(type:'todo', id)** -> mark todo resolved
- **cortex_snooze(description, until)** -> set reminder (3d/1w/ISO date).`;

const DYNAMIC_SECTION_ORDER = [
  'UNFINISHED',
  'KEY DECISIONS',
  'REMINDERS DUE',
  'ERRORS IN CHANGED FILES',
  'LOW CONFIDENCE LEARNINGS',
  'WEEKLY DIGEST',
];

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { session_id, cwd, source } = input;
  const isCompact = source === 'compact';
  const db = openDb(cwd);

  // Phase 4: Ebbinghaus Decay — absolute strength recalculation.
  // strength(t) = EXP(-t / half_life), half_life = 7 * (1 + 0.5 * access_count)
  // Immune: memory_strength IS NULL (pinned), core_memory=1, auto_block=1
  try {
    const decayTables = [
      { table: 'decisions', dateCol: 'created_at', extra: '' },
      { table: 'errors', dateCol: 'first_seen', extra: '' },
      { table: 'learnings', dateCol: 'created_at', extra: 'AND core_memory != 1 AND auto_block != 1' },
      { table: 'notes', dateCol: 'created_at', extra: '' },
      { table: 'unfinished', dateCol: 'created_at', extra: '' },
    ];

    // Round-robin: process max 3 tables per session-start if DB is large
    let roundRobinIdx = 0;
    try {
      roundRobinIdx = Number(db.prepare(`SELECT value FROM meta WHERE key='decay_round_robin'`).get()?.value) || 0;
    } catch { /* meta key doesn't exist yet */ }

    const totalActive = decayTables.reduce((sum, { table }) => {
      try {
        return sum + (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE archived_at IS NULL AND memory_strength IS NOT NULL AND memory_strength > 0.01`).get()?.c ?? 0);
      } catch { return sum; }
    }, 0);

    const maxTablesPerRun = totalActive > 1000 ? 3 : 5;

    for (let i = 0; i < Math.min(maxTablesPerRun, decayTables.length); i++) {
      const idx = (roundRobinIdx + i) % decayTables.length;
      const { table, dateCol, extra } = decayTables[idx];
      try {
        db.prepare(`
          UPDATE ${table} SET memory_strength = EXP(
            -CAST((julianday('now') - julianday(COALESCE(last_accessed, ${dateCol}))) AS REAL)
            / (7.0 * (1.0 + 0.5 * COALESCE(access_count, 0)))
          )
          WHERE memory_strength IS NOT NULL
            AND memory_strength > 0.01
            AND archived_at IS NULL
            ${extra}
        `).run();
      } catch { /* column missing on old DBs */ }
    }

    // Save round-robin state
    const nextIdx = (roundRobinIdx + Math.min(maxTablesPerRun, decayTables.length)) % decayTables.length;
    try {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('decay_round_robin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(nextIdx));
    } catch { /* non-critical */ }
  } catch {
    // Decay is non-critical — don't block session start.
  }

  let activeProject = '';
  try {
    activeProject = db.prepare(`SELECT value FROM meta WHERE key='active_project'`).get()?.value || '';
  } catch {
    // Optional.
  }

  if (isCompact) {
    try {
      const lines = [];
      const lastSession = db.prepare(`
        SELECT summary
        FROM sessions
        WHERE status = 'completed' AND summary IS NOT NULL
        ORDER BY started_at DESC LIMIT 1
      `).get();
      if (lastSession?.summary) {
        lines.push(`LAST SESSION: ${lastSession.summary}`);
      }

      const urgent = db.prepare(`
        SELECT description
        FROM unfinished
        WHERE resolved_at IS NULL AND priority='high'
        ORDER BY created_at DESC
        LIMIT 3
      `).all();
      if (urgent.length > 0) {
        lines.push('OPEN (high):');
        for (const row of urgent) lines.push(`  - ${row.description}`);
      }

      const rules = db.prepare(`
        SELECT anti_pattern, correct_pattern
        FROM learnings
        WHERE auto_block = 1 AND detection_regex IS NOT NULL
        ORDER BY occurrences DESC
        LIMIT 4
      `).all();
      if (rules.length > 0) {
        lines.push('AUTO-BLOCKED:');
        for (const row of rules) lines.push(`  X ${row.anti_pattern} -> ${row.correct_pattern}`);
      }

      const compactLines = trimLinesToBudget(lines, COMPACT_CHAR_BUDGET);
      const context = [
        `-- Cortex re-injected after compaction${activeProject ? ` [${activeProject}]` : ''} --`,
        ...compactLines,
        '---',
        '',
        '## Preloaded Tool Guidance',
        PRELOADED_TOOL_GUIDANCE,
      ].join('\n');

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      }));

      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(
        session_id,
        new Date().toISOString(),
        'active'
      );
    } finally {
      db.close();
    }
    return;
  }

  try {
    const parts = [];
    let branch = 'unknown';
    let changedFiles = [];

    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
      const status = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf-8' }).trim();
      if (status) changedFiles = status.split('\n').filter(Boolean);
    } catch {
      // Not a git repo.
    }

    let suggestedGoal = '';
    try {
      const intentRow = db.prepare(`SELECT value FROM meta WHERE key='last_intent_prediction'`).get();
      if (intentRow?.value) {
        const intent = JSON.parse(intentRow.value);
        if (intent.predicted_task && intent.confidence > 0.4) {
          const confidencePct = Math.round((intent.confidence ?? 0) * 100);
          suggestedGoal = `${intent.predicted_task} (${confidencePct}% match)`;
        }
      }
    } catch {
      // Optional.
    }

    if (!suggestedGoal) {
      const topItem = db.prepare(`
        SELECT description
        FROM unfinished
        WHERE resolved_at IS NULL AND context != 'intent'
        ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC
        LIMIT 1
      `).get();
      if (topItem?.description) suggestedGoal = topItem.description;
    }
    if (suggestedGoal) parts.push(`SUGGESTED GOAL: ${suggestedGoal}`);

    const lastSession = db.prepare(`
      SELECT started_at, summary
      FROM sessions
      WHERE status = 'completed' AND summary IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `).get();
    if (lastSession?.summary) {
      parts.push(`LAST SESSION: [${timeAgo(lastSession.started_at)}] ${lastSession.summary}`);
    }

    const scoredItems = [];
    addDynamicUnfinished(scoredItems, db);
    addDynamicDecisions(scoredItems, db);
    addDynamicReminders(scoredItems, db);
    addDynamicErrors(scoredItems, db, changedFiles);
    addDynamicLowConfidenceLearnings(scoredItems, db);
    addDynamicWeeklyDigest(scoredItems, db);

    const selected = selectScoredItems(scoredItems, CHAR_BUDGET);
    for (const section of DYNAMIC_SECTION_ORDER) {
      const lines = selected.sections.get(section) || [];
      if (lines.length === 0) continue;
      parts.push(section + ':');
      for (const line of lines) parts.push(`  - ${line}`);
    }

    if (selected.includedKinds.has('weekly_digest')) {
      try {
        db.prepare(`
          INSERT INTO meta (key, value)
          VALUES ('last_weekly_digest', datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run();
      } catch {
        // Non-critical.
      }
    }

    const autoRules = getAutoBlockedLines(db);
    const trimmedAutoRules = trimLinesToBudget(autoRules, AUTO_BLOCK_CHAR_BUDGET);
    parts.push('AUTO-BLOCKED PATTERNS:');
    if (trimmedAutoRules.length === 0) {
      parts.push('  - none configured');
    } else {
      for (const line of trimmedAutoRules) parts.push(`  - ${line}`);
      if (trimmedAutoRules.length < autoRules.length) {
        parts.push('  - ... truncated (use cortex_list(type:\'learnings\') for full list)');
      }
    }

    const health = db.prepare('SELECT score, trend FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
    if (health) {
      const trend = health.trend === 'up' ? '+' : health.trend === 'down' ? '-' : '=';
      parts.push(`HEALTH: ${health.score}/100 (${trend})`);
    }

    if (parts.length === 0) {
      db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(
        session_id,
        new Date().toISOString(),
        'active'
      );
      return;
    }

    const changedFilesLine = changedFiles.length === 0
      ? 'none'
      : changedFiles.slice(0, 5).join(', ');
    const context = [
      `-- Project Cortex${activeProject ? ` [${activeProject}]` : ''} --`,
      `Branch: ${branch}`,
      `Changed files: ${changedFilesLine}`,
      '',
      ...parts,
      '',
      '/cortex-search, /cortex-map, /cortex-deps for details',
      '---',
      '',
      '## Preloaded Tool Guidance',
      PRELOADED_TOOL_GUIDANCE,
    ].join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }));

    db.prepare('INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, ?)').run(
      session_id,
      new Date().toISOString(),
      'active'
    );
  } finally {
    db.close();
  }
}

function addDynamicUnfinished(scoredItems, db) {
  const rows = db.prepare(`
    SELECT id, description, priority, created_at, COALESCE(priority_score, 50) AS pscore
    FROM unfinished
    WHERE resolved_at IS NULL AND COALESCE(context, '') != 'intent'
    ORDER BY priority_score DESC
    LIMIT 15
  `).all();

  for (const row of rows) {
    const priorityWeight = row.priority === 'high' ? 3 : row.priority === 'medium' ? 1.5 : 1;
    const recency = recencyWeight(row.created_at);
    const access = 1 + Math.log2(Math.max(0, Number(row.pscore ?? 50)) / 50 + 1);
    scoredItems.push({
      section: 'UNFINISHED',
      line: `[${row.priority}] ${row.description}`,
      score: recency * access * priorityWeight,
      kind: 'unfinished',
    });
  }
}

function addDynamicDecisions(scoredItems, db) {
  const rows = db.prepare(`
    SELECT title, category, created_at, access_count
    FROM decisions
    WHERE archived_at IS NULL AND superseded_by IS NULL
    ORDER BY access_count DESC
    LIMIT 10
  `).all();

  for (const row of rows) {
    const recency = recencyWeight(row.created_at);
    const access = 1 + Math.log2((row.access_count || 0) + 1);
    scoredItems.push({
      section: 'KEY DECISIONS',
      line: `[${row.category}] ${row.title}`,
      score: recency * access,
      kind: 'decision',
    });
  }
}

function addDynamicReminders(scoredItems, db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, description, snooze_until
      FROM unfinished
      WHERE snooze_until IS NOT NULL
        AND snooze_until <= datetime('now')
        AND resolved_at IS NULL
      ORDER BY snooze_until ASC
      LIMIT 8
    `).all();
  } catch {
    rows = [];
  }

  for (const row of rows) {
    const recency = recencyWeight(row.snooze_until);
    scoredItems.push({
      section: 'REMINDERS DUE',
      line: `#${row.id}: ${row.description}`,
      score: recency * 1.5,
      kind: 'reminder',
    });
  }
}

function addDynamicErrors(scoredItems, db, changedFiles) {
  if (!changedFiles || changedFiles.length === 0) return;
  const seen = new Set();
  const stmt = db.prepare(`
    SELECT error_message, fix_description, last_seen, occurrences, access_count
    FROM errors
    WHERE files_involved LIKE ?
    ORDER BY occurrences DESC
    LIMIT 3
  `);

  for (const file of changedFiles.slice(0, 5)) {
    const rows = stmt.all(`%${file}%`);
    for (const row of rows) {
      const key = `${row.error_message}::${row.fix_description || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const recency = recencyWeight(row.last_seen);
      const access = 1 + Math.log2((row.access_count || row.occurrences || 0) + 1);
      const fix = row.fix_description ? ` Fix: ${row.fix_description}` : '';
      scoredItems.push({
        section: 'ERRORS IN CHANGED FILES',
        line: `${row.error_message}${fix}`,
        score: recency * access,
        kind: 'error',
      });
    }
  }
}

function addDynamicLowConfidenceLearnings(scoredItems, db) {
  const rows = db.prepare(`
    SELECT id, anti_pattern, confidence, created_at, access_count
    FROM learnings
    WHERE confidence <= 0.4
      AND core_memory != 1
      AND archived_at IS NULL
    ORDER BY confidence ASC
    LIMIT 4
  `).all();

  for (const row of rows) {
    const recency = recencyWeight(row.created_at);
    const access = 1 + Math.log2((row.access_count || 0) + 1);
    const confidence = Number(row.confidence || 0);
    const confidenceBoost = 1 + (0.5 - Math.max(0, confidence));
    scoredItems.push({
      section: 'LOW CONFIDENCE LEARNINGS',
      line: `#${row.id} (${Math.round(confidence * 100)}%): ${row.anti_pattern}`,
      score: recency * access * confidenceBoost,
      kind: 'learning',
    });
  }
}

function addDynamicWeeklyDigest(scoredItems, db) {
  try {
    const lastDigest = db.prepare(`SELECT value FROM meta WHERE key='last_weekly_digest'`).get()?.value;
    const daysSince = lastDigest ? (Date.now() - new Date(lastDigest).getTime()) / 86400000 : 999;
    const due = new Date().getDay() === 1 || daysSince >= 7;
    if (!due) return;

    const s7 = db.prepare(`
      SELECT COUNT(*) AS c
      FROM sessions
      WHERE started_at > datetime('now','-7 days') AND status='completed'
    `).get()?.c || 0;
    const f7 = db.prepare(`
      SELECT COUNT(DISTINCT file_path) AS c
      FROM diffs
      WHERE created_at > datetime('now','-7 days')
    `).get()?.c || 0;
    const fix7 = db.prepare(`
      SELECT COUNT(*) AS c
      FROM errors
      WHERE fix_description IS NOT NULL
        AND session_id IN (
          SELECT id FROM sessions WHERE started_at > datetime('now','-7 days')
        )
    `).get()?.c || 0;
    const criticalOpen = db.prepare(`
      SELECT COUNT(*) AS c
      FROM errors
      WHERE fix_description IS NULL AND severity='critical' AND archived != 1
    `).get()?.c || 0;

    const criticalSuffix = criticalOpen > 0 ? ` | ${criticalOpen} critical open` : '';
    scoredItems.push({
      section: 'WEEKLY DIGEST',
      line: `${s7} sessions | ${f7} files | ${fix7} bugs fixed${criticalSuffix}`,
      score: 0.8,
      kind: 'weekly_digest',
    });
  } catch {
    // Optional.
  }
}

function getAutoBlockedLines(db) {
  const lines = [];
  const regexRows = db.prepare(`
    SELECT anti_pattern, correct_pattern
    FROM learnings
    WHERE auto_block = 1 AND detection_regex IS NOT NULL
    ORDER BY occurrences DESC
    LIMIT 6
  `).all();
  const manualRows = db.prepare(`
    SELECT anti_pattern
    FROM learnings
    WHERE auto_block = 1 AND detection_regex IS NULL
    ORDER BY occurrences DESC
    LIMIT 3
  `).all();

  for (const row of regexRows) lines.push(`X ${row.anti_pattern} -> ${row.correct_pattern}`);
  for (const row of manualRows) lines.push(`! ${row.anti_pattern}`);
  return lines;
}

function selectScoredItems(scoredItems, budget) {
  const sections = new Map();
  const includedKinds = new Set();
  let usedChars = 0;
  const sorted = [...scoredItems].sort((a, b) => b.score - a.score);

  for (const item of sorted) {
    const line = String(item.line || '').trim();
    if (!line) continue;
    const cost = line.length + 4;
    if (usedChars + cost > budget) continue;
    if (!sections.has(item.section)) sections.set(item.section, []);
    sections.get(item.section).push(line);
    usedChars += cost;
    if (item.kind) includedKinds.add(item.kind);
  }

  return { sections, includedKinds };
}

function trimLinesToBudget(lines, budget) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const cost = String(line).length + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return out;
}

function recencyWeight(isoDate) {
  if (!isoDate) return 1;
  const ts = new Date(isoDate).getTime();
  if (Number.isNaN(ts)) return 1;
  const ageInDays = Math.max(0, (Date.now() - ts) / 86400000);
  return 1 / (1 + ageInDays * 0.1);
}

function timeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

try {
  main();
} catch (err) {
  process.stderr.write(`Cortex SessionStart error: ${err.message}\n`);
  process.exit(0);
}
