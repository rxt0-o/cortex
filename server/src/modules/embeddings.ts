import { getDb } from '../db.js';

let pipeline: any = null;

/**
 * Lazy-load the embedding pipeline. First call takes ~2-3s (model download + init).
 * Uses all-MiniLM-L6-v2 (384-dimensional, ~22MB).
 */
async function getPipeline(): Promise<any> {
  if (pipeline) return pipeline;

  const { pipeline: createPipeline } = await import('@huggingface/transformers');
  pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'fp32',
  });
  return pipeline;
}

/**
 * Generate embedding vector for text.
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Cosine similarity between two normalized vectors (= dot product).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Store an embedding in the database.
 */
export function storeEmbedding(
  entityType: string,
  entityId: string | number,
  embedding: Float32Array,
  model = 'all-MiniLM-L6-v2'
): void {
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
export function getAllEmbeddings(): Array<{
  entity_type: string;
  entity_id: string;
  embedding: Float32Array;
}> {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT entity_type, entity_id, embedding FROM embeddings').all() as any[];
    return rows.map((r) => ({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      embedding: new Float32Array(new Uint8Array(r.embedding).buffer),
    }));
  } catch {
    return [];
  }
}

/**
 * Find similar entities by embedding cosine similarity.
 */
export async function findSimilar(
  queryText: string,
  limit = 15
): Promise<Array<{ entity_type: string; entity_id: string; score: number }>> {
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
export function buildEmbeddingText(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [, value] of Object.entries(fields)) {
    if (value && typeof value === 'string') {
      parts.push(value);
    }
  }
  return parts.join(' ').slice(0, 512);
}

/**
 * Check if embeddings table is available and has data.
 */
export function isAvailable(): boolean {
  const db = getDb();
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as any;
    return row.c > 0;
  } catch {
    return false;
  }
}
