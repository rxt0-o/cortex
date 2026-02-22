import { z } from 'zod';
import { getDb } from '../db.js';
import * as sessions from '../modules/sessions.js';
import * as errors from '../modules/errors.js';
import * as learnings from '../modules/learnings.js';
import * as unfinished from '../modules/unfinished.js';
import * as health from '../modules/health.js';
import * as projectMap from '../modules/project-map.js';
import { runAllPruning } from '../helpers.js';
export function registerSessionTools(server) {
    server.tool('cortex_save_session', 'Save or update a session with summary, changes, decisions, errors, and learnings', {
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
        // Auto-pruning beim Session-Start (Ebbinghaus-Forgetting-Curve)
        if (!status || status === 'active') {
            try {
                runAllPruning();
            }
            catch { /* Pruning-Fehler blockieren Session-Start nicht */ }
        }
        const session = sessions.updateSession(session_id, {
            summary,
            key_changes: key_changes,
            status,
            ended_at: status === 'completed' ? new Date().toISOString() : undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
    });
    server.tool('cortex_list_sessions', 'List recent sessions with summaries', {
        limit: z.number().optional(),
        chain_id: z.string().optional(),
        tag: z.string().optional(),
    }, async ({ limit, chain_id, tag }) => {
        getDb();
        let result = sessions.listSessions(limit ?? 20, chain_id);
        if (tag) {
            result = result.filter(s => s.tags?.includes(tag));
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('cortex_search', 'Full-text search across all Cortex data: sessions, decisions, errors, learnings', {
        query: z.string(),
        limit: z.number().optional(),
    }, async ({ query, limit }) => {
        const db = getDb();
        const maxResults = limit ?? 10;
        const lines = [];
        function ftsSearch(ftsTable, labelFn, prefix) {
            try {
                const rows = db.prepare('SELECT rowid, * FROM ' + ftsTable + ' WHERE ' + ftsTable + ' MATCH ? ORDER BY bm25(' + ftsTable + ') LIMIT ?').all(query, maxResults);
                for (const r of rows)
                    lines.push(prefix + ' ' + labelFn(r));
            }
            catch { }
        }
        ftsSearch('learnings_fts', r => r.anti_pattern, '[LEARNING]');
        ftsSearch('decisions_fts', r => r.title, '[DECISION]');
        ftsSearch('errors_fts', r => r.error_message, '[ERROR]');
        ftsSearch('notes_fts', r => String(r.text).slice(0, 120), '[NOTE]');
        try {
            const sr = db.prepare("SELECT summary FROM sessions WHERE summary LIKE ? AND status != 'active' ORDER BY started_at DESC LIMIT ?").all('%' + query + '%', maxResults);
            for (const s of sr)
                lines.push('[SESSION] ' + s.summary);
        }
        catch { }
        try {
            const ur = db.prepare('SELECT description FROM unfinished WHERE description LIKE ? AND resolved_at IS NULL LIMIT ?').all('%' + query + '%', maxResults);
            for (const u of ur)
                lines.push('[TODO] ' + u.description);
        }
        catch { }
        return { content: [{ type: 'text', text: lines.join('\n') || 'No results.' }] };
    });
    server.tool('cortex_get_context', 'Get relevant context for specific files or the current work', {
        files: z.array(z.string()).optional(),
    }, async ({ files }) => {
        getDb();
        const context = {};
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
        return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
    });
}
//# sourceMappingURL=sessions.js.map