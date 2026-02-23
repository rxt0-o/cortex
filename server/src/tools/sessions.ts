import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as sessions from '../modules/sessions.js';
import * as errors from '../modules/errors.js';
import * as learnings from '../modules/learnings.js';
import * as unfinished from '../modules/unfinished.js';
import * as health from '../modules/health.js';
import * as projectMap from '../modules/project-map.js';
import * as search from '../modules/search.js';
import { runAllPruning } from '../helpers.js';
export function registerSessionTools(server: McpServer): void {

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
      // Auto-pruning beim Session-Start (Ebbinghaus-Forgetting-Curve)
      if (!status || status === 'active') {
        try { runAllPruning(); } catch { /* Pruning-Fehler blockieren Session-Start nicht */ }
      }
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

  server.tool(
    'cortex_search',
    'Semantic search across all Cortex data: sessions, decisions, errors, learnings, notes, unfinished. Uses BM25 + embedding similarity with RRF-Fusion for best results.',
    {
      query: z.string().describe('Search query — supports FTS5 syntax (AND, OR, NOT, "phrase")'),
      limit: z.number().optional().describe('Max results to return (default: 15)'),
    },
    async ({ query, limit }) => {
      getDb();
      const results = await search.searchAll(query, limit ?? 15);
      const formatted = search.formatResults(results);
      return { content: [{ type: 'text' as const, text: formatted }] };
    }
  );

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

}
