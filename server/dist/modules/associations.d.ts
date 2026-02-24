export interface Association {
    id: number;
    source_type: string;
    source_id: number;
    target_type: string;
    target_id: number;
    relation: string;
    strength: number;
    last_activated: string;
    created_at: string;
}
/**
 * Create an association between two memory items (INSERT OR IGNORE).
 */
export declare function createAssociation(params: {
    sourceType: string;
    sourceId: number;
    targetType: string;
    targetId: number;
    relation: string;
    strength?: number;
}): void;
/**
 * Get all associations for a given entity (as source or target).
 */
export declare function getAssociations(entityType: string, entityId: number): Association[];
/**
 * Get outgoing associations from a specific entity.
 */
export declare function getOutgoing(entityType: string, entityId: number): Association[];
/**
 * Get all edges (both directions) for BFS traversal.
 */
export declare function getNeighbors(entityType: string, entityId: number): Array<{
    type: string;
    id: number;
    relation: string;
    strength: number;
}>;
/**
 * Auto-create associations when a new item is stored via cortex_store.
 * Creates same-session and same-file associations.
 */
export declare function autoCreateAssociations(params: {
    entityType: string;
    entityId: number;
    sessionId?: string;
    files?: string[];
}): number;
/**
 * Auto-create semantic associations for a new item (async, fire-and-forget).
 * Links items with embedding cosine similarity >= 0.8.
 */
export declare function autoCreateSemanticAssociations(params: {
    entityType: string;
    entityId: number;
    embeddingText: string;
}): Promise<number>;
/**
 * Get association count for monitoring.
 */
export declare function getAssociationCount(): number;
//# sourceMappingURL=associations.d.ts.map