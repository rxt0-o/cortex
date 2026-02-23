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

} // Ende registerCoreTools (TEMPORAER - wird in Task 2 wieder geoeffnet)
