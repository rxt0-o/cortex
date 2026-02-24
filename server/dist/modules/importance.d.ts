/**
 * Compute the 5-dimensional importance score for an item.
 *
 * Dimensions:
 *   Frequency (0.15): min(access_count / 10, 1.0)
 *   Recency (0.25):   e^(-days_since_access / 14)
 *   Impact (0.30):    manual (high=1.0, medium=0.6, low=0.3) or default 0.5
 *   Surprise (0.15):  1.0 - (count_of_type / total_items)
 *   Sentiment (0.15): type-based (error=0.8, decision=0.6, note=0.3)
 */
export declare function computeImportance(params: {
    accessCount: number;
    lastAccessed: string | null;
    createdAt: string;
    priority?: string | null;
    severity?: string | null;
    entityType: string;
    sessionId?: string;
}): number;
/**
 * Refresh importance_score on all items of a given table.
 * Designed to run at session start (batch update).
 */
export declare function refreshImportanceScores(table: string, entityType: string, sessionId?: string): number;
/**
 * Clear the surprise cache (call at session boundary).
 */
export declare function clearImportanceCache(): void;
//# sourceMappingURL=importance.d.ts.map