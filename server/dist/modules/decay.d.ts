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
export declare function runDecay(maxTables?: number, startIndex?: number): number;
/**
 * Refresh memory_strength on access — resets to 1.0 and increments access_count.
 * Called by cortex_context, cortex_search, cortex_list when items are accessed.
 */
export declare function touchMemory(table: string, id: number): void;
/**
 * Get decay stats for monitoring.
 */
export declare function getDecayStats(): Array<{
    table: string;
    total: number;
    strong: number;
    weak: number;
    pinned: number;
}>;
//# sourceMappingURL=decay.d.ts.map