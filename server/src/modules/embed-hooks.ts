import { embed, storeEmbedding, buildEmbeddingText } from './embeddings.js';

/**
 * Fire-and-forget embedding generation.
 * Errors are silently ignored (best-effort).
 */
export function embedAsync(
  entityType: string,
  entityId: string | number,
  fields: Record<string, unknown>
): void {
  const text = buildEmbeddingText(fields);
  if (!text || text.length < 10) return;

  embed(text)
    .then((vec) => storeEmbedding(entityType, entityId, vec))
    .catch(() => { /* best-effort — ignore failures */ });
}
