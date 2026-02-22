import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as errors from '../modules/errors.js';

export function registerErrorTools(server: McpServer): void {
  server.tool(
    'cortex_add_error',
    'Record an error with optional root cause, fix, and prevention rule',
    {
      error_message: z.string().describe('The error that occurred. Example: "TypeError: Cannot read property \'id\' of undefined in sessions.updateSession" or "FTS5 table not found: learnings_fts"'),
      root_cause: z.string().optional().describe('WHY it happened. Example: "Session was not created before updateSession was called" or "ensure-db.js ran before FTS5 virtual tables were defined"'),
      fix_description: z.string().optional().describe('How it was fixed. Example: "Added createSession() call before updateSession() in cortex_save_session handler"'),
      fix_diff: z.string().optional().describe('The actual code diff that fixed it (optional, for future reference)'),
      files_involved: z.array(z.string()).optional().describe('Files where the error occurred. Example: ["server/src/index.ts", "server/src/modules/sessions.ts"]'),
      prevention_rule: z.string().optional().describe('Regex or keyword to detect this pattern in future. Example: "updateSession\(" or "FTS5"'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Impact: low=cosmetic, medium=functional issue, high=data loss risk, critical=system down'),
      session_id: z.string().optional(),
      batch: z.array(z.object({
        error_message: z.string(),
        root_cause: z.string().optional(),
        fix_description: z.string().optional(),
        fix_diff: z.string().optional(),
        files_involved: z.array(z.string()).optional(),
        prevention_rule: z.string().optional(),
        severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        session_id: z.string().optional(),
      })).optional().describe('Add multiple errors at once'),
    },
    async (input) => {
      if (input.batch && input.batch.length > 0) {
        getDb();
        const results = input.batch.map(item => errors.addError(item));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ added: results.length, ids: (results as Array<{ id: number | bigint }>).map(r => r.id) }, null, 2) }] };
      }
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
      include_notes: z.boolean().optional().describe('If true, include linked notes for each error'),
    },
    async (input) => {
      const db = getDb();
      const result = errors.listErrors(input);
      if (input.include_notes) {
        for (const e of result as unknown as Record<string, unknown>[]) {
          e.notes = db.prepare(`SELECT id, text, created_at FROM notes WHERE entity_type='error' AND entity_id=? ORDER BY created_at DESC`).all(e.id as number);
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
}
