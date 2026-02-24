import { getNeighbors } from './associations.js';
import { getDb } from '../db.js';
const DECAY_FACTOR = 0.5;
const MAX_HOPS = 3;
const ACTIVATION_THRESHOLD = 0.1;
/**
 * Spreading Activation algorithm (BFS with visited-set).
 *
 * 1. Seed nodes activated at 1.0
 * 2. BFS over memory_associations
 * 3. For each edge where target NOT in visited:
 *    target.activation += source.activation * edge.strength * decay_factor
 * 4. decay_factor = 0.5 per hop
 * 5. Max 3 hops, threshold >= 0.1
 * 6. Result: all activated nodes sorted by activation
 *
 * visited-set is mandatory to prevent circular activation (A->B->A cycles).
 */
export function spreadingActivation(seeds) {
    const activations = new Map();
    const visited = new Set();
    // Initialize seeds
    const queue = [];
    for (const seed of seeds) {
        const key = `${seed.type}:${seed.id}`;
        activations.set(key, 1.0);
        visited.add(key);
        queue.push({ ...seed, activation: 1.0, hop: 0 });
    }
    // BFS
    while (queue.length > 0) {
        const current = queue.shift();
        if (current.hop >= MAX_HOPS)
            continue;
        const neighbors = getNeighbors(current.type, current.id);
        for (const neighbor of neighbors) {
            const key = `${neighbor.type}:${neighbor.id}`;
            if (visited.has(key))
                continue;
            const propagatedActivation = current.activation * neighbor.strength * DECAY_FACTOR;
            if (propagatedActivation < ACTIVATION_THRESHOLD)
                continue;
            visited.add(key);
            const existingActivation = activations.get(key) ?? 0;
            const newActivation = existingActivation + propagatedActivation;
            activations.set(key, newActivation);
            queue.push({
                type: neighbor.type,
                id: neighbor.id,
                activation: newActivation,
                hop: current.hop + 1,
            });
        }
    }
    // Convert to result, excluding seeds
    const seedKeys = new Set(seeds.map(s => `${s.type}:${s.id}`));
    const result = [];
    for (const [key, activation] of activations) {
        if (seedKeys.has(key))
            continue;
        if (activation < ACTIVATION_THRESHOLD)
            continue;
        const [type, idStr] = key.split(':');
        result.push({ type, id: Number(idStr), activation });
    }
    result.sort((a, b) => b.activation - a.activation);
    return result;
}
/**
 * Get activated nodes for a set of files (via file-related entities).
 */
export function activateForFiles(files) {
    if (!files || files.length === 0)
        return [];
    const db = getDb();
    const seeds = [];
    for (const file of files.slice(0, 5)) {
        // Find errors related to this file
        try {
            const rows = db.prepare(`
        SELECT id FROM errors
        WHERE files_involved LIKE ? AND archived_at IS NULL
        ORDER BY last_seen DESC LIMIT 3
      `).all(`%${file}%`);
            for (const row of rows)
                seeds.push({ type: 'error', id: row.id });
        }
        catch { /* skip */ }
        // Find decisions related to this file
        try {
            const rows = db.prepare(`
        SELECT id FROM decisions
        WHERE files_affected LIKE ? AND archived_at IS NULL
        ORDER BY created_at DESC LIMIT 3
      `).all(`%${file}%`);
            for (const row of rows)
                seeds.push({ type: 'decision', id: row.id });
        }
        catch { /* skip */ }
    }
    if (seeds.length === 0)
        return [];
    return spreadingActivation(seeds);
}
//# sourceMappingURL=activation.js.map