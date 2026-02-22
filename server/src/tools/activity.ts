// server/src/tools/activity.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as activity from '../modules/activity.js';

export function registerActivityTools(server: McpServer): void {
  server.tool(
    'cortex_activity_log',
    'Get activity log — structured audit trail of all important operations',
    {
      entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional().describe('Filter by entity type. Example: "decision"'),
      entity_id: z.number().optional().describe('Filter by entity ID. Example: 42'),
      action: z.enum(['create', 'update', 'delete', 'archive']).optional().describe('Filter by action type'),
      since: z.string().optional().describe('ISO date or datetime to filter from. Example: "2026-02-01"'),
      limit: z.number().optional().default(50),
    },
    async (input) => {
      getDb();
      const entries = activity.listActivity(input);
      if (entries.length === 0) return { content: [{ type: 'text' as const, text: 'No activity found.' }] };
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries, null, 2) }] };
    }
  );

  server.tool(
    'cortex_log_activity',
    'Manually log an activity entry — call after important operations',
    {
      tool_name: z.string().describe('Tool or operation name. Example: "cortex_add_decision" or "manual-refactor"'),
      entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional(),
      entity_id: z.number().optional().describe('ID of the affected entity'),
      action: z.enum(['create', 'update', 'delete', 'archive']).describe('Type of action performed'),
      old_value: z.string().optional().describe('Previous value as JSON string'),
      new_value: z.string().optional().describe('New value as JSON string'),
      session_id: z.string().optional(),
    },
    async (input) => {
      getDb();
      const result = activity.logActivity(input);
      return { content: [{ type: 'text' as const, text: `Activity logged (id: ${result.id})` }] };
    }
  );
}
