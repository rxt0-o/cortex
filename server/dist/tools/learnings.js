import { z } from 'zod';
import { getDb } from '../db.js';
import * as learnings from '../modules/learnings.js';
import * as conventions from '../modules/conventions.js';
import * as errors from '../modules/errors.js';
export function registerLearningTools(server) {
    server.tool('cortex_add_learning', 'Record an anti-pattern and its correct alternative, optionally with auto-blocking regex', {
        anti_pattern: z.string().describe('The bad pattern to avoid. Example: "Using db.prepare() inside a loop" or "Calling getDb() without checking if DB is initialized"'),
        correct_pattern: z.string().describe('The correct alternative to use instead. Example: "Prepare statements once outside the loop and reuse" or "Always call ensureDb() before getDb()"'),
        context: z.string().describe('When/where this applies. Example: "SQLite better-sqlite3 usage" or "Cortex server startup sequence"'),
        detection_regex: z.string().optional().describe('Regex to auto-detect this pattern in code. Example: "db\.prepare\(.*\).*\.run\(" or "for.*getDb\(\)"'),
        severity: z.enum(['low', 'medium', 'high']).optional().describe('Impact: low=minor quality issue, medium=likely bug, high=will cause failures'),
        auto_block: z.boolean().optional().describe('If true, cortex_check_regression will flag this pattern before every file edit'),
        session_id: z.string().optional(),
        batch: z.array(z.object({
            anti_pattern: z.string(),
            correct_pattern: z.string(),
            context: z.string(),
            detection_regex: z.string().optional(),
            severity: z.enum(['low', 'medium', 'high']).optional(),
            auto_block: z.boolean().optional(),
            session_id: z.string().optional(),
        })).optional().describe('Add multiple learnings at once. Example: [{anti_pattern: "foo", correct_pattern: "bar", context: "baz"}]'),
    }, async (input) => {
        if (input.batch && input.batch.length > 0) {
            getDb();
            const results = input.batch.map(item => learnings.addLearning(item));
            return { content: [{ type: 'text', text: JSON.stringify({ added: results.length, results: results.map(r => ({ id: r.learning.id, duplicate: !!r.duplicate })) }, null, 2) }] };
        }
        getDb();
        const { learning, duplicate } = learnings.addLearning(input);
        let text = 'Learning saved (id: ' + learning.id + ')';
        if (duplicate) {
            text += '\nWarning: Possible duplicate of Learning #' + duplicate.id +
                ' (' + duplicate.score + '% similar): "' + duplicate.anti_pattern + '"';
        }
        return { content: [{ type: 'text', text }] };
    });
    server.tool('cortex_update_learning', 'Update an existing learning/anti-pattern entry (e.g. add detection_regex, change severity, toggle auto_block)', {
        id: z.number(),
        anti_pattern: z.string().optional(),
        correct_pattern: z.string().optional(),
        detection_regex: z.string().nullable().optional(),
        context: z.string().optional(),
        severity: z.enum(['low', 'medium', 'high']).optional(),
        auto_block: z.boolean().optional(),
    }, async (input) => {
        getDb();
        const learning = learnings.updateLearning(input);
        return { content: [{ type: 'text', text: JSON.stringify(learning, null, 2) }] };
    });
    server.tool('cortex_delete_learning', 'Delete a learning/anti-pattern entry by ID', { id: z.number() }, async ({ id }) => {
        getDb();
        const success = learnings.deleteLearning(id);
        return { content: [{ type: 'text', text: JSON.stringify({ success, deleted_id: id }, null, 2) }] };
    });
    server.tool('cortex_list_learnings', 'List recorded anti-patterns and learnings', { auto_block_only: z.boolean().optional(), limit: z.number().optional(), include_notes: z.boolean().optional().describe('If true, include linked notes for each learning') }, async ({ auto_block_only, limit, include_notes }) => {
        const db = getDb();
        const result = learnings.listLearnings({ autoBlockOnly: auto_block_only, limit: limit ?? 50 });
        if (include_notes) {
            for (const l of result) {
                l.notes = db.prepare(`SELECT id, text, created_at FROM notes WHERE entity_type='learning' AND entity_id=? ORDER BY created_at DESC`).all(l.id);
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    server.tool('cortex_check_regression', 'Check if content would introduce a known regression or anti-pattern', {
        file_path: z.string(),
        content: z.string(),
    }, async ({ file_path, content }) => {
        getDb();
        const warnings = [];
        // Check against learnings
        const learningMatches = learnings.checkContentAgainstLearnings(content);
        for (const m of learningMatches) {
            warnings.push({
                type: 'anti-pattern',
                message: `Anti-pattern: "${m.learning.anti_pattern}" → Use: "${m.learning.correct_pattern}"`,
                severity: m.learning.severity,
            });
        }
        // Check against conventions
        const conventionMatches = conventions.checkContentAgainstConventions(content);
        for (const m of conventionMatches) {
            warnings.push({
                type: 'convention-violation',
                message: `Convention "${m.convention.name}": ${m.convention.description}`,
                severity: 'warning',
            });
        }
        // Check against error prevention rules
        const preventionRules = errors.getPreventionRules();
        for (const rule of preventionRules) {
            try {
                if (new RegExp(rule.prevention_rule, 'm').test(content)) {
                    warnings.push({
                        type: 'regression',
                        message: `This pattern caused Error #${rule.id}: "${rule.error_message}"`,
                        severity: 'error',
                    });
                }
            }
            catch {
                // Invalid regex
            }
        }
        return {
            content: [{
                    type: 'text',
                    text: warnings.length > 0
                        ? JSON.stringify({ blocked: warnings.some(w => w.severity === 'error'), warnings }, null, 2)
                        : '{"blocked": false, "warnings": []}',
                }],
        };
    });
}
//# sourceMappingURL=learnings.js.map