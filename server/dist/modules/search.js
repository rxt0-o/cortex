import { getDb } from '../db.js';
const FTS_CONFIGS = [
    {
        type: 'learning',
        ftsTable: 'learnings_fts',
        sourceTable: 'learnings',
        joinColumn: 'id',
        titleFn: (r) => r.anti_pattern,
        snippetColumns: ['anti_pattern', 'correct_pattern', 'context'],
        metadataFn: (r) => ({ severity: r.severity, auto_block: Boolean(r.auto_block) }),
        createdAtColumn: 'created_at',
    },
    {
        type: 'decision',
        ftsTable: 'decisions_fts',
        sourceTable: 'decisions',
        joinColumn: 'id',
        titleFn: (r) => r.title,
        snippetColumns: ['title', 'reasoning'],
        metadataFn: (r) => ({ category: r.category, confidence: r.confidence }),
        createdAtColumn: 'created_at',
    },
    {
        type: 'error',
        ftsTable: 'errors_fts',
        sourceTable: 'errors',
        joinColumn: 'id',
        titleFn: (r) => r.error_message,
        snippetColumns: ['error_message', 'root_cause', 'fix_description'],
        metadataFn: (r) => ({ severity: r.severity, occurrences: r.occurrences }),
        createdAtColumn: 'first_seen',
    },
    {
        type: 'note',
        ftsTable: 'notes_fts',
        sourceTable: 'notes',
        joinColumn: 'id',
        titleFn: (r) => String(r.text).slice(0, 80),
        snippetColumns: ['text'],
        metadataFn: (r) => ({ tags: r.tags }),
        createdAtColumn: 'created_at',
    },
    {
        type: 'session',
        ftsTable: 'sessions_fts',
        sourceTable: 'sessions',
        joinColumn: 'rowid',
        titleFn: (r) => r.summary ? String(r.summary).slice(0, 80) : r.id,
        snippetColumns: ['summary', 'key_changes'],
        metadataFn: (r) => ({ status: r.status }),
        createdAtColumn: 'started_at',
    },
    {
        type: 'todo',
        ftsTable: 'unfinished_fts',
        sourceTable: 'unfinished',
        joinColumn: 'id',
        titleFn: (r) => String(r.description).slice(0, 80),
        snippetColumns: ['description', 'context'],
        metadataFn: (r) => ({ priority: r.priority }),
        createdAtColumn: 'created_at',
    },
];
export { FTS_CONFIGS };
/**
 * Unified BM25 search across all entity types.
 * Returns results sorted by normalized BM25 score (cross-entity comparable).
 */
export function searchBm25(query, limit = 15) {
    const db = getDb();
    const allResults = [];
    for (const cfg of FTS_CONFIGS) {
        try {
            // bm25() returns negative values (closer to 0 = better match)
            const rows = db.prepare(`
        SELECT s.*, bm25(${cfg.ftsTable}) as bm25_score
        FROM ${cfg.sourceTable} s
        JOIN ${cfg.ftsTable} fts ON s.${cfg.joinColumn} = fts.rowid
        WHERE ${cfg.ftsTable} MATCH ?
        ORDER BY bm25(${cfg.ftsTable})
        LIMIT ?
      `).all(query, limit);
            for (const row of rows) {
                allResults.push({
                    type: cfg.type,
                    id: row.id,
                    score: -row.bm25_score, // flip to positive (higher = better)
                    title: cfg.titleFn(row),
                    snippet: buildSnippet(row, cfg.snippetColumns, query),
                    created_at: row[cfg.createdAtColumn] ?? null,
                    metadata: cfg.metadataFn(row),
                });
            }
        }
        catch {
            // FTS table not available — skip silently
        }
    }
    // Sort by score descending, take top N
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
}
const RRF_K = 60;
const EMBEDDING_ONLY_THRESHOLD = (() => {
    const parsed = Number.parseFloat(process.env.CORTEX_EMBEDDING_THRESHOLD ?? '0.28');
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1)
        return parsed;
    return 0.28;
})();
/**
 * Unified search: BM25 + Embedding similarity via RRF-Fusion.
 * Falls back to BM25-only when no embeddings are available.
 */
export async function searchAll(query, limit = 15) {
    const bm25Results = searchBm25(query, limit * 2);
    // Try embedding search (best-effort)
    let embResults = [];
    try {
        const { findSimilar, isAvailable } = await import('./embeddings.js');
        if (isAvailable()) {
            embResults = await findSimilar(query, limit * 2);
        }
    }
    catch {
        // No embeddings available — BM25 only
    }
    if (embResults.length === 0) {
        return bm25Results.slice(0, limit);
    }
    // RRF Fusion
    const rrfScores = new Map();
    // BM25 scores
    for (let rank = 0; rank < bm25Results.length; rank++) {
        const r = bm25Results[rank];
        const key = `${r.type}:${r.id}`;
        const rrfScore = 1 / (RRF_K + rank + 1);
        rrfScores.set(key, { score: rrfScore, result: r });
    }
    // Embedding scores
    for (let rank = 0; rank < embResults.length; rank++) {
        const e = embResults[rank];
        const key = `${e.entity_type}:${e.entity_id}`;
        const rrfScore = 1 / (RRF_K + rank + 1);
        const existing = rrfScores.get(key);
        if (existing) {
            // Both BM25 + embedding matched — add scores
            existing.score += rrfScore;
        }
        else if (e.score >= EMBEDDING_ONLY_THRESHOLD) {
            // Embedding-only result with decent similarity — resolve from DB
            const resolved = resolveEntity(e.entity_type, e.entity_id, query);
            if (resolved) {
                rrfScores.set(key, { score: rrfScore, result: resolved });
            }
        }
    }
    // Sort by RRF score
    const fused = Array.from(rrfScores.values())
        .filter((v) => v.result != null)
        .map((v) => ({ ...v.result, score: v.score }))
        .sort((a, b) => b.score - a.score);
    return fused.slice(0, limit);
}
/**
 * Resolve an entity from the database for embedding-only results.
 */
function resolveEntity(entityType, entityId, query) {
    const db = getDb();
    const cfg = FTS_CONFIGS.find((c) => c.type === entityType);
    if (!cfg)
        return null;
    try {
        const idColumn = entityType === 'session'
            ? 'id'
            : (cfg.joinColumn === 'rowid' ? 'rowid' : 'id');
        const idValue = entityType === 'session' ? entityId : Number(entityId);
        const row = db.prepare(`SELECT * FROM ${cfg.sourceTable} WHERE ${idColumn} = ?`).get(idValue);
        if (!row)
            return null;
        return {
            type: cfg.type,
            id: row.id ?? entityId,
            score: 0,
            title: cfg.titleFn(row),
            snippet: buildSnippet(row, cfg.snippetColumns, query),
            created_at: row[cfg.createdAtColumn] ?? null,
            metadata: cfg.metadataFn(row),
        };
    }
    catch {
        return null;
    }
}
/**
 * Build a snippet from the row, highlighting the query terms.
 * Picks the most relevant field (longest match context).
 */
function buildSnippet(row, columns, query) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let bestSnippet = '';
    let bestScore = -1;
    for (const col of columns) {
        const value = row[col];
        if (!value || typeof value !== 'string')
            continue;
        const lower = value.toLowerCase();
        const matchCount = queryTerms.filter(t => lower.includes(t)).length;
        if (matchCount > bestScore) {
            bestScore = matchCount;
            bestSnippet = extractContext(value, queryTerms, 150);
        }
    }
    return bestSnippet || '(no snippet)';
}
/**
 * Extract a ~maxLen character window around the first query term match.
 */
function extractContext(text, terms, maxLen) {
    const lower = text.toLowerCase();
    let firstMatch = text.length;
    for (const t of terms) {
        const idx = lower.indexOf(t);
        if (idx >= 0 && idx < firstMatch)
            firstMatch = idx;
    }
    if (firstMatch === text.length) {
        return text.length <= maxLen ? text : text.slice(0, maxLen) + '...';
    }
    const start = Math.max(0, firstMatch - 30);
    const end = Math.min(text.length, start + maxLen);
    let snippet = text.slice(start, end);
    if (start > 0)
        snippet = '...' + snippet;
    if (end < text.length)
        snippet = snippet + '...';
    return snippet;
}
/**
 * Format search results for MCP tool output.
 */
export function formatResults(results) {
    if (results.length === 0)
        return 'No results.';
    return results.map((r, i) => {
        const typeTag = `[${r.type.toUpperCase()}]`;
        const scoreTag = `(score: ${r.score.toFixed(2)})`;
        const age = r.created_at ? formatAge(r.created_at) : '';
        const meta = formatMeta(r);
        return `${i + 1}. ${typeTag} ${r.title}\n   ${scoreTag} ${age}${meta}\n   ${r.snippet}`;
    }).join('\n\n');
}
function formatAge(dateStr) {
    const ms = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(ms / 86400000);
    if (days === 0)
        return 'today ';
    if (days === 1)
        return '1d ago ';
    if (days < 7)
        return `${days}d ago `;
    if (days < 30)
        return `${Math.floor(days / 7)}w ago `;
    return `${Math.floor(days / 30)}mo ago `;
}
function formatMeta(r) {
    const parts = [];
    if (r.metadata.severity)
        parts.push(`severity:${r.metadata.severity}`);
    if (r.metadata.category)
        parts.push(`cat:${r.metadata.category}`);
    if (r.metadata.priority)
        parts.push(`prio:${r.metadata.priority}`);
    return parts.length > 0 ? `[${parts.join(', ')}] ` : '';
}
//# sourceMappingURL=search.js.map