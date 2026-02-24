import { getDb } from '../db.js';
let pipeline = null;
/**
 * Lazy-load the embedding pipeline. First call takes ~2-3s (model download + init).
 * Uses all-MiniLM-L6-v2 (384-dimensional, ~22MB).
 */
async function getPipeline() {
    if (pipeline)
        return pipeline;
    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'fp32',
    });
    return pipeline;
}
/**
 * Generate embedding vector for text.
 */
export async function embed(text) {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
}
/**
 * Cosine similarity between two normalized vectors (= dot product).
 */
export function cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}
/**
 * Store an embedding in the database.
 */
export function storeEmbedding(entityType, entityId, embedding, model = 'all-MiniLM-L6-v2') {
    const db = getDb();
    const blob = Buffer.from(embedding.buffer);
    db.prepare(`
    INSERT OR REPLACE INTO embeddings (entity_type, entity_id, embedding, model, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(entityType, String(entityId), blob, model);
}
/**
 * Get all stored embeddings.
 */
export function getAllEmbeddings() {
    const db = getDb();
    try {
        const rows = db.prepare('SELECT entity_type, entity_id, embedding FROM embeddings').all();
        return rows.map((r) => ({
            entity_type: r.entity_type,
            entity_id: r.entity_id,
            embedding: new Float32Array(new Uint8Array(r.embedding).buffer),
        }));
    }
    catch {
        return [];
    }
}
/**
 * Find similar entities by embedding cosine similarity.
 */
export async function findSimilar(queryText, limit = 15) {
    const queryEmb = await embed(queryText);
    const all = getAllEmbeddings();
    const scored = all.map((row) => ({
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        score: cosineSimilarity(queryEmb, row.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}
/**
 * Build combined text for embedding (max ~512 chars to stay in model sweet spot).
 */
export function buildEmbeddingText(fields) {
    const parts = [];
    for (const [, value] of Object.entries(fields)) {
        if (typeof value === 'string' && value.trim().length > 0) {
            parts.push(value.trim());
            continue;
        }
        if (Array.isArray(value)) {
            const asText = value
                .filter((v) => typeof v === 'string')
                .join(' ')
                .trim();
            if (asText)
                parts.push(asText);
        }
    }
    return parts.join(' ').slice(0, 512);
}
export function getEmbeddingCount() {
    const db = getDb();
    try {
        const row = db.prepare('SELECT COUNT(*) as c FROM embeddings').get();
        return row.c ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * Check if embeddings table is available and has data.
 */
export function isAvailable() {
    return getEmbeddingCount() > 0;
}
/**
 * Check if text is a near-duplicate of existing memory (similarity >= threshold).
 * Returns the most similar match if above threshold, null otherwise.
 */
export async function isDuplicate(text, threshold = 0.92) {
    try {
        const results = await findSimilar(text, 1);
        if (results.length > 0 && results[0].score >= threshold) {
            return results[0];
        }
    }
    catch {
        // Embedding pipeline not available — skip dedup.
    }
    return null;
}
export async function backfillEmbeddings(options) {
    const db = getDb();
    const limit = options?.limitPerType ?? 300;
    const force = options?.force ?? false;
    const includeResolvedTodos = options?.includeResolvedTodos ?? false;
    const candidates = collectBackfillCandidates(db, limit, includeResolvedTodos);
    const existing = force ? new Set() : getExistingKeys(db);
    const result = {
        scanned: candidates.length,
        embedded: 0,
        skipped: 0,
        errors: 0,
        byType: {
            decision: 0,
            error: 0,
            learning: 0,
            note: 0,
            session: 0,
            todo: 0,
        },
    };
    for (const c of candidates) {
        const key = `${c.entity_type}:${c.entity_id}`;
        if (!force && existing.has(key)) {
            result.skipped++;
            continue;
        }
        try {
            const vec = await embed(c.text);
            storeEmbedding(c.entity_type, c.entity_id, vec);
            result.embedded++;
            result.byType[c.entity_type]++;
        }
        catch {
            result.errors++;
        }
    }
    return result;
}
function getExistingKeys(db) {
    try {
        const rows = db.prepare('SELECT entity_type, entity_id FROM embeddings').all();
        return new Set(rows.map((r) => `${r.entity_type}:${r.entity_id}`));
    }
    catch {
        return new Set();
    }
}
function collectBackfillCandidates(db, limitPerType, includeResolvedTodos) {
    const candidates = [];
    const decisions = db.prepare(`
    SELECT id, title, reasoning
    FROM decisions
    WHERE archived_at IS NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limitPerType);
    for (const row of decisions) {
        const text = buildEmbeddingText({ title: row.title, reasoning: row.reasoning });
        if (text.length >= 10)
            candidates.push({ entity_type: 'decision', entity_id: String(row.id), text });
    }
    const errors = db.prepare(`
    SELECT id, error_message, root_cause, fix_description
    FROM errors
    WHERE archived_at IS NULL
    ORDER BY last_seen DESC
    LIMIT ?
  `).all(limitPerType);
    for (const row of errors) {
        const text = buildEmbeddingText({
            error_message: row.error_message,
            root_cause: row.root_cause ?? '',
            fix_description: row.fix_description ?? '',
        });
        if (text.length >= 10)
            candidates.push({ entity_type: 'error', entity_id: String(row.id), text });
    }
    const learnings = db.prepare(`
    SELECT id, anti_pattern, correct_pattern, context
    FROM learnings
    WHERE archived_at IS NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limitPerType);
    for (const row of learnings) {
        const text = buildEmbeddingText({
            anti_pattern: row.anti_pattern,
            correct_pattern: row.correct_pattern,
            context: row.context,
        });
        if (text.length >= 10)
            candidates.push({ entity_type: 'learning', entity_id: String(row.id), text });
    }
    const notes = db.prepare(`
    SELECT id, text
    FROM notes
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limitPerType);
    for (const row of notes) {
        const text = buildEmbeddingText({ text: row.text });
        if (text.length >= 10)
            candidates.push({ entity_type: 'note', entity_id: String(row.id), text });
    }
    const sessions = db.prepare(`
    SELECT id, summary, key_changes
    FROM sessions
    WHERE summary IS NOT NULL
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limitPerType);
    for (const row of sessions) {
        const text = buildEmbeddingText({
            summary: row.summary ?? '',
            key_changes: row.key_changes ?? '',
        });
        if (text.length >= 10)
            candidates.push({ entity_type: 'session', entity_id: row.id, text });
    }
    const todoWhere = includeResolvedTodos ? '' : 'WHERE resolved_at IS NULL';
    const todos = db.prepare(`
    SELECT id, description, context
    FROM unfinished
    ${todoWhere}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limitPerType);
    for (const row of todos) {
        const text = buildEmbeddingText({
            description: row.description,
            context: row.context ?? '',
        });
        if (text.length >= 10)
            candidates.push({ entity_type: 'todo', entity_id: String(row.id), text });
    }
    return candidates;
}
//# sourceMappingURL=embeddings.js.map