import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as unfinished from '../modules/unfinished.js';

export function registerTrackingTools(server: McpServer): void {
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
      description: z.string().describe('What needs to be done. Example: "Implement RRF fusion for cortex_search (BM25 + embeddings)" or "Add input_examples to tool definitions"'),
      context: z.string().optional().describe('Why it matters / relevant links. Example: "See https://github.com/oraios/serena — LSP-based symbol navigation, 30+ languages"'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority: low=nice-to-have, medium=should do soon, high=blocking or urgent'),
      session_id: z.string().optional(),
    },
    async (input) => {
      getDb();
      const item = unfinished.addUnfinished(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
    }
  );

  server.tool(
    'cortex_resolve_unfinished',
    'Mark an unfinished item as resolved/done',
    {
      id: z.number().optional().describe('Single item ID to resolve'),
      ids: z.array(z.number()).optional().describe('Multiple item IDs to resolve at once. Example: [1, 2, 3]'),
      session_id: z.string().optional(),
    },
    async ({ id, ids, session_id }) => {
      getDb();
      const toResolve = ids ?? (id !== undefined ? [id] : []);
      if (toResolve.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: provide id or ids' }] };
      }
      const results = toResolve.map(i => ({ id: i, item: unfinished.resolveUnfinished(i, session_id) }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ resolved: results.length, results }, null, 2) }] };
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

  server.tool('cortex_snooze', 'Schedule a future session reminder', {
    description: z.string(),
    until: z.string().describe('Relative 3d/1w or ISO date 2026-03-01'),
    session_id: z.string().optional(),
  }, async ({ description, until, session_id }) => {
    let d = new Date();
    if (/^\d+d$/i.test(until)) d.setDate(d.getDate() + parseInt(until));
    else if (/^\d+w$/i.test(until)) d.setDate(d.getDate() + parseInt(until) * 7);
    else d = new Date(until);
    getDb().prepare(`INSERT INTO unfinished (description,context,priority,session_id,snooze_until) VALUES (?,?,?,?,?)`).run(description, 'snoozed', 'medium', session_id ?? null, d.toISOString());
    return { content: [{ type: 'text' as const, text: `Reminder set for ${d.toISOString().slice(0, 10)}` }] };
  });
}
