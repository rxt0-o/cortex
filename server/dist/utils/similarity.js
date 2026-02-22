// server/src/utils/similarity.ts
// TF-IDF Cosine Similarity — zero external dependencies
const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'it', 'this', 'that', 'are', 'was', 'be', 'have', 'has', 'do', 'does',
    'not', 'no', 'so', 'if', 'as', 'by', 'from', 'use', 'used', 'using', 'should',
    'must', 'will', 'can', 'may', 'always', 'never', 'instead',
    'ein', 'eine', 'der', 'die', 'das', 'und', 'oder', 'aber', 'zu', 'fuer',
    'von', 'mit', 'ist', 'es', 'ich', 'wir', 'sie', 'nicht', 'kein', 'wie',
]);
function tokenize(text) {
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOPWORDS.has(t));
}
function computeTF(tokens) {
    const tf = new Map();
    for (const t of tokens)
        tf.set(t, (tf.get(t) ?? 0) + 1);
    const total = tokens.length || 1;
    for (const [k, v] of tf)
        tf.set(k, v / total);
    return tf;
}
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (const [k, v] of a) {
        dot += v * (b.get(k) ?? 0);
        normA += v * v;
    }
    for (const v of b.values())
        normB += v * v;
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
/**
 * Findet Eintraege im Corpus die dem Query aehnlich sind (TF-IDF Cosine Similarity).
 * @param query Der zu pruefende Text
 * @param corpus Array von {id, text} Eintraegen
 * @param threshold Schwellenwert 0-1, Default 0.85 (via CORTEX_SIMILARITY_THRESHOLD env konfigurierbar)
 */
export function findSimilar(query, corpus, threshold = (() => { const v = parseFloat(process.env.CORTEX_SIMILARITY_THRESHOLD ?? '0.85'); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.85; })()) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0)
        return [];
    // IDF ueber gesamten Corpus + Query berechnen
    const allDocs = [...corpus.map(c => tokenize(c.text)), queryTokens];
    const N = allDocs.length;
    const df = new Map();
    for (const doc of allDocs) {
        for (const t of new Set(doc))
            df.set(t, (df.get(t) ?? 0) + 1);
    }
    const idf = (term) => Math.log((N + 1) / ((df.get(term) ?? 0) + 1));
    function tfidfVec(tokens) {
        const tf = computeTF(tokens);
        const vec = new Map();
        for (const [t, tfVal] of tf)
            vec.set(t, tfVal * idf(t));
        return vec;
    }
    const queryVec = tfidfVec(queryTokens);
    const results = [];
    for (const entry of corpus) {
        const score = cosineSimilarity(queryVec, tfidfVec(tokenize(entry.text)));
        if (score >= threshold)
            results.push({ id: entry.id, score });
    }
    return results.sort((a, b) => b.score - a.score);
}
//# sourceMappingURL=similarity.js.map