import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb, closeDb } from './db.js';
import * as sessions from './modules/sessions.js';
import * as decisions from './modules/decisions.js';
import * as errors from './modules/errors.js';
import * as learnings from './modules/learnings.js';
import * as unfinished from './modules/unfinished.js';
import * as projectMap from './modules/project-map.js';
import * as deps from './modules/dependencies.js';
import * as diffs from './modules/diffs.js';
import * as conventions from './modules/conventions.js';
import * as health from './modules/health.js';

const server = new McpServer({
  name: 'project-cortex',
  version: '0.1.0',
});

// ═══════════════════════════════════════════════════
// SESSION TOOLS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_save_session',
  'Save or update a session with summary, changes, decisions, errors, and learnings',
  {
    session_id: z.string(),
    summary: z.string().optional(),
    key_changes: z.array(z.object({
      file: z.string(),
      action: z.string(),
      description: z.string(),
    })).optional(),
    status: z.enum(['active', 'completed', 'abandoned']).optional(),
  },
  async ({ session_id, summary, key_changes, status }) => {
    getDb();
    sessions.createSession({ id: session_id });
    const session = sessions.updateSession(session_id, {
      summary,
      key_changes: key_changes as sessions.KeyChange[],
      status,
      ended_at: status === 'completed' ? new Date().toISOString() : undefined,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }] };
  }
);

server.tool(
  'cortex_list_sessions',
  'List recent sessions with summaries',
  {
    limit: z.number().optional(),
    chain_id: z.string().optional(),
    tag: z.string().optional(),
  },
  async ({ limit, chain_id, tag }) => {
    getDb();
    let result = sessions.listSessions(limit ?? 20, chain_id);
    if (tag) {
      result = result.filter(s => s.tags?.includes(tag));
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_search',
  'Full-text search across all Cortex data: sessions, decisions, errors, learnings',
  {
    query: z.string(),
    limit: z.number().optional(),
  },
  async ({ query, limit }) => {
  const db = getDb();
  const maxResults = limit ?? 10;
  const lines: string[] = [];

  const sessionResults = sessions.searchSessions(query, maxResults);
  for (const s of sessionResults) lines.push(`[SESSION] ${(s as any).summary ?? (s as any).id}`);

  const decisionResults = decisions.searchDecisions(query, maxResults);
  for (const d of decisionResults) lines.push(`[DECISION] ${(d as any).title}`);

  const errorResults = errors.searchErrors(query, maxResults);
  for (const e of errorResults) lines.push(`[ERROR] ${(e as any).error_message}`);

  const learningResults = learnings.searchLearnings(query, maxResults);
  for (const l of learningResults) lines.push(`[LEARNING] ${(l as any).anti_pattern}`);

  try {
    const noteResults = db.prepare(`SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${query}%`, maxResults) as any[];
    for (const n of noteResults) lines.push(`[NOTE] ${n.text.slice(0, 120)}`);
  } catch {}

  try {
    const unfinishedResults = db.prepare(`SELECT * FROM unfinished WHERE description LIKE ? AND resolved_at IS NULL LIMIT ?`).all(`%${query}%`, maxResults) as any[];
    for (const u of unfinishedResults) lines.push(`[TODO] ${u.description}`);
  } catch {}

  return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No results.' }] };
  }
);

// ═══════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_context',
  'Get relevant context for specific files or the current work',
  {
    files: z.array(z.string()).optional(),
  },
  async ({ files }) => {
    getDb();
    const context: Record<string, unknown> = {};

    // Recent sessions
    context.recentSessions = sessions.getRecentSummaries(3);

    // Unfinished business
    context.unfinished = unfinished.listUnfinished({ limit: 10 });

    // Errors for specified files
    if (files && files.length > 0) {
      context.fileErrors = errors.getErrorsForFiles(files);
    }

    // Active learnings
    context.activeLearnings = learnings.listLearnings({ autoBlockOnly: true });

    // Health
    context.health = health.getLatestSnapshot();

    // Project map summary
    context.projectMap = projectMap.getModuleSummary();

    return { content: [{ type: 'text' as const, text: JSON.stringify(context, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// DECISIONS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_add_decision',
  'Log an architectural or design decision with reasoning',
  {
    title: z.string(),
    reasoning: z.string(),
    category: z.enum(['architecture', 'convention', 'bugfix', 'feature', 'config', 'security']),
    files_affected: z.array(z.string()).optional(),
    alternatives: z.array(z.object({
      option: z.string(),
      reason_rejected: z.string(),
    })).optional(),
    session_id: z.string().optional(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
  },
  async (input) => {
    getDb();
    const decision = decisions.addDecision(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(decision, null, 2) }] };
  }
);

server.tool(
  'cortex_list_decisions',
  'List architectural decisions, optionally filtered by category',
  {
    category: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ category, limit }) => {
    getDb();
    const result = decisions.listDecisions({ category, limit });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'cortex_mark_decision_reviewed',
  'Mark a decision as reviewed / still current (resets stale flag)',
  { id: z.number() },
  async ({ id }) => {
    getDb().prepare(`UPDATE decisions SET stale=0, reviewed_at=datetime('now') WHERE id=?`).run(id);
    return { content: [{ type: 'text' as const, text: `Decision ${id} marked as reviewed.` }] };
  }
);

// ═══════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_add_error',
  'Record an error with optional root cause, fix, and prevention rule',
  {
    error_message: z.string(),
    root_cause: z.string().optional(),
    fix_description: z.string().optional(),
    fix_diff: z.string().optional(),
    files_involved: z.array(z.string()).optional(),
    prevention_rule: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    session_id: z.string().optional(),
  },
  async (input) => {
    getDb();
    const error = errors.addError(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }] };
  }
);

server.tool(
  'cortex_list_errors',
  'List known errors, optionally filtered by severity or file',
  {
    severity: z.string().optional(),
    file: z.string().optional(),
    limit: z.number().optional(),
  },
  async (input) => {
    getDb();
    const result = errors.listErrors(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// LEARNINGS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_add_learning',
  'Record an anti-pattern and its correct alternative, optionally with auto-blocking regex',
  {
    anti_pattern: z.string(),
    correct_pattern: z.string(),
    context: z.string(),
    detection_regex: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    auto_block: z.boolean().optional(),
    session_id: z.string().optional(),
  },
  async (input) => {
    getDb();
    const learning = learnings.addLearning(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(learning, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// DEPENDENCIES
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_deps',
  'Get dependency tree and impact analysis for a file',
  {
    file_path: z.string(),
  },
  async ({ file_path }) => {
    getDb();
    const imports = deps.getImports(file_path);
    const importers = deps.getImporters(file_path);
    const impact = deps.getImpactTree(file_path);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ imports, importers, impactedFiles: impact }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════
// PROJECT MAP
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_map',
  'Get project architecture map — modules, layers, files',
  {
    module: z.string().optional(),
  },
  async ({ module }) => {
    getDb();
    if (module) {
      const mod = projectMap.getModuleByPath(module);
      return { content: [{ type: 'text' as const, text: JSON.stringify(mod, null, 2) }] };
    }
    const summary = projectMap.getModuleSummary();
    return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  'cortex_update_map',
  'Re-scan the project and update the architecture map',
  { root_path: z.string().optional() },
  async ({ root_path }) => {
    getDb();
    const result = projectMap.scanProject(root_path ?? process.cwd());
    return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
  }
);

server.tool(
  'cortex_scan_project',
  'Scan project filesystem and populate architecture map with all files, modules and dependencies',
  { root_path: z.string().optional() },
  async ({ root_path }) => {
    getDb();
    const result = projectMap.scanProject(root_path ?? process.cwd());
    return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// INDEX DOCS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_index_docs',
  'Read CLAUDE.md and docs/ markdown files and store as searchable learnings and decisions',
  { docs_path: z.string().optional() },
  async ({ docs_path }) => {
    getDb();
    const { readFileSync, readdirSync, existsSync } = await import('fs');
    const { join } = await import('path');

    const root = docs_path ?? process.cwd();
    const stats = { gotchas: 0, decisions: 0, docs_indexed: 0 };

    // CLAUDE.md Gotchas parsen: - **#NNN ...** — Beschreibung
    const claudeMdPath = join(root, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8');
      const gotchaRe = /- \*\*#(\d+)[^*]*\*\*\s*[—-]\s*([^\n]+)/g;
      let m;
      while ((m = gotchaRe.exec(content))) {
        const num = m[1];
        const title = m[2].trim();
        try {
          learnings.addLearning({
            anti_pattern: `Gotcha #${num}: ${title}`,
            correct_pattern: title,
            context: `CLAUDE.md Gotcha #${num}`,
            severity: 'medium',
            auto_block: false,
          });
          stats.gotchas++;
        } catch { /* Duplikat — ignorieren */ }
      }
      stats.docs_indexed++;
    }

    // docs/*.md H2-Sections als Decisions
    const docsDir = join(root, 'docs');
    if (existsSync(docsDir)) {
      const mdFiles = readdirSync(docsDir).filter((f: string) => f.endsWith('.md'));
      for (const file of mdFiles) {
        try {
          const content = readFileSync(join(docsDir, file), 'utf-8');
          const sectionRe = /^## (.+)\n([\s\S]*?)(?=\n## |$)/gm;
          let sm;
          while ((sm = sectionRe.exec(content))) {
            const title = sm[1].trim();
            const body = sm[2].trim();
            if (body.length < 30) continue;
            try {
              decisions.addDecision({
                title: `[${file}] ${title}`,
                reasoning: body.slice(0, 1000),
                category: 'architecture',
                confidence: 'high',
              });
              stats.decisions++;
            } catch { /* Duplikat */ }
          }
          stats.docs_indexed++;
        } catch { /* nicht lesbar */ }
      }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...stats }, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// HOT ZONES
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_hot_zones',
  'Get most frequently changed files — refactoring candidates',
  {
    limit: z.number().optional(),
  },
  async ({ limit }) => {
    getDb();
    const zones = projectMap.getHotZones(limit ?? 20);
    return { content: [{ type: 'text' as const, text: JSON.stringify(zones, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// FILE HISTORY
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_file_history',
  'Get complete history for a file: sessions, diffs, errors',
  {
    file_path: z.string(),
  },
  async ({ file_path }) => {
    getDb();
    const fileDiffs = diffs.getDiffsForFile(file_path);
    const fileErrors = errors.listErrors({ file: file_path });
    const fileDecisions = decisions.getDecisionsForFile(file_path);
    const fileInfo = projectMap.getFileByPath(file_path);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ file: fileInfo, diffs: fileDiffs, errors: fileErrors, decisions: fileDecisions }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_health',
  'Get project health score with metrics and trend',
  {},
  async () => {
    getDb();
    const snapshot = health.getLatestSnapshot();
    const history = health.getHealthHistory(7);
    const metrics = health.calculateHealth();
    const score = health.computeScore(metrics);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ currentScore: score, metrics, latestSnapshot: snapshot, recentHistory: history }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════
// UNFINISHED
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_unfinished',
  'Get open/unresolved items — things that were started but not completed',
  {},
  async () => {
    getDb();
    const items = unfinished.listUnfinished();
    return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
  }
);

server.tool(
  'cortex_add_unfinished',
  'Track something that needs to be done later',
  {
    description: z.string(),
    context: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    session_id: z.string().optional(),
  },
  async (input) => {
    getDb();
    const item = unfinished.addUnfinished(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// CONVENTIONS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_conventions',
  'List active conventions with violation counts',
  {
    scope: z.string().optional(),
  },
  async ({ scope }) => {
    getDb();
    const convs = conventions.listConventions(scope);
    return { content: [{ type: 'text' as const, text: JSON.stringify(convs, null, 2) }] };
  }
);

server.tool(
  'cortex_add_convention',
  'Add or update a coding convention with detection/violation patterns',
  {
    name: z.string(),
    description: z.string(),
    detection_pattern: z.string().optional(),
    violation_pattern: z.string().optional(),
    examples_good: z.array(z.string()).optional(),
    examples_bad: z.array(z.string()).optional(),
    scope: z.enum(['global', 'frontend', 'backend', 'database']).optional(),
    source: z.string().optional(),
  },
  async (input) => {
    getDb();
    const conv = conventions.addConvention(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(conv, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════
// REGRESSION CHECK
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_check_regression',
  'Check if content would introduce a known regression or anti-pattern',
  {
    file_path: z.string(),
    content: z.string(),
  },
  async ({ file_path, content }) => {
    getDb();
    const warnings: Array<{ type: string; message: string; severity: string }> = [];

    // Check against learnings
    const learningMatches = learnings.checkContentAgainstLearnings(content);
    for (const m of learningMatches) {
      warnings.push({
        type: 'anti-pattern',
        message: `Anti-pattern: "${m.learning.anti_pattern}" → Use: "${m.learning.correct_pattern}"`,
        severity: m.learning.severity,
      });
    }

    // Check against conventions
    const conventionMatches = conventions.checkContentAgainstConventions(content);
    for (const m of conventionMatches) {
      warnings.push({
        type: 'convention-violation',
        message: `Convention "${m.convention.name}": ${m.convention.description}`,
        severity: 'warning',
      });
    }

    // Check against error prevention rules
    const preventionRules = errors.getPreventionRules();
    for (const rule of preventionRules) {
      try {
        if (new RegExp(rule.prevention_rule, 'm').test(content)) {
          warnings.push({
            type: 'regression',
            message: `This pattern caused Error #${rule.id}: "${rule.error_message}"`,
            severity: 'error',
          });
        }
      } catch {
        // Invalid regex
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: warnings.length > 0
          ? JSON.stringify({ blocked: warnings.some(w => w.severity === 'error'), warnings }, null, 2)
          : '{"blocked": false, "warnings": []}',
      }],
    };
  }
);

// ═══════════════════════════════════════════════════
// CLAUDE.MD SUGGESTIONS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_suggest_claude_md',
  'Suggest CLAUDE.md updates based on new learnings and patterns',
  {},
  async () => {
    getDb();
    const recentLearnings = learnings.listLearnings({ limit: 10 });
    const topConventions = conventions.listConventions();
    const frequentErrors = errors.listErrors({ limit: 5 });

    const suggestions: string[] = [];

    for (const learning of recentLearnings) {
      if (learning.occurrences >= 2) {
        suggestions.push(`New Gotcha: ${learning.anti_pattern} → ${learning.correct_pattern} (occurred ${learning.occurrences}x)`);
      }
    }

    for (const conv of topConventions) {
      if (conv.violation_count >= 3 && conv.source !== 'claude-md') {
        suggestions.push(`Convention to add: ${conv.name} — ${conv.description} (${conv.violation_count} violations)`);
      }
    }

    for (const error of frequentErrors) {
      if (error.occurrences >= 3 && error.prevention_rule) {
        suggestions.push(`Error pattern to document: ${error.error_message} (${error.occurrences}x)`);
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: suggestions.length > 0
          ? JSON.stringify({ suggestions }, null, 2)
          : '{"suggestions": [], "message": "No new suggestions — CLAUDE.md is up to date."}',
      }],
    };
  }
);

// ═══════════════════════════════════════════════════
// RESOLVE UNFINISHED / LIST LEARNINGS / STATS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_resolve_unfinished',
  'Mark an unfinished item as resolved/done',
  { id: z.number(), session_id: z.string().optional() },
  async ({ id, session_id }) => {
    getDb();
    const item = unfinished.resolveUnfinished(id, session_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: !!item, item }, null, 2) }],
    };
  }
);

server.tool(
  'cortex_update_learning',
  'Update an existing learning/anti-pattern entry (e.g. add detection_regex, change severity, toggle auto_block)',
  {
    id: z.number(),
    anti_pattern: z.string().optional(),
    correct_pattern: z.string().optional(),
    detection_regex: z.string().nullable().optional(),
    context: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    auto_block: z.boolean().optional(),
  },
  async (input) => {
    getDb();
    const learning = learnings.updateLearning(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(learning, null, 2) }] };
  }
);

server.tool(
  'cortex_delete_learning',
  'Delete a learning/anti-pattern entry by ID',
  { id: z.number() },
  async ({ id }) => {
    getDb();
    const success = learnings.deleteLearning(id);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ success, deleted_id: id }, null, 2) }] };
  }
);

server.tool(
  'cortex_update_error',
  'Update an existing error record — add fix description, prevention rule, or change severity',
  {
    id: z.number(),
    fix_description: z.string().optional(),
    root_cause: z.string().optional(),
    fix_diff: z.string().optional(),
    prevention_rule: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  },
  async (input) => {
    getDb();
    const error = errors.updateError(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }] };
  }
);

server.tool(
  'cortex_list_learnings',
  'List recorded anti-patterns and learnings',
  { auto_block_only: z.boolean().optional(), limit: z.number().optional() },
  async ({ auto_block_only, limit }) => {
    getDb();
    const result = learnings.listLearnings({ autoBlockOnly: auto_block_only, limit: limit ?? 50 });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'cortex_get_stats',
  'Get overall project statistics: sessions, decisions, errors, files, learnings',
  {},
  async () => {
    const db = getDb();
    const q = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    const stats = {
      sessions: q('SELECT COUNT(*) as c FROM sessions'),
      decisions: q('SELECT COUNT(*) as c FROM decisions'),
      errors: q('SELECT COUNT(*) as c FROM errors'),
      learnings: q('SELECT COUNT(*) as c FROM learnings'),
      conventions: q('SELECT COUNT(*) as c FROM conventions'),
      files_tracked: q('SELECT COUNT(*) as c FROM project_files'),
      modules: q('SELECT COUNT(*) as c FROM project_modules'),
      dependencies: q('SELECT COUNT(*) as c FROM dependencies'),
      unfinished_open: q('SELECT COUNT(*) as c FROM unfinished WHERE resolved_at IS NULL'),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
  }
);

server.tool(
  'cortex_import_git_history',
  'Import git log history to populate Hot Zones with historical file change frequency',
  {
    root_path: z.string().optional(),
    max_commits: z.number().optional(),
  },
  async ({ root_path, max_commits }) => {
    const { execFileSync } = await import('child_process');
    const cwd = root_path ?? process.cwd();
    const limit = max_commits ?? 500;

    let gitOutput: string;
    try {
      gitOutput = execFileSync(
        'git', ['log', `--max-count=${limit}`, '--name-only', '--pretty=format:'],
        { cwd, encoding: 'utf-8' }
      );
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'git log failed', detail: String(e) }) }] };
    }

    const db = getDb();
    const fileCounts = new Map<string, number>();
    for (const line of gitOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!/\.(ts|tsx|js|jsx|py|sql|json|md)$/.test(trimmed)) continue;
      fileCounts.set(trimmed, (fileCounts.get(trimmed) ?? 0) + 1);
    }

    const stmt = db.prepare(`
      INSERT INTO project_files (path, change_count, last_changed)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        change_count = MAX(project_files.change_count, excluded.change_count)
    `);
    let imported = 0;
    for (const [path, count] of fileCounts) { stmt.run(path, count); imported++; }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, files_imported: imported, commits_analyzed: limit }, null, 2) }],
    };
  }
);

server.tool('cortex_snooze', 'Schedule a future session reminder', {
  description: z.string(),
  until: z.string().describe('Relative 3d/1w or ISO date 2026-03-01'),
  session_id: z.string().optional(),
}, async ({ description, until, session_id }) => {
  let d = new Date();
  if (/^\d+d$/i.test(until)) d.setDate(d.getDate() + parseInt(until));
  else if (/^\d+w$/i.test(until)) d.setDate(d.getDate() + parseInt(until) * 7);
  else d = new Date(until);
  getDb().prepare(`INSERT INTO unfinished (description,context,priority,session_id,snooze_until) VALUES (?,?,?,?,?)`).run(description, 'snoozed', 'medium', session_id??null, d.toISOString());
  return { content: [{ type: 'text' as const, text: `Reminder set for ${d.toISOString().slice(0,10)}` }] };
});

// ═══════════════════════════════════════════════════
// NOTES (SCRATCH PAD)
// ═══════════════════════════════════════════════════

server.tool('cortex_add_note', 'Add scratch pad note', {
  text: z.string(),
  tags: z.array(z.string()).optional(),
  session_id: z.string().optional(),
}, async ({ text, tags, session_id }) => {
  const r = getDb().prepare(`INSERT INTO notes (text,tags,session_id) VALUES (?,?,?)`).run(text, tags ? JSON.stringify(tags) : null, session_id ?? null);
  return { content: [{ type: 'text' as const, text: `Note saved (id: ${r.lastInsertRowid})` }] };
});

server.tool('cortex_list_notes', 'List notes, optionally filtered by search term', {
  limit: z.number().optional().default(20),
  search: z.string().optional(),
}, async ({ limit, search }) => {
  const db = getDb();
  const notes = search
    ? db.prepare(`SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${search}%`, limit)
    : db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT ?`).all(limit);
  return { content: [{ type: 'text' as const, text: (notes as any[]).map(n => `[${n.id}] ${n.created_at.slice(0,10)}: ${n.text}`).join('\n') || 'No notes.' }] };
});

server.tool('cortex_delete_note', 'Delete note by id', {
  id: z.number(),
}, async ({ id }) => {
  getDb().prepare(`DELETE FROM notes WHERE id=?`).run(id);
  return { content: [{ type: 'text' as const, text: `Deleted note ${id}` }] };
});


// ═══════════════════════════════════════════════════
// BLAME + TIME MACHINE + TIMELINE + FORGET + DEJA-VU
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_blame',
  'Show full history for a file: diffs, errors, decisions',
  { file_path: z.string() },
  async ({ file_path }) => {
    const db = getDb();
    const lines: string[] = [`=== History for ${file_path} ===`];

    try {
      const fileDiffs = db.prepare(`SELECT d.created_at, d.change_type, s.summary FROM diffs d LEFT JOIN sessions s ON s.id=d.session_id WHERE d.file_path LIKE ? ORDER BY d.created_at DESC LIMIT 10`).all(`%${file_path}%`) as any[];
      if (fileDiffs.length > 0) {
        lines.push('DIFFS:');
        for (const d of fileDiffs) lines.push(`  [${d.created_at?.slice(0,10)}] ${d.change_type ?? 'modified'} — ${d.summary ?? ''}`);
      }
    } catch {}

    try {
      const fileErrors = db.prepare(`SELECT error_message, fix_description, severity FROM errors WHERE files_involved LIKE ? ORDER BY last_seen DESC LIMIT 5`).all(`%${file_path}%`) as any[];
      if (fileErrors.length > 0) {
        lines.push('ERRORS:');
        for (const e of fileErrors) lines.push(`  [${e.severity}] ${e.error_message}${e.fix_description ? ' → ' + e.fix_description : ''}`);
      }
    } catch {}

    try {
      const fileDecisions = db.prepare(`SELECT title, category, created_at FROM decisions WHERE files_affected LIKE ? ORDER BY created_at DESC LIMIT 5`).all(`%${file_path}%`) as any[];
      if (fileDecisions.length > 0) {
        lines.push('DECISIONS:');
        for (const d of fileDecisions) lines.push(`  [${d.category}] ${d.title}`);
      }
    } catch {}

    return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No history found.' }] };
  }
);

server.tool(
  'cortex_compare_periods',
  'Compare activity between two date ranges',
  {
    from_a: z.string().describe('Start of period A (YYYY-MM-DD)'),
    to_a: z.string().describe('End of period A (YYYY-MM-DD)'),
    from_b: z.string().describe('Start of period B (YYYY-MM-DD)'),
    to_b: z.string().describe('End of period B (YYYY-MM-DD)'),
  },
  async ({ from_a, to_a, from_b, to_b }) => {
    const db = getDb();
    const count = (sql: string, ...p: string[]) => {
      try { return (db.prepare(sql).get(...p) as any)?.c ?? 0; } catch { return 0; }
    };
    const periodA = {
      sessions: count(`SELECT COUNT(*) as c FROM sessions WHERE started_at BETWEEN ? AND ?`, from_a, to_a),
      errors: count(`SELECT COUNT(*) as c FROM errors WHERE first_seen BETWEEN ? AND ?`, from_a, to_a),
      fixes: count(`SELECT COUNT(*) as c FROM errors WHERE fix_description IS NOT NULL AND last_seen BETWEEN ? AND ?`, from_a, to_a),
      files: count(`SELECT COUNT(DISTINCT file_path) as c FROM diffs WHERE created_at BETWEEN ? AND ?`, from_a, to_a),
    };
    const periodB = {
      sessions: count(`SELECT COUNT(*) as c FROM sessions WHERE started_at BETWEEN ? AND ?`, from_b, to_b),
      errors: count(`SELECT COUNT(*) as c FROM errors WHERE first_seen BETWEEN ? AND ?`, from_b, to_b),
      fixes: count(`SELECT COUNT(*) as c FROM errors WHERE fix_description IS NOT NULL AND last_seen BETWEEN ? AND ?`, from_b, to_b),
      files: count(`SELECT COUNT(DISTINCT file_path) as c FROM diffs WHERE created_at BETWEEN ? AND ?`, from_b, to_b),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ periodA: { range: `${from_a} to ${to_a}`, ...periodA }, periodB: { range: `${from_b} to ${to_b}`, ...periodB } }, null, 2) }] };
  }
);

server.tool(
  'cortex_get_timeline',
  'Get monthly activity timeline',
  { limit: z.number().optional().default(12) },
  async ({ limit }) => {
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', started_at) as month, COUNT(*) as sessions,
               GROUP_CONCAT(SUBSTR(summary, 1, 60), ' | ') as summaries
        FROM sessions WHERE summary IS NOT NULL
        GROUP BY month ORDER BY month DESC LIMIT ?
      `).all(limit) as any[];
      const lines = rows.map(r => `[${r.month}] ${r.sessions} sessions — ${r.summaries?.slice(0, 200) ?? ''}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No timeline data.' }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
    }
  }
);

server.tool(
  'cortex_forget',
  'Archive (soft-delete) decisions, errors, and learnings matching a topic',
  { topic: z.string().describe('Keyword or phrase to match against') },
  async ({ topic }) => {
    const db = getDb();
    const pat = `%${topic}%`;
    let archived = 0;
    try { const r = db.prepare(`UPDATE decisions SET archived=1 WHERE (title LIKE ? OR reasoning LIKE ?) AND archived!=1`).run(pat, pat); archived += Number(r.changes); } catch {}
    try { const r = db.prepare(`UPDATE errors SET archived=1 WHERE (error_message LIKE ? OR root_cause LIKE ?) AND archived!=1`).run(pat, pat); archived += Number(r.changes); } catch {}
    try { const r = db.prepare(`UPDATE learnings SET archived=1 WHERE (anti_pattern LIKE ? OR context LIKE ?) AND archived!=1`).run(pat, pat); archived += Number(r.changes); } catch {}
    return { content: [{ type: 'text' as const, text: `Archived ${archived} item(s) matching "${topic}".` }] };
  }
);

server.tool(
  'cortex_dejavu',
  'Check if a task looks similar to past sessions (deja-vu detection)',
  { task_description: z.string() },
  async ({ task_description }) => {
    const db = getDb();
    // Extract keywords (words > 4 chars)
    const keywords = task_description.split(/\s+/).filter(w => w.length > 4).slice(0, 8);
    if (keywords.length === 0) return { content: [{ type: 'text' as const, text: 'No keywords to match.' }] };
    const lines: string[] = [];
    for (const kw of keywords) {
      try {
        const matches = db.prepare(`SELECT started_at, summary FROM sessions WHERE summary LIKE ? AND status='completed' ORDER BY started_at DESC LIMIT 2`).all(`%${kw}%`) as any[];
        for (const m of matches) lines.push(`[${m.started_at?.slice(0,10)}] ${m.summary}`);
      } catch {}
    }
    const unique = [...new Set(lines)].slice(0, 10);
    return { content: [{ type: 'text' as const, text: unique.length > 0 ? `Deja-vu matches:\n${unique.join('\n')}` : 'No similar sessions found.' }] };
  }
);


// ═══════════════════════════════════════════════════
// BLIND SPOTS + INTENT MEMORY
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_check_blind_spots',
  'Find project files not touched in recent sessions — potential blind spots',
  { days: z.number().optional().default(14), limit: z.number().optional().default(10) },
  async ({ days, limit }) => {
    const db = getDb();
    try {
      const untouched = db.prepare(`
        SELECT path, change_count, last_changed FROM project_files
        WHERE (last_changed IS NULL OR last_changed < datetime('now', ? || ' days'))
          AND change_count > 0
        ORDER BY change_count DESC LIMIT ?
      `).all(`-${days}`, limit) as any[];

      if (untouched.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No blind spots detected — all active files touched recently.' }] };
      }

      const lines = [`Blind spots (not touched in ${days}d):`];
      for (const f of untouched) {
        lines.push(`  ${f.path} (${f.change_count} total changes, last: ${f.last_changed?.slice(0,10) ?? 'never'})`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
    }
  }
);

server.tool(
  'cortex_add_intent',
  'Store a stated intention for follow-up in future sessions',
  {
    intent: z.string().describe('What you plan to do next'),
    session_id: z.string().optional(),
  },
  async ({ intent, session_id }) => {
    const db = getDb();
    // Store as unfinished with context 'intent'
    const ts = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, 'active')`).run(session_id ?? `intent-${ts}`, ts);
    db.prepare(`INSERT INTO unfinished (session_id, created_at, description, context, priority) VALUES (?, ?, ?, 'intent', 'medium')`).run(
      session_id ?? null, ts, `[INTENT] ${intent}`
    );
    return { content: [{ type: 'text' as const, text: `Intent stored: "${intent}"` }] };
  }
);


// ═══════════════════════════════════════════════════
// BRAIN SNAPSHOT
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_snapshot',
  'Get a concise brain snapshot — top state, intents, mood, drift, anchors',
  {},
  async () => {
    const db = getDb();
    const md: string[] = [`# Brain Snapshot — ${new Date().toISOString().slice(0,16).replace('T', ' ')}`, ''];

    // Mood
    try {
      const moodSessions = db.prepare(`SELECT mood_score FROM sessions WHERE mood_score IS NOT NULL ORDER BY started_at DESC LIMIT 7`).all() as any[];
      if (moodSessions.length > 0) {
        const avg = moodSessions.reduce((s: number, r: any) => s + r.mood_score, 0) / moodSessions.length;
        md.push(`**Mood:** ${avg >= 4 ? 'positive' : avg >= 3 ? 'neutral' : 'negative'} (${avg.toFixed(1)}/5)`);
      }
    } catch {}

    // Open items
    try {
      const open = db.prepare(`SELECT description, priority FROM unfinished WHERE resolved_at IS NULL ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 5`).all() as any[];
      if (open.length > 0) {
        md.push('');
        md.push(`## Open Items (${open.length})`);
        for (const u of open) md.push(`- [${u.priority}] ${u.description}`);
      }
    } catch {}

    // Active intents
    try {
      const intents = db.prepare(`SELECT description FROM unfinished WHERE context='intent' AND resolved_at IS NULL LIMIT 3`).all() as any[];
      if (intents.length > 0) {
        md.push('');
        md.push('## Intents');
        for (const i of intents) md.push(`- ${i.description.replace('[INTENT] ', '')}`);
      }
    } catch {}

    // Attention anchors
    try {
      const anchors = db.prepare(`SELECT topic, priority FROM attention_anchors ORDER BY priority DESC LIMIT 5`).all() as any[];
      if (anchors.length > 0) {
        md.push('');
        md.push('## Attention Anchors');
        for (const a of anchors) md.push(`- ${a.topic} (p${a.priority})`);
      }
    } catch {}

    // Drift items
    try {
      const drift = db.prepare(`SELECT description FROM unfinished WHERE description LIKE '[DRIFT]%' AND resolved_at IS NULL LIMIT 3`).all() as any[];
      if (drift.length > 0) {
        md.push('');
        md.push('## Drift Warnings');
        for (const d of drift) md.push(`- ${d.description}`);
      }
    } catch {}

    // Stale decisions
    try {
      const stale = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE stale=1`).get() as any;
      if (stale?.c > 0) {
        md.push('');
        md.push(`## Stale Decisions: ${stale.c} (>90 days old — review needed)`);
      }
    } catch {}

    // Last 3 sessions
    try {
      const recent = db.prepare(`SELECT started_at, summary FROM sessions WHERE status='completed' AND summary IS NOT NULL ORDER BY started_at DESC LIMIT 3`).all() as any[];
      if (recent.length > 0) {
        md.push('');
        md.push('## Recent Sessions');
        for (const s of recent) md.push(`- [${s.started_at?.slice(0,10)}] ${s.summary}`);
      }
    } catch {}

    return { content: [{ type: 'text' as const, text: md.join('\n') }] };
  }
);

// ═══════════════════════════════════════════════════
// USER PROFILE + EXPORT
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_update_profile',
  'Update user profile (name, role, working style, expertise, communication preference)',
  {
    name: z.string().optional(),
    role: z.string().optional(),
    working_style: z.string().optional(),
    expertise_areas: z.string().optional(),
    communication_preference: z.string().optional(),
  },
  async (input) => {
    const db = getDb();
    // Upsert with id=1
    db.prepare(`INSERT INTO user_profile (id, name, role, working_style, expertise_areas, communication_preference, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name=COALESCE(excluded.name, name),
        role=COALESCE(excluded.role, role),
        working_style=COALESCE(excluded.working_style, working_style),
        expertise_areas=COALESCE(excluded.expertise_areas, expertise_areas),
        communication_preference=COALESCE(excluded.communication_preference, communication_preference),
        updated_at=datetime('now')`
    ).run(input.name ?? null, input.role ?? null, input.working_style ?? null, input.expertise_areas ?? null, input.communication_preference ?? null);
    return { content: [{ type: 'text' as const, text: 'Profile updated.' }] };
  }
);

server.tool(
  'cortex_get_profile',
  'Get the user profile',
  {},
  async () => {
    const db = getDb();
    try {
      const profile = db.prepare(`SELECT * FROM user_profile WHERE id=1`).get() as any;
      if (!profile) return { content: [{ type: 'text' as const, text: 'No profile set. Use cortex_update_profile to create one.' }] };
      const lines = [
        `Name: ${profile.name ?? '(not set)'}`,
        `Role: ${profile.role ?? '(not set)'}`,
        `Working Style: ${profile.working_style ?? '(not set)'}`,
        `Expertise: ${profile.expertise_areas ?? '(not set)'}`,
        `Communication: ${profile.communication_preference ?? '(not set)'}`,
        `Updated: ${profile.updated_at?.slice(0,10) ?? 'never'}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
    }
  }
);

server.tool(
  'cortex_export',
  'Export brain data as JSON or Markdown',
  { format: z.enum(['json', 'markdown']).optional().default('markdown') },
  async ({ format }) => {
    const db = getDb();
    try {
      const data = {
        exported_at: new Date().toISOString(),
        profile: db.prepare(`SELECT * FROM user_profile WHERE id=1`).get() ?? {},
        sessions: db.prepare(`SELECT id, started_at, summary, tags, emotional_tone, mood_score FROM sessions WHERE status='completed' ORDER BY started_at DESC LIMIT 50`).all(),
        decisions: db.prepare(`SELECT title, category, reasoning, created_at FROM decisions WHERE archived!=1 ORDER BY created_at DESC LIMIT 30`).all(),
        learnings: db.prepare(`SELECT anti_pattern, correct_pattern, severity, occurrences FROM learnings WHERE archived!=1 ORDER BY occurrences DESC LIMIT 50`).all(),
        errors: db.prepare(`SELECT error_message, fix_description, severity FROM errors WHERE archived!=1 ORDER BY occurrences DESC LIMIT 30`).all(),
        unfinished: db.prepare(`SELECT description, priority, created_at FROM unfinished WHERE resolved_at IS NULL ORDER BY created_at DESC`).all(),
        notes: ((): any[] => { try { return db.prepare(`SELECT text, tags, created_at FROM notes ORDER BY created_at DESC LIMIT 30`).all() as any[]; } catch { return []; } })(),
      };

      if (format === 'json') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      }

      // Markdown format
      const md: string[] = [`# Brain Export — ${data.exported_at.slice(0,10)}`, ''];
      md.push(`## Profile`);
      const p = data.profile as any;
      if (p?.name) md.push(`**${p.name}** · ${p.role ?? ''} · ${p.working_style ?? ''}`);
      md.push('');
      md.push(`## Open Items (${(data.unfinished as any[]).length})`);
      for (const u of data.unfinished as any[]) md.push(`- [${u.priority}] ${u.description}`);
      md.push('');
      md.push(`## Key Learnings (${(data.learnings as any[]).length})`);
      for (const l of data.learnings as any[]) md.push(`- **${l.anti_pattern}** → ${l.correct_pattern} (${l.occurrences}x)`);
      md.push('');
      md.push(`## Recent Sessions (${(data.sessions as any[]).length})`);
      for (const s of data.sessions as any[]) md.push(`- [${s.started_at?.slice(0,10)}] ${s.summary ?? ''}`);

      return { content: [{ type: 'text' as const, text: md.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Export error: ${e}` }] };
    }
  }
);
// ═══════════════════════════════════════════════════
// ATTENTION ANCHORS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_add_anchor',
  'Add an attention anchor — a topic that always gets priority context',
  { topic: z.string(), priority: z.number().optional().default(5) },
  async ({ topic, priority }) => {
    const db = getDb();
    try {
      db.prepare(`INSERT INTO attention_anchors (topic, priority) VALUES (?, ?)`).run(topic, priority);
      return { content: [{ type: 'text' as const, text: `Anchor added: "${topic}" (priority ${priority})` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Anchor "${topic}" already exists or could not be added.` }] };
    }
  }
);

server.tool(
  'cortex_remove_anchor',
  'Remove an attention anchor by topic',
  { topic: z.string() },
  async ({ topic }) => {
    const db = getDb();
    const r = db.prepare(`DELETE FROM attention_anchors WHERE topic LIKE ?`).run(`%${topic}%`);
    return { content: [{ type: 'text' as const, text: `Removed ${r.changes} anchor(s) matching "${topic}".` }] };
  }
);

server.tool(
  'cortex_list_anchors',
  'List all attention anchors',
  {},
  async () => {
    const db = getDb();
    try {
      const anchors = db.prepare(`SELECT id, topic, priority, last_touched FROM attention_anchors ORDER BY priority DESC, created_at ASC`).all() as any[];
      if (anchors.length === 0) return { content: [{ type: 'text' as const, text: 'No attention anchors set.' }] };
      const lines = anchors.map(a => `[${a.id}] ${a.topic} (priority ${a.priority}, last touched: ${a.last_touched?.slice(0,10) ?? 'never'})`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
    }
  }
);


// ═══════════════════════════════════════════════════
// MOOD
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_get_mood',
  'Get current system mood based on rolling average of last 7 sessions',
  {},
  async () => {
    const db = getDb();
    try {
      const sessions = db.prepare(`
        SELECT emotional_tone, mood_score, started_at FROM sessions
        WHERE mood_score IS NOT NULL AND status='completed'
        ORDER BY started_at DESC LIMIT 7
      `).all() as any[];

      if (sessions.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No mood data yet. Mood scoring runs after sessions complete.' }] };
      }

      const avg = sessions.reduce((s, r) => s + (r.mood_score ?? 3), 0) / sessions.length;
      const mood = avg >= 4 ? 'positive' : avg >= 3 ? 'neutral' : 'negative';
      const lines = [
        `System Mood: ${mood} (avg ${avg.toFixed(1)}/5 over last ${sessions.length} sessions)`,
        '',
        'Recent sessions:',
        ...sessions.map(s => `  [${s.started_at?.slice(0,10)}] ${s.emotional_tone ?? 'unknown'} (${s.mood_score}/5)`),
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
    }
  }
);
// ═══════════════════════════════════════════════════
// ATTENTION ANCHORS
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_add_anchor',
  'Add an attention anchor — a topic that always gets priority context',
  { topic: z.string(), priority: z.number().optional().default(5) },
  async ({ topic, priority }) => {
    const db = getDb();
    try {
      db.prepare(`INSERT INTO attention_anchors (topic, priority) VALUES (?, ?)`).run(topic, priority);
      return { content: [{ type: 'text' as const, text: `Anchor added: "${topic}" (priority ${priority})` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: `Anchor "${topic}" already exists or could not be added.` }] };
    }
  }
);

server.tool(
  'cortex_remove_anchor',
  'Remove an attention anchor by topic',
  { topic: z.string() },
  async ({ topic }) => {
    const db = getDb();
    const r = db.prepare(`DELETE FROM attention_anchors WHERE topic LIKE ?`).run(`%${topic}%`);
    return { content: [{ type: 'text' as const, text: `Removed ${r.changes} anchor(s) matching "${topic}".` }] };
  }
);

server.tool(
  'cortex_list_anchors',
  'List all attention anchors',
  {},
  async () => {
    const db = getDb();
    try {
      const anchors = db.prepare(`SELECT id, topic, priority, last_touched FROM attention_anchors ORDER BY priority DESC, created_at ASC`).all() as any[];
      if (anchors.length === 0) return { content: [{ type: 'text' as const, text: 'No attention anchors set.' }] };
      const lines = anchors.map(a => `[${a.id}] ${a.topic} (priority ${a.priority}, last touched: ${a.last_touched?.slice(0,10) ?? 'never'})`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
    }
  }
);


// ═══════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════

server.tool(
  'cortex_onboard',
  'Run first-time onboarding: set up user profile and attention anchors',
  {
    name: z.string().describe('Your name'),
    role: z.string().describe('Your role (e.g. solo developer, lead engineer)'),
    working_style: z.string().describe('How you prefer to work (e.g. test-driven, prototype-first)'),
    expertise_areas: z.string().describe('Your main areas of expertise (comma-separated)'),
    anchors: z.array(z.string()).describe('3-5 topics you always want Cortex to track').optional(),
  },
  async ({ name, role, working_style, expertise_areas, anchors }) => {
    const db = getDb();
    const ts = new Date().toISOString();

    // Upsert profile
    db.prepare(`INSERT INTO user_profile (id, name, role, working_style, expertise_areas, updated_at)
      VALUES (1, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
        working_style=excluded.working_style, expertise_areas=excluded.expertise_areas,
        updated_at=datetime('now')`
    ).run(name, role, working_style, expertise_areas);

    // Add anchors
    const addedAnchors: string[] = [];
    if (anchors && anchors.length > 0) {
      for (const topic of anchors.slice(0, 5)) {
        try {
          db.prepare(`INSERT INTO attention_anchors (topic, priority) VALUES (?, 8)`).run(topic);
          addedAnchors.push(topic);
        } catch { /* already exists */ }
      }
    }

    // Mark onboarding complete in meta
    db.prepare(`INSERT INTO meta (key, value) VALUES ('onboarding_complete', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(ts);

    const lines = [
      `Welcome, ${name}! Cortex is now configured.`,
      `Role: ${role}`,
      `Working style: ${working_style}`,
      `Expertise: ${expertise_areas}`,
      addedAnchors.length > 0 ? `Anchors: ${addedAnchors.join(', ')}` : '',
      '',
      'Cortex will now track your sessions, decisions, errors, and learnings.',
      'Use /resume to get a re-entry brief at any time.',
    ].filter(l => l !== '');

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ═══════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════

async function main() {
  getDb();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => { closeDb(); process.exit(0); });
  process.on('SIGTERM', () => { closeDb(); process.exit(0); });
}

main().catch((err) => {
  console.error('Cortex MCP Server failed to start:', err);
  process.exit(1);
});
