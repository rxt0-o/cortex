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
  },
  async ({ limit, chain_id }) => {
    getDb();
    const result = sessions.listSessions(limit ?? 20, chain_id);
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
    getDb();
    const maxResults = limit ?? 10;
    const results: Array<{ type: string; data: unknown }> = [];

    const sessionResults = sessions.searchSessions(query, maxResults);
    for (const s of sessionResults) results.push({ type: 'session', data: s });

    const decisionResults = decisions.searchDecisions(query, maxResults);
    for (const d of decisionResults) results.push({ type: 'decision', data: d });

    const errorResults = errors.searchErrors(query, maxResults);
    for (const e of errorResults) results.push({ type: 'error', data: e });

    const learningResults = learnings.searchLearnings(query, maxResults);
    for (const l of learningResults) results.push({ type: 'learning', data: l });

    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
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
