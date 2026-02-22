import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as learnings from '../modules/learnings.js';
import * as conventions from '../modules/conventions.js';
import * as errors from '../modules/errors.js';
import * as health from '../modules/health.js';
import { runAllPruning } from '../helpers.js';
export function registerStatsTools(server: McpServer): void {

  server.tool(
    'cortex_get_health',
    'Get project health score with metrics and trend',
    {},
    async () => {
      const db = getDb();
      const snapshot = health.getLatestSnapshot();
      const history = health.getHealthHistory(7);
      const metrics = health.calculateHealth();
      const score = health.computeScore(metrics);

      // Agent-Erfolgsrate (letzte 30 Tage)
      let agentHealth = null;
      try {
        agentHealth = db.prepare(`
          SELECT agent_name,
            COUNT(*) as runs,
            ROUND(100.0 * SUM(success) / COUNT(*), 1) as success_rate_pct,
            MAX(CASE WHEN success=0 THEN error_message END) as last_error
          FROM agent_runs
          WHERE started_at > datetime('now', '-30 days')
          GROUP BY agent_name
        `).all();
      } catch { /* Tabelle noch nicht vorhanden */ }

      // Session-Kosten (letzte 7 Sessions)
      let costSummary = null;
      try {
        costSummary = db.prepare(`
          SELECT
            COUNT(*) as sessions_with_metrics,
            ROUND(AVG(cost_usd), 4) as avg_cost_usd,
            ROUND(SUM(cost_usd), 4) as total_cost_usd_7d,
            ROUND(CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(input_tokens + cache_read_tokens), 0) * 100, 1) as cache_hit_rate_pct
          FROM session_metrics
          WHERE recorded_at > datetime('now', '-7 days')
        `).get();
      } catch { /* Tabelle noch nicht vorhanden */ }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ currentScore: score, metrics, latestSnapshot: snapshot, recentHistory: history, agentHealth, costSummary }, null, 2),
        }],
      };
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
    'cortex_get_access_stats',
    'Show top accessed decisions, learnings and errors -- what gets used most',
    {},
    async () => {
      const db = getDb();
      const topDecisions = db.prepare(`
        SELECT id, title, category, access_count, last_accessed
        FROM decisions WHERE archived_at IS NULL
        ORDER BY access_count DESC LIMIT 10
      `).all() as any[];
  
      const topLearnings = db.prepare(`
        SELECT id, anti_pattern, severity, access_count, last_accessed
        FROM learnings WHERE archived_at IS NULL
        ORDER BY access_count DESC LIMIT 10
      `).all() as any[];
  
      const topErrors = db.prepare(`
        SELECT id, error_message, severity, access_count, last_accessed
        FROM errors WHERE archived_at IS NULL
        ORDER BY access_count DESC LIMIT 10
      `).all() as any[];
  
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ top_decisions: topDecisions, top_learnings: topLearnings, top_errors: topErrors }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'cortex_run_pruning',
    'Manually run Ebbinghaus pruning — archives unused decisions/learnings/errors. Runs automatically on session start.',
    {},
    async () => {
      getDb();
      const result = runAllPruning();
      const total = result.decisions_archived + result.learnings_archived + result.errors_archived;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            archived: result,
            total_archived: total,
            message: total > 0
              ? `${total} item(s) archived based on Ebbinghaus forgetting curve.`
              : 'Nothing to archive -- all items are fresh or recently accessed.',
          }, null, 2),
        }],
      };
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

  server.tool(
    'cortex_session_metrics',
    'Show token usage and cost metrics per session',
    {
      limit: z.number().optional().default(10).describe('Number of recent sessions to show. input_examples: [5, 20]'),
      aggregate: z.boolean().optional().default(false).describe('If true, return averages across all sessions instead of per-session list. input_examples: [true]'),
    },
    async ({ limit, aggregate }) => {
      const db = getDb();
      try {
        if (aggregate) {
          const row = db.prepare(`
            SELECT
              COUNT(*) as sessions,
              ROUND(AVG(input_tokens), 0) as avg_input_tokens,
              ROUND(AVG(output_tokens), 0) as avg_output_tokens,
              ROUND(AVG(cache_read_tokens), 0) as avg_cache_read,
              ROUND(AVG(cost_usd), 4) as avg_cost_usd,
              ROUND(SUM(cost_usd), 4) as total_cost_usd,
              ROUND(CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(input_tokens + cache_read_tokens), 0) * 100, 1) as cache_hit_rate_pct
            FROM session_metrics
          `).get();
          return { content: [{ type: 'text' as const, text: JSON.stringify(row, null, 2) }] };
        }
        const rows = db.prepare(`
          SELECT sm.*, s.summary
          FROM session_metrics sm
          LEFT JOIN sessions s ON s.id = sm.session_id
          ORDER BY sm.recorded_at DESC
          LIMIT ?
        `).all(limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
      }
    }
  );

  server.tool(
    'cortex_agent_status',
    'Show daemon agent run history with success rates and errors',
    {
      limit: z.number().optional().default(20).describe('Max number of agent runs to return. input_examples: [10, 50]'),
      agent_name: z.string().optional().describe('Filter by agent name (learner, architect, context, etc.). input_examples: ["learner", "architect"]'),
    },
    async ({ limit, agent_name }) => {
      const db = getDb();
      try {
        const runs = agent_name
          ? db.prepare(`SELECT * FROM agent_runs WHERE agent_name = ? ORDER BY started_at DESC LIMIT ?`).all(agent_name, limit)
          : db.prepare(`SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?`).all(limit);

        const summary = db.prepare(`
          SELECT agent_name,
            COUNT(*) as total_runs,
            SUM(success) as successful,
            ROUND(AVG(duration_ms), 0) as avg_duration_ms,
            SUM(items_saved) as total_items_saved,
            MAX(started_at) as last_run
          FROM agent_runs
          GROUP BY agent_name
          ORDER BY last_run DESC
        `).all();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ summary, recent_runs: runs }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
      }
    }
  );

}
