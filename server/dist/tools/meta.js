import { z } from 'zod';
import { getDb } from '../db.js';
import { getToolGuidance, VALID_CATEGORIES } from '../modules/tool-registry.js';
export function registerMetaTools(server) {
    server.tool('cortex_load_tools', 'Get detailed usage guidance for one or more Cortex tool categories. Call this before using tools in an unfamiliar category.', {
        categories: z.array(z.string().describe(`Category name. Valid values: ${VALID_CATEGORIES.join(', ')}`)).describe('List of categories to load guidance for. Example: ["memory", "decisions"]'),
    }, async ({ categories }) => {
        getDb();
        try {
            const guidance = getToolGuidance(categories);
            return { content: [{ type: 'text', text: guidance }] };
        }
        catch (err) {
            return { content: [{ type: 'text', text: err.message }] };
        }
    });
}
//# sourceMappingURL=meta.js.map