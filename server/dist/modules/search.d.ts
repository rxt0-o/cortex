export interface SearchResult {
    type: 'learning' | 'decision' | 'error' | 'note' | 'session' | 'todo';
    id: number | string;
    score: number;
    title: string;
    snippet: string;
    created_at: string | null;
    metadata: Record<string, unknown>;
}
interface FtsConfig {
    type: SearchResult['type'];
    ftsTable: string;
    sourceTable: string;
    joinColumn: string;
    titleFn: (row: any) => string;
    snippetColumns: string[];
    metadataFn: (row: any) => Record<string, unknown>;
    createdAtColumn: string;
}
declare const FTS_CONFIGS: FtsConfig[];
export { FTS_CONFIGS };
/**
 * Unified BM25 search across all entity types.
 * Returns results sorted by normalized BM25 score (cross-entity comparable).
 */
export declare function searchBm25(query: string, limit?: number): SearchResult[];
/**
 * Default search — BM25 only. Will be extended with RRF in Phase 2.
 */
export declare function searchAll(query: string, limit?: number): SearchResult[];
/**
 * Format search results for MCP tool output.
 */
export declare function formatResults(results: SearchResult[]): string;
//# sourceMappingURL=search.d.ts.map