import { z } from 'zod';
import { getDb } from '../db.js';
import * as errors from '../modules/errors.js';
import * as unfinished from '../modules/unfinished.js';
import * as sessions from '../modules/sessions.js';
import { runAllPruning } from '../helpers.js';
export function registerResolveTools(server) {
    server.tool('cortex_resolve', 'Close/update an item: mark todo resolved, decision reviewed, or update an error', {
        type: z.enum(['todo', 'decision', 'error']),
        id: z.number(),
        fix_description: z.string().optional(),
        prevention_rule: z.string().optional(),
        severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        session_id: z.string().optional(),
    }, async (input) => {
        getDb();
        if (input.type === 'todo') {
            const item = unfinished.resolveUnfinished(input.id, input.session_id);
            return { content: [{ type: 'text', text: JSON.stringify({ resolved: true, item }, null, 2) }] };
        }
        if (input.type === 'decision') {
            getDb().prepare(`UPDATE decisions SET stale=0, reviewed_at=datetime('now') WHERE id=?`).run(input.id);
            return { content: [{ type: 'text', text: `Decision ${input.id} marked as reviewed.` }] };
        }
        if (input.type === 'error') {
            const err = errors.updateError({
                id: input.id,
                fix_description: input.fix_description,
                prevention_rule: input.prevention_rule,
                severity: input.severity,
            });
            return { content: [{ type: 'text', text: JSON.stringify(err, null, 2) }] };
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
}
//# sourceMappingURL=core-resolve.js.map