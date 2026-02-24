import { getDb } from '../db.js';
/**
 * Content tables that support memory_strength decay.
 * Each entry defines the table name and its immunity conditions.
 */
const DECAY_TABLES = [
    { table: 'decisions', dateCol: 'created_at' },
    { table: 'errors', dateCol: 'first_seen' },
    { table: 'learnings', dateCol: 'created_at', extraImmunity: 'AND core_memory != 1 AND auto_block != 1' },
    { table: 'notes', dateCol: 'created_at' },
    { table: 'unfinished', dateCol: 'created_at' },
];
/**
 * Run Ebbinghaus decay on all content tables.
 *
 * Formula (absolute, not cumulative):
 *   strength(t) = EXP(-t / half_life)
 *   half_life = 7 * (1 + 0.5 * access_count)
 *   t = days since last_accessed (or created_at fallback)
 *
 * Immunity:
 *   - memory_strength IS NULL (explicitly pinned)
 *   - core_memory = 1 (learnings only)
 *   - auto_block = 1 (learnings only)
 *
 * @param maxTables - Max tables to process per call (round-robin for large DBs)
 * @param startIndex - Starting table index for round-robin
 * @returns Next startIndex for round-robin continuation
 */
export function runDecay(maxTables = 5, startIndex = 0) {
    const db = getDb();
    for (let i = 0; i < Math.min(maxTables, DECAY_TABLES.length); i++) {
        const idx = (startIndex + i) % DECAY_TABLES.length;
        const { table, dateCol, extraImmunity } = DECAY_TABLES[idx];
        const immunity = extraImmunity ?? '';
        try {
            db.prepare(`
        UPDATE ${table} SET memory_strength = EXP(
          -CAST((julianday('now') - julianday(COALESCE(last_accessed, ${dateCol}))) AS REAL)
          / (7.0 * (1.0 + 0.5 * COALESCE(access_count, 0)))
        )
        WHERE memory_strength IS NOT NULL
          AND memory_strength > 0.01
          AND archived_at IS NULL
          ${immunity}
      `).run();
        }
        catch {
            // Table may not have all columns on older DBs — skip gracefully.
        }
    }
    return (startIndex + Math.min(maxTables, DECAY_TABLES.length)) % DECAY_TABLES.length;
}
/**
 * Refresh memory_strength on access — resets to 1.0 and increments access_count.
 * Called by cortex_context, cortex_search, cortex_list when items are accessed.
 */
export function touchMemory(table, id) {
    const db = getDb();
    try {
        db.prepare(`
      UPDATE ${table}
      SET memory_strength = 1.0,
          access_count = COALESCE(access_count, 0) + 1,
          last_accessed = datetime('now')
      WHERE id = ?
    `).run(id);
    }
    catch {
        // Graceful skip if table/columns don't exist.
    }
}
/**
 * Get decay stats for monitoring.
 */
export function getDecayStats() {
    const db = getDb();
    const stats = [];
    for (const { table } of DECAY_TABLES) {
        try {
            const total = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE archived_at IS NULL`).get().c;
            const strong = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE archived_at IS NULL AND memory_strength >= 0.1`).get().c;
            const weak = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE archived_at IS NULL AND memory_strength IS NOT NULL AND memory_strength < 0.1`).get().c;
            const pinned = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE memory_strength IS NULL`).get().c;
            stats.push({ table, total, strong, weak, pinned });
        }
        catch {
            // Skip tables that don't exist yet.
        }
    }
    return stats;
}
//# sourceMappingURL=decay.js.map