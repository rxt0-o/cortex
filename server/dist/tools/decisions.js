import { z } from 'zod';
import { getDb } from '../db.js';
import * as decisions from '../modules/decisions.js';
export function registerDecisionTools(server) {
    server.tool('cortex_add_decision', 'Log an architectural or design decision with reasoning', {
        title: z.string().describe('Short title of the decision. Example: "Use SQLite for local persistence" or "Adopt BM25/FTS5 for full-text search"'),
        reasoning: z.string().describe('WHY this decision was made. Include trade-offs and context. Example: "SQLite is embedded, zero-config, and sufficient for single-user local tool. Postgres would add deployment complexity."'),
        category: z.enum(['architecture', 'convention', 'bugfix', 'feature', 'config', 'security']).describe('Category: architecture=structural choices, convention=code style, bugfix=fix rationale, feature=new functionality, config=settings/env, security=security choices'),
        files_affected: z.array(z.string()).optional().describe('File paths affected by this decision. Example: ["server/src/db.ts", "scripts/ensure-db.js"]'),
        alternatives: z.array(z.object({
            option: z.string().describe('Alternative that was considered. Example: "Use PostgreSQL"'),
            reason_rejected: z.string().describe('Why this alternative was rejected. Example: "Too heavy for local single-user tool"'),
        })).optional(),
        session_id: z.string().optional(),
        confidence: z.enum(['high', 'medium', 'low']).optional().describe('Confidence level: high=certain, medium=likely good, low=experimental/uncertain'),
    }, async (input) => {
        getDb();
        const { decision, duplicate } = decisions.addDecision(input);
        let text = 'Decision saved (id: ' + decision.id + ')';
        if (duplicate) {
            text += '\nWarning: Possible duplicate of Decision #' + duplicate.id +
                ' (' + duplicate.score + '% similar): "' + duplicate.title + '"';
        }
        return { content: [{ type: 'text', text }] };
    });
    server.tool('cortex_list_decisions', 'List architectural decisions, optionally filtered by category', {
        category: z.string().optional(),
        limit: z.number().optional(),
        include_notes: z.boolean().optional().describe('If true, include linked notes for each decision'),
    }, async (input) => {
        const db = getDb();
        const result = decisions.listDecisions({ category: input.category, limit: input.limit });
        if (input.include_notes) {
            for (const d of result) {
                d.notes = db.prepare(`SELECT id, text, created_at FROM notes WHERE entity_type='decision' AND entity_id=? ORDER BY created_at DESC`).all(d.id);
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('cortex_mark_decision_reviewed', 'Mark a decision as reviewed / still current (resets stale flag)', { id: z.number() }, async ({ id }) => {
        getDb().prepare(`UPDATE decisions SET stale=0, reviewed_at=datetime('now') WHERE id=?`).run(id);
        return { content: [{ type: 'text', text: `Decision ${id} marked as reviewed.` }] };
    });
}
//# sourceMappingURL=decisions.js.map