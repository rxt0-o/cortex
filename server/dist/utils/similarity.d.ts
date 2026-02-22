export interface SimilarMatch {
    id: number;
    score: number;
}
/**
 * Findet Eintraege im Corpus die dem Query aehnlich sind (TF-IDF Cosine Similarity).
 * @param query Der zu pruefende Text
 * @param corpus Array von {id, text} Eintraegen
 * @param threshold Schwellenwert 0-1, Default 0.85 (via CORTEX_SIMILARITY_THRESHOLD env konfigurierbar)
 */
export declare function findSimilar(query: string, corpus: {
    id: number;
    text: string;
}[], threshold?: number): SimilarMatch[];
//# sourceMappingURL=similarity.d.ts.map