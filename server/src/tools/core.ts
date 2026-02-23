// server/src/tools/core.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as decisions from '../modules/decisions.js';
import * as errors from '../modules/errors.js';
import * as learnings from '../modules/learnings.js';
import * as unfinished from '../modules/unfinished.js';
import * as sessions from '../modules/sessions.js';
import * as search from '../modules/search.js';
import * as health from '../modules/health.js';
import * as projectMap from '../modules/project-map.js';
import { runAllPruning } from '../helpers.js';

export function registerCoreTools(server: McpServer): void {

  server.tool(
    'cortex_store',
    'Store memory: decisions, errors, learnings (anti-patterns), todos, intents, notes',
    {
      type: z.enum(['decision', 'error', 'learning', 'todo', 'intent', 'note'])
        .describe('What to store'),
      // decision
      title: z.string().optional().describe('decision: short title'),
      reasoning: z.string().optional().describe('decision: why this was chosen'),
      category: z.enum(['architecture', 'convention', 'bugfix', 'feature', 'config', 'security']).optional(),
      files_affected: z.array(z.string()).optional(),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
      alternatives: z.array(z.object({
        option: z.string(),
        reason_rejected: z.string(),
      })).optional(),
      // error
      error_message: z.string().optional().describe('error: what went wrong'),
      root_cause: z.string().optional(),
      fix_description: z.string().optional(),
      prevention_rule: z.string().optional().describe('error: regex to detect this in future'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      files_involved: z.array(z.string()).optional(),
      // learning
      anti_pattern: z.string().optional().describe('learning: bad pattern to avoid'),
      correct_pattern: z.string().optional().describe('learning: what to do instead'),
      context: z.string().optional().describe('learning/todo: when/where this applies'),
      detection_regex: z.string().optional(),
      auto_block: z.boolean().optional().describe('learning: block on PreToolUse'),
      // todo / intent / note
      description: z.string().optional().describe('todo: what needs to be done'),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      intent: z.string().optional().describe('intent: what you plan to do next session'),
      // note
      text: z.string().optional().describe('note: content'),
      tags: z.array(z.string()).optional(),
      entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional(),
      entity_id: z.number().optional(),
      // shared
      session_id: z.string().optional(),
    },
    async (input) => {
      getDb();
      const { type } = input;

      if (type === 'decision') {
        if (!input.title || !input.reasoning || !input.category) {
          return { content: [{ type: 'text' as const, text: 'Error: decision requires title, reasoning, category' }] };
        }
        const { decision, duplicate } = decisions.addDecision({
          title: input.title,
          reasoning: input.reasoning,
          category: input.category,
          files_affected: input.files_affected,
          alternatives: input.alternatives,
          confidence: input.confidence,
          session_id: input.session_id,
        });
        let text = `Decision saved (id: ${decision.id})`;
        if (duplicate) text += `
Possible duplicate of #${duplicate.id} (${duplicate.score}% similar): \"${duplicate.title}\"`;
        return { content: [{ type: 'text' as const, text }] };
      }

      if (type === 'error') {
        if (!input.error_message) {
          return { content: [{ type: 'text' as const, text: 'Error: error requires error_message' }] };
        }
        const err = errors.addError({
          error_message: input.error_message,
          root_cause: input.root_cause,
          fix_description: input.fix_description,
          prevention_rule: input.prevention_rule,
          severity: input.severity,
          files_involved: input.files_involved,
          session_id: input.session_id,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }] };
      }

      if (type === 'learning') {
        if (!input.anti_pattern || !input.correct_pattern || !input.context) {
          return { content: [{ type: 'text' as const, text: 'Error: learning requires anti_pattern, correct_pattern, context' }] };
        }
        const { learning, duplicate } = learnings.addLearning({
          anti_pattern: input.anti_pattern,
          correct_pattern: input.correct_pattern,
          context: input.context,
          detection_regex: input.detection_regex,
          severity: input.severity as 'low' | 'medium' | 'high' | undefined,
          auto_block: input.auto_block,
          session_id: input.session_id,
        });
        let text = `Learning saved (id: ${learning.id})`;
        if (duplicate) text += `
Possible duplicate of #${duplicate.id}: \"${duplicate.anti_pattern}\"`;
        return { content: [{ type: 'text' as const, text }] };
      }

      if (type === 'todo') {
        if (!input.description) {
          return { content: [{ type: 'text' as const, text: 'Error: todo requires description' }] };
        }
        const item = unfinished.addUnfinished({
          description: input.description,
          context: input.context,
          priority: input.priority,
          session_id: input.session_id,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }] };
      }

      if (type === 'intent') {
        if (!input.intent) {
          return { content: [{ type: 'text' as const, text: 'Error: intent requires intent field' }] };
        }
        const db = getDb();
        const ts = new Date().toISOString();
        db.prepare(`INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, 'active')`).run(input.session_id ?? `intent-${ts}`, ts);
        db.prepare(`INSERT INTO unfinished (session_id, created_at, description, context, priority) VALUES (?, ?, ?, 'intent', 'medium')`).run(
          input.session_id ?? null, ts, `[INTENT] ${input.intent}`
        );
        return { content: [{ type: 'text' as const, text: `Intent stored: \"${input.intent}\"` }] };
      }

      if (type === 'note') {
        if (!input.text) {
          return { content: [{ type: 'text' as const, text: 'Error: note requires text' }] };
        }
        const db = getDb();
        const ts = new Date().toISOString();
        const result = db.prepare(
          `INSERT INTO notes (text, tags, entity_type, entity_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          input.text,
          input.tags ? JSON.stringify(input.tags) : null,
          input.entity_type ?? null,
          input.entity_id ?? null,
          input.session_id ?? null,
          ts
        );
        return { content: [{ type: 'text' as const, text: `Note saved (id: ${result.lastInsertRowid})` }] };
      }

      return { content: [{ type: 'text' as const, text: `Unknown type: ${type}` }] };
    }
  );


  server.tool(
    'cortex_search',
    'Search all Cortex memory: decisions, errors, learnings, todos, notes, sessions',
    {
      query: z.string().describe('Search query (FTS5: AND, OR, NOT, "phrase")'),
      limit: z.number().optional().describe('Max results (default: 15)'),
    },
    async ({ query, limit }) => {
      getDb();
      const results = await search.searchAll(query, limit ?? 15);
      const formatted = search.formatResults(results);
      return { content: [{ type: 'text' as const, text: formatted }] };
    }
  );

  server.tool(
    'cortex_context',
    'Get session context: recent sessions, todos, learnings, health. Pass files for file-specific context.',
    {
      files: z.array(z.string()).optional().describe('File paths for targeted context'),
    },
    async ({ files }) => {
      getDb();
      const ctx: Record<string, unknown> = {};
      ctx.recentSessions = sessions.getRecentSummaries(3);
      ctx.unfinished = unfinished.listUnfinished({ limit: 10 });
      if (files && files.length > 0) {
        ctx.fileErrors = errors.getErrorsForFiles(files);
      }
      ctx.activeLearnings = learnings.listLearnings({ autoBlockOnly: true });
      ctx.health = health.getLatestSnapshot();
      ctx.projectMap = projectMap.getModuleSummary();
      return { content: [{ type: 'text' as const, text: JSON.stringify(ctx, null, 2) }] };
    }
  );

  server.tool(
    'cortex_list',
    'List stored items by type',
    {
      type: z.enum(['decisions', 'errors', 'learnings', 'todos', 'notes'])
        .describe('What to list'),
      category: z.string().optional().describe('decisions: filter by category'),
      severity: z.string().optional().describe('errors/learnings: filter by severity'),
      auto_block_only: z.boolean().optional().describe('learnings: only auto-blocking rules'),
      limit: z.number().optional(),
    },
    async (input) => {
      const db = getDb();
      let result: unknown;

      if (input.type === 'decisions') {
        result = decisions.listDecisions({ category: input.category, limit: input.limit });
      } else if (input.type === 'errors') {
        result = errors.listErrors({ severity: input.severity, limit: input.limit });
      } else if (input.type === 'learnings') {
        result = learnings.listLearnings({ autoBlockOnly: input.auto_block_only, limit: input.limit ?? 50 });
      } else if (input.type === 'todos') {
        result = unfinished.listUnfinished({ limit: input.limit });
      } else if (input.type === 'notes') {
        result = db.prepare(`SELECT * FROM notes WHERE 1=1 ORDER BY created_at DESC LIMIT ?`).all(input.limit ?? 50);
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'cortex_resolve',
    'Close/update an item: mark todo resolved, decision reviewed, or update an error',
    {
      type: z.enum(['todo', 'decision', 'error']),
      id: z.number(),
      fix_description: z.string().optional(),
      prevention_rule: z.string().optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      session_id: z.string().optional(),
    },
    async (input) => {
      getDb();
      if (input.type === 'todo') {
        const item = unfinished.resolveUnfinished(input.id, input.session_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ resolved: true, item }, null, 2) }] };
      }
      if (input.type === 'decision') {
        getDb().prepare(`UPDATE decisions SET stale=0, reviewed_at=datetime('now') WHERE id=?`).run(input.id);
        return { content: [{ type: 'text' as const, text: `Decision ${input.id} marked as reviewed.` }] };
      }
      if (input.type === 'error') {
        const err = errors.updateError({
          id: input.id,
          fix_description: input.fix_description,
          prevention_rule: input.prevention_rule,
          severity: input.severity,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(err, null, 2) }] };
      }
      return { content: [{ type: 'text' as const, text: `Unknown type: ${input.type}` }] };
    }
  );

  server.tool(
    'cortex_snooze',
    'Set a reminder for a future session',
    {
      description: z.string(),
      until: z.string().describe('Relative: 3d / 1w  or  ISO date: 2026-03-01'),
      session_id: z.string().optional(),
    },
    async ({ description, until, session_id }) => {
      let d = new Date();
      if (/^\d+d$/i.test(until)) d.setDate(d.getDate() + parseInt(until));
      else if (/^\d+w$/i.test(until)) d.setDate(d.getDate() + parseInt(until) * 7);
      else d = new Date(until);
      getDb().prepare(
        `INSERT INTO unfinished (description,context,priority,session_id,snooze_until,created_at) VALUES (?,?,?,?,?,datetime('now'))`
      ).run(description, 'snoozed', 'medium', session_id ?? null, d.toISOString());
      return { content: [{ type: 'text' as const, text: `Reminder set for ${d.toISOString().slice(0, 10)}` }] };
    }
  );

  // Intern: von Hooks aufgerufen
  server.tool(
    'cortex_save_session',
    'Save or update a session (used by hooks)',
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
      if (!status || status === 'active') {
        try { runAllPruning(); } catch { /* ignore */ }
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


} // Ende registerCoreTools
