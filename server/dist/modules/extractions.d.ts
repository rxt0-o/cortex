export interface Extraction {
    id: number;
    session_id: string;
    type: string;
    content: string;
    confidence: number;
    status: string;
    source_context: string | null;
    promoted_to_type: string | null;
    promoted_to_id: number | null;
    created_at: string;
}
/**
 * List pending or all auto-extractions.
 */
export declare function listExtractions(opts?: {
    status?: string;
    limit?: number;
}): Extraction[];
/**
 * Promote an extraction to a real cortex entry.
 */
export declare function promoteExtraction(id: number): {
    promoted: boolean;
    type: string;
    targetId: number;
};
/**
 * Reject an extraction (mark as rejected).
 */
export declare function rejectExtraction(id: number): void;
//# sourceMappingURL=extractions.d.ts.map