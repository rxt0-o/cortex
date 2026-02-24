type EntityType = 'decision' | 'error' | 'learning' | 'note' | 'session' | 'todo';
export interface BackfillEmbeddingsResult {
    scanned: number;
    embedded: number;
    skipped: number;
    errors: number;
    byType: Record<EntityType, number>;
}
/**
 * Generate embedding vector for text.
 */
export declare function embed(text: string): Promise<Float32Array>;
/**
 * Cosine similarity between two normalized vectors (= dot product).
 */
export declare function cosineSimilarity(a: Float32Array, b: Float32Array): number;
/**
 * Store an embedding in the database.
 */
export declare function storeEmbedding(entityType: string, entityId: string | number, embedding: Float32Array, model?: string): void;
/**
 * Get all stored embeddings.
 */
export declare function getAllEmbeddings(): Array<{
    entity_type: string;
    entity_id: string;
    embedding: Float32Array;
}>;
/**
 * Find similar entities by embedding cosine similarity.
 */
export declare function findSimilar(queryText: string, limit?: number): Promise<Array<{
    entity_type: string;
    entity_id: string;
    score: number;
}>>;
/**
 * Build combined text for embedding (max ~512 chars to stay in model sweet spot).
 */
export declare function buildEmbeddingText(fields: Record<string, unknown>): string;
export declare function getEmbeddingCount(): number;
/**
 * Check if embeddings table is available and has data.
 */
export declare function isAvailable(): boolean;
/**
 * Check if text is a near-duplicate of existing memory (similarity >= threshold).
 * Returns the most similar match if above threshold, null otherwise.
 */
export declare function isDuplicate(text: string, threshold?: number): Promise<{
    entity_type: string;
    entity_id: string;
    score: number;
} | null>;
export declare function backfillEmbeddings(options?: {
    limitPerType?: number;
    force?: boolean;
    includeResolvedTodos?: boolean;
}): Promise<BackfillEmbeddingsResult>;
export {};
//# sourceMappingURL=embeddings.d.ts.map