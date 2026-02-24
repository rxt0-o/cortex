import { getDb } from '../db.js';
/**
 * Importance scoring dimensions (v1).
 * Repetition is deferred to v2 (O(n^2), embedding-based dedup is sufficient).
 */
const WEIGHTS = {
    frequency: 0.15,
    recency: 0.25,
    impact: 0.30,
    surprise: 0.15,
    sentiment: 0.15,
};
/** Sentiment scores by entity type. */
const SENTIMENT_MAP = {
    error: 0.8,
    learning: 0.8,
    decision: 0.6,
    note: 0.3,
    unfinished: 0.5,
};
/** Cached surprise values per session (type -> surprise score). */
let surpriseCache = null;
let surpriseCacheSessionId = null;
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
export function computeImportance(params) {
    const { accessCount, lastAccessed, createdAt, priority, severity, entityType, sessionId } = params;
    // Frequency: min(access_count / 10, 1.0)
    const frequency = Math.min((accessCount || 0) / 10, 1.0);
    // Recency: e^(-days / 14)
    const refDate = lastAccessed || createdAt;
    const daysSince = refDate
        ? Math.max(0, (Date.now() - new Date(refDate).getTime()) / 86400000)
        : 30;
    const recency = Math.exp(-daysSince / 14);
    // Impact: from priority or severity
    const impactSource = priority || severity;
    let impact = 0.5;
    if (impactSource === 'high' || impactSource === 'critical')
        impact = 1.0;
    else if (impactSource === 'medium')
        impact = 0.6;
    else if (impactSource === 'low')
        impact = 0.3;
    // Surprise: 1.0 - (count_of_type / total_items), cached per session
    const surprise = getSurprise(entityType, sessionId);
    // Sentiment: type-based
    const sentiment = SENTIMENT_MAP[entityType] ?? 0.5;
    const score = WEIGHTS.frequency * frequency +
        WEIGHTS.recency * recency +
        WEIGHTS.impact * impact +
        WEIGHTS.surprise * surprise +
        WEIGHTS.sentiment * sentiment;
    return Math.round(score * 1000) / 1000;
}
/**
 * Get surprise value for an entity type (cached per session).
 */
function getSurprise(entityType, sessionId) {
    if (surpriseCache && surpriseCacheSessionId === (sessionId || '')) {
        return surpriseCache.get(entityType) ?? 0.5;
    }
    // Rebuild cache
    const db = getDb();
    surpriseCache = new Map();
    surpriseCacheSessionId = sessionId || '';
    const TABLE_MAP = {
        decision: 'decisions',
        error: 'errors',
        learning: 'learnings',
        note: 'notes',
        unfinished: 'unfinished',
    };
    let total = 0;
    const counts = {};
    for (const [type, table] of Object.entries(TABLE_MAP)) {
        try {
            const row = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE archived_at IS NULL`).get();
            counts[type] = row.c;
            total += row.c;
        }
        catch {
            counts[type] = 0;
        }
    }
    for (const [type, count] of Object.entries(counts)) {
        surpriseCache.set(type, total > 0 ? 1.0 - count / total : 0.5);
    }
    return surpriseCache.get(entityType) ?? 0.5;
}
/**
 * Refresh importance_score on all items of a given table.
 * Designed to run at session start (batch update).
 */
export function refreshImportanceScores(table, entityType, sessionId) {
    const db = getDb();
    const priorityCol = table === 'errors' ? 'severity' : 'priority';
    const dateCol = table === 'errors' ? 'first_seen' : 'created_at';
    let rows;
    try {
        rows = db.prepare(`
      SELECT id, COALESCE(access_count, 0) as access_count,
             last_accessed, ${dateCol} as created_at,
             ${table === 'notes' ? `'medium' as ${priorityCol}` : priorityCol}
      FROM ${table}
      WHERE archived_at IS NULL
      LIMIT 500
    `).all();
    }
    catch {
        return 0;
    }
    const updateStmt = db.prepare(`UPDATE ${table} SET importance_score = ? WHERE id = ?`);
    let updated = 0;
    for (const row of rows) {
        const score = computeImportance({
            accessCount: row.access_count,
            lastAccessed: row.last_accessed,
            createdAt: row.created_at,
            priority: row[priorityCol],
            entityType,
            sessionId,
        });
        try {
            updateStmt.run(score, row.id);
            updated++;
        }
        catch {
            // Skip individual failures.
        }
    }
    return updated;
}
/**
 * Clear the surprise cache (call at session boundary).
 */
export function clearImportanceCache() {
    surpriseCache = null;
    surpriseCacheSessionId = null;
}
//# sourceMappingURL=importance.js.map