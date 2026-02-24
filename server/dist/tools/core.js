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
import { embedAsync } from '../modules/embed-hooks.js';
import { backfillEmbeddings, getEmbeddingCount } from '../modules/embeddings.js';
import { isGeminiAvailable, summarizeWithGemini } from '../utils/gemini.js';
import { runAllPruning } from '../helpers.js';
import { touchMemory } from '../modules/decay.js';
import { computeImportance } from '../modules/importance.js';
import * as extractions from '../modules/extractions.js';
import { autoCreateAssociations, autoCreateSemanticAssociations } from '../modules/associations.js';
import { activateForFiles } from '../modules/activation.js';
export function registerCoreTools(server) {
    server.tool('cortex_store', 'Store memory: decisions, errors, learnings (anti-patterns), todos, intents, notes', {
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
        blocked_by: z.array(z.number().int().positive()).optional()
            .describe('todo: IDs of unresolved todos that must be completed first'),
        intent: z.string().optional().describe('intent: what you plan to do next session'),
        // note
        text: z.string().optional().describe('note: content'),
        tags: z.array(z.string()).optional(),
        entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional(),
        entity_id: z.number().optional(),
        // shared
        session_id: z.string().optional(),
    }, async (input) => {
        getDb();
        const { type } = input;
        if (type === 'decision') {
            if (!input.title || !input.reasoning || !input.category) {
                return { content: [{ type: 'text', text: 'Error: decision requires title, reasoning, category' }] };
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
            try {
                const score = computeImportance({ accessCount: 0, lastAccessed: null, createdAt: new Date().toISOString(), priority: input.confidence, entityType: 'decision', sessionId: input.session_id });
                getDb().prepare('UPDATE decisions SET importance_score = ? WHERE id = ?').run(score, decision.id);
            }
            catch { /* non-critical */ }
            try {
                autoCreateAssociations({ entityType: 'decision', entityId: decision.id, sessionId: input.session_id, files: input.files_affected });
            }
            catch { /* non-critical */ }
            autoCreateSemanticAssociations({ entityType: 'decision', entityId: decision.id, embeddingText: `${input.title} ${input.reasoning}`.slice(0, 512) }).catch(() => { });
            let text = `Decision saved (id: ${decision.id})`;
            if (duplicate)
                text += `
Possible duplicate of #${duplicate.id} (${duplicate.score}% similar): \"${duplicate.title}\"`;
            return { content: [{ type: 'text', text }] };
        }
        if (type === 'error') {
            if (!input.error_message) {
                return { content: [{ type: 'text', text: 'Error: error requires error_message' }] };
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
            try {
                const score = computeImportance({ accessCount: 0, lastAccessed: null, createdAt: new Date().toISOString(), severity: input.severity, entityType: 'error', sessionId: input.session_id });
                getDb().prepare('UPDATE errors SET importance_score = ? WHERE id = ?').run(score, err.id);
            }
            catch { /* non-critical */ }
            try {
                autoCreateAssociations({ entityType: 'error', entityId: err.id, sessionId: input.session_id, files: input.files_involved });
            }
            catch { /* non-critical */ }
            autoCreateSemanticAssociations({ entityType: 'error', entityId: err.id, embeddingText: `${input.error_message} ${input.root_cause ?? ''} ${input.fix_description ?? ''}`.slice(0, 512) }).catch(() => { });
            return { content: [{ type: 'text', text: JSON.stringify(err, null, 2) }] };
        }
        if (type === 'learning') {
            if (!input.anti_pattern || !input.correct_pattern || !input.context) {
                return { content: [{ type: 'text', text: 'Error: learning requires anti_pattern, correct_pattern, context' }] };
            }
            const { learning, duplicate } = learnings.addLearning({
                anti_pattern: input.anti_pattern,
                correct_pattern: input.correct_pattern,
                context: input.context,
                detection_regex: input.detection_regex,
                severity: input.severity,
                auto_block: input.auto_block,
                session_id: input.session_id,
            });
            try {
                const score = computeImportance({ accessCount: 0, lastAccessed: null, createdAt: new Date().toISOString(), severity: input.severity, entityType: 'learning', sessionId: input.session_id });
                getDb().prepare('UPDATE learnings SET importance_score = ? WHERE id = ?').run(score, learning.id);
            }
            catch { /* non-critical */ }
            try {
                autoCreateAssociations({ entityType: 'learning', entityId: learning.id, sessionId: input.session_id });
            }
            catch { /* non-critical */ }
            autoCreateSemanticAssociations({ entityType: 'learning', entityId: learning.id, embeddingText: `${input.anti_pattern} ${input.correct_pattern} ${input.context}`.slice(0, 512) }).catch(() => { });
            let text = `Learning saved (id: ${learning.id})`;
            if (duplicate)
                text += `
Possible duplicate of #${duplicate.id}: \"${duplicate.anti_pattern}\"`;
            return { content: [{ type: 'text', text }] };
        }
        if (type === 'todo') {
            if (!input.description) {
                return { content: [{ type: 'text', text: 'Error: todo requires description' }] };
            }
            try {
                const result = unfinished.addUnfinished({
                    description: input.description,
                    context: input.context,
                    priority: input.priority,
                    session_id: input.session_id,
                    blocked_by: input.blocked_by,
                });
                try {
                    const score = computeImportance({ accessCount: 0, lastAccessed: null, createdAt: new Date().toISOString(), priority: input.priority, entityType: 'unfinished', sessionId: input.session_id });
                    getDb().prepare('UPDATE unfinished SET importance_score = ? WHERE id = ?').run(score, result.item.id);
                }
                catch { /* non-critical */ }
                try {
                    autoCreateAssociations({ entityType: 'unfinished', entityId: result.item.id, sessionId: input.session_id });
                }
                catch { /* non-critical */ }
                autoCreateSemanticAssociations({ entityType: 'unfinished', entityId: result.item.id, embeddingText: `${input.description} ${input.context ?? ''}`.slice(0, 512) }).catch(() => { });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { content: [{ type: 'text', text: `Error: ${message}` }] };
            }
        }
        if (type === 'intent') {
            if (!input.intent) {
                return { content: [{ type: 'text', text: 'Error: intent requires intent field' }] };
            }
            const db = getDb();
            const ts = new Date().toISOString();
            db.prepare(`INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, 'active')`).run(input.session_id ?? `intent-${ts}`, ts);
            db.prepare(`INSERT INTO unfinished (session_id, created_at, description, context, priority) VALUES (?, ?, ?, 'intent', 'medium')`).run(input.session_id ?? null, ts, `[INTENT] ${input.intent}`);
            return { content: [{ type: 'text', text: `Intent stored: \"${input.intent}\"` }] };
        }
        if (type === 'note') {
            if (!input.text) {
                return { content: [{ type: 'text', text: 'Error: note requires text' }] };
            }
            const db = getDb();
            const ts = new Date().toISOString();
            const result = db.prepare(`INSERT INTO notes (text, tags, entity_type, entity_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(input.text, input.tags ? JSON.stringify(input.tags) : null, input.entity_type ?? null, input.entity_id ?? null, input.session_id ?? null, ts);
            const insertedId = Number(result.lastInsertRowid);
            try {
                const score = computeImportance({ accessCount: 0, lastAccessed: null, createdAt: ts, entityType: 'note', sessionId: input.session_id });
                db.prepare('UPDATE notes SET importance_score = ? WHERE id = ?').run(score, insertedId);
            }
            catch { /* non-critical */ }
            try {
                autoCreateAssociations({ entityType: 'note', entityId: insertedId, sessionId: input.session_id });
            }
            catch { /* non-critical */ }
            autoCreateSemanticAssociations({ entityType: 'note', entityId: insertedId, embeddingText: `${input.text} ${(input.tags ?? []).join(' ')}`.slice(0, 512) }).catch(() => { });
            embedAsync('note', insertedId, { text: input.text, tags: (input.tags ?? []).join(' ') });
            return { content: [{ type: 'text', text: `Note saved (id: ${insertedId})` }] };
        }
        return { content: [{ type: 'text', text: `Unknown type: ${type}` }] };
    });
    server.tool('cortex_search', 'Search all Cortex memory: decisions, errors, learnings, todos, notes, sessions', {
        query: z.string().describe('Search query (FTS5: AND, OR, NOT, "phrase")'),
        limit: z.number().optional().describe('Max results (default: 15)'),
        summarize: z.boolean().optional().describe('Optional AI summary (requires GEMINI_API_KEY)'),
    }, async ({ query, limit, summarize }) => {
        getDb();
        const results = await search.searchAll(query, limit ?? 15);
        const formatted = search.formatResults(results);
        if (!summarize) {
            return { content: [{ type: 'text', text: formatted }] };
        }
        if (!isGeminiAvailable()) {
            return {
                content: [{
                        type: 'text',
                        text: `Gemini summary unavailable: set GEMINI_API_KEY (or GOOGLE_API_KEY).\n\n${formatted}`,
                    }],
            };
        }
        const summary = await summarizeWithGemini({
            title: `Summarize Cortex search for query: ${query}`,
            text: formatted,
            maxOutputTokens: 500,
        });
        const combined = summary
            ? `AI SUMMARY\n${summary}\n\nRAW RESULTS\n${formatted}`
            : formatted;
        return { content: [{ type: 'text', text: combined }] };
    });
    server.tool('cortex_context', 'Get session context: recent sessions, todos, learnings, health. Pass files for file-specific context.', {
        files: z.array(z.string()).optional().describe('File paths for targeted context'),
        summarize: z.boolean().optional().describe('Optional AI summary (requires GEMINI_API_KEY)'),
        summary_only: z.boolean().optional().describe('Return only summary text'),
    }, async ({ files, summarize, summary_only }) => {
        getDb();
        const ctx = {};
        ctx.recentSessions = sessions.getRecentSummaries(3);
        ctx.unfinished = unfinished.listUnfinished({ limit: 10 });
        if (files && files.length > 0) {
            ctx.fileErrors = errors.getErrorsForFiles(files);
            try {
                const activated = activateForFiles(files);
                if (activated.length > 0) {
                    ctx.activatedMemories = activated.slice(0, 10);
                }
            }
            catch { /* non-critical */ }
        }
        ctx.activeLearnings = learnings.listLearnings({ autoBlockOnly: true });
        ctx.health = health.getLatestSnapshot();
        ctx.projectMap = projectMap.getModuleSummary();
        const raw = JSON.stringify(ctx, null, 2);
        if (!summarize) {
            return { content: [{ type: 'text', text: raw }] };
        }
        if (!isGeminiAvailable()) {
            return {
                content: [{
                        type: 'text',
                        text: `Gemini summary unavailable: set GEMINI_API_KEY (or GOOGLE_API_KEY).\n\n${raw}`,
                    }],
            };
        }
        const summary = await summarizeWithGemini({
            title: 'Summarize Cortex context block',
            text: raw,
            maxOutputTokens: 700,
        });
        if (!summary) {
            return { content: [{ type: 'text', text: raw }] };
        }
        const out = summary_only ? summary : `AI SUMMARY\n${summary}\n\nRAW CONTEXT\n${raw}`;
        return { content: [{ type: 'text', text: out }] };
    });
    server.tool('cortex_list', 'List stored items by type', {
        type: z.enum(['decisions', 'errors', 'learnings', 'todos', 'notes', 'extractions'])
            .describe('What to list'),
        category: z.string().optional().describe('decisions: filter by category'),
        severity: z.string().optional().describe('errors/learnings: filter by severity'),
        auto_block_only: z.boolean().optional().describe('learnings: only auto-blocking rules'),
        filter: z.enum(['all', 'actionable']).optional()
            .describe('todos: "actionable" shows only unblocked unresolved items'),
        status: z.enum(['pending', 'promoted', 'rejected', 'dropped', 'all']).optional()
            .describe('extractions: filter by extraction status (default: pending)'),
        limit: z.number().optional(),
    }, async (input) => {
        const db = getDb();
        let result;
        if (input.type === 'decisions') {
            result = decisions.listDecisions({ category: input.category, limit: input.limit });
        }
        else if (input.type === 'errors') {
            result = errors.listErrors({ severity: input.severity, limit: input.limit });
        }
        else if (input.type === 'learnings') {
            result = learnings.listLearnings({ autoBlockOnly: input.auto_block_only, limit: input.limit ?? 50 });
        }
        else if (input.type === 'todos') {
            result = unfinished.listUnfinished({ limit: input.limit, filter: input.filter });
        }
        else if (input.type === 'notes') {
            result = db.prepare(`SELECT * FROM notes WHERE 1=1 ORDER BY created_at DESC LIMIT ?`).all(input.limit ?? 50);
        }
        else if (input.type === 'extractions') {
            result = extractions.listExtractions({ status: input.status ?? 'pending', limit: input.limit });
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('cortex_resolve', 'Close/update an item: mark todo resolved, decision reviewed, or update an error', {
        type: z.enum(['todo', 'decision', 'error', 'extraction']),
        id: z.number(),
        fix_description: z.string().optional(),
        prevention_rule: z.string().optional(),
        severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        action: z.enum(['promote', 'reject']).optional()
            .describe('extraction: promote to real entry or reject'),
        session_id: z.string().optional(),
    }, async (input) => {
        getDb();
        if (input.type === 'todo') {
            touchMemory('unfinished', input.id);
            const result = unfinished.resolveUnfinished(input.id, input.session_id);
            const unblocked = result.newly_unblocked;
            const note = unblocked.length > 0
                ? `\n${unblocked.length} dependent todo(s) may now be actionable: ${unblocked.map((u) => `#${u.id}`).join(', ')}`
                : '';
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            resolved: true,
                            item: result.item,
                            newly_unblocked: unblocked,
                            message: `Todo #${input.id} resolved.${note}`,
                        }, null, 2),
                    }],
            };
        }
        if (input.type === 'decision') {
            touchMemory('decisions', input.id);
            getDb().prepare(`UPDATE decisions SET stale=0, reviewed_at=datetime('now') WHERE id=?`).run(input.id);
            return { content: [{ type: 'text', text: `Decision ${input.id} marked as reviewed.` }] };
        }
        if (input.type === 'error') {
            touchMemory('errors', input.id);
            const err = errors.updateError({
                id: input.id,
                fix_description: input.fix_description,
                prevention_rule: input.prevention_rule,
                severity: input.severity,
            });
            return { content: [{ type: 'text', text: JSON.stringify(err, null, 2) }] };
        }
        if (input.type === 'extraction') {
            try {
                const action = input.action ?? 'promote';
                if (action === 'reject') {
                    extractions.rejectExtraction(input.id);
                    return { content: [{ type: 'text', text: `Extraction #${input.id} rejected.` }] };
                }
                const result = extractions.promoteExtraction(input.id);
                return {
                    content: [{
                            type: 'text',
                            text: `Extraction #${input.id} promoted to ${result.type} #${result.targetId}.`,
                        }],
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { content: [{ type: 'text', text: `Error: ${message}` }] };
            }
        }
        return { content: [{ type: 'text', text: `Unknown type: ${input.type}` }] };
    });
    server.tool('cortex_snooze', 'Set a reminder for a future session', {
        description: z.string(),
        until: z.string().describe('Relative: 3d / 1w  or  ISO date: 2026-03-01'),
        session_id: z.string().optional(),
    }, async ({ description, until, session_id }) => {
        let d = new Date();
        if (/^\d+d$/i.test(until))
            d.setDate(d.getDate() + parseInt(until));
        else if (/^\d+w$/i.test(until))
            d.setDate(d.getDate() + parseInt(until) * 7);
        else
            d = new Date(until);
        getDb().prepare(`INSERT INTO unfinished (description,context,priority,session_id,snooze_until,created_at) VALUES (?,?,?,?,?,datetime('now'))`).run(description, 'snoozed', 'medium', session_id ?? null, d.toISOString());
        return { content: [{ type: 'text', text: `Reminder set for ${d.toISOString().slice(0, 10)}` }] };
    });
    server.tool('cortex_reindex_embeddings', 'Build or refresh vector embeddings for semantic search over existing memory.', {
        limit_per_type: z.number().optional().describe('Max items per entity type (default: 300)'),
        force: z.boolean().optional().describe('Re-embed even if embedding already exists'),
        include_resolved_todos: z.boolean().optional().describe('Include resolved unfinished items'),
    }, async ({ limit_per_type, force, include_resolved_todos }) => {
        getDb();
        const before = getEmbeddingCount();
        const result = await backfillEmbeddings({
            limitPerType: limit_per_type ?? 300,
            force: force ?? false,
            includeResolvedTodos: include_resolved_todos ?? false,
        });
        const after = getEmbeddingCount();
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        before_count: before,
                        after_count: after,
                        ...result,
                        hint: 'Use cortex_search for semantic context queries.',
                    }, null, 2),
                }],
        };
    });
    // Intern: von Hooks aufgerufen
    server.tool('cortex_save_session', 'Save or update a session (used by hooks)', {
        session_id: z.string(),
        summary: z.string().optional(),
        key_changes: z.array(z.object({
            file: z.string(),
            action: z.string(),
            description: z.string(),
        })).optional(),
        status: z.enum(['active', 'completed', 'abandoned']).optional(),
    }, async ({ session_id, summary, key_changes, status }) => {
        getDb();
        sessions.createSession({ id: session_id });
        if (!status || status === 'active') {
            try {
                runAllPruning();
            }
            catch { /* ignore */ }
        }
        const session = sessions.updateSession(session_id, {
            summary,
            key_changes: key_changes,
            status,
            ended_at: status === 'completed' ? new Date().toISOString() : undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
    });
} // Ende registerCoreTools
//# sourceMappingURL=core.js.map