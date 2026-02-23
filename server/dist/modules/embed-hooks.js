import { embed, storeEmbedding, buildEmbeddingText } from './embeddings.js';
/**
 * Fire-and-forget embedding generation.
 * Errors are silently ignored (best-effort).
 */
export function embedAsync(entityType, entityId, fields) {
    const text = buildEmbeddingText(fields);
    if (!text || text.length < 10)
        return;
    embed(text)
        .then((vec) => storeEmbedding(entityType, entityId, vec))
        .catch(() => { });
}
//# sourceMappingURL=embed-hooks.js.map