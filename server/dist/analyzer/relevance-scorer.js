// Score and prioritize context items for session injection
// Score a session summary based on relevance
export function scoreSession(sessionSummary, sessionFiles, context, recencyDays) {
    let score = 0;
    // Recency: more recent = higher score
    if (recencyDays < 1)
        score += 30;
    else if (recencyDays < 3)
        score += 20;
    else if (recencyDays < 7)
        score += 10;
    else if (recencyDays < 30)
        score += 5;
    // File overlap: if session touched same files we're working on
    const overlap = sessionFiles.filter(f => context.currentFiles.some(cf => cf.includes(f) || f.includes(cf)));
    score += Math.min(overlap.length * 15, 45);
    // Content relevance (basic keyword matching)
    if (sessionSummary) {
        for (const file of context.currentFiles) {
            const basename = file.split('/').pop() ?? '';
            if (sessionSummary.includes(basename))
                score += 10;
        }
    }
    return Math.min(score, 100);
}
// Score an error based on relevance
export function scoreError(errorFiles, occurrences, hasFix, context) {
    let score = 0;
    // File overlap
    const overlap = errorFiles.filter(f => context.currentFiles.some(cf => cf.includes(f) || f.includes(cf)));
    score += overlap.length > 0 ? 40 : 0;
    // Frequency: more occurrences = more important
    if (occurrences > 5)
        score += 20;
    else if (occurrences > 2)
        score += 15;
    else
        score += 5;
    // Errors with fixes are more useful to show
    if (hasFix)
        score += 10;
    return Math.min(score, 100);
}
// Score a learning based on relevance
export function scoreLearning(autoBlock, occurrences, severity) {
    let score = 0;
    if (autoBlock)
        score += 30;
    if (severity === 'high')
        score += 20;
    else if (severity === 'medium')
        score += 10;
    score += Math.min(occurrences * 5, 20);
    return Math.min(score, 100);
}
// Select top items within a token budget
export function selectTopItems(items, maxTokens) {
    // Sort by score descending
    const sorted = [...items].sort((a, b) => b.score - a.score);
    const selected = [];
    let estimatedTokens = 0;
    for (const item of sorted) {
        // Rough token estimate: ~4 chars per token
        const itemTokens = Math.ceil(item.content.length / 4);
        if (estimatedTokens + itemTokens > maxTokens)
            break;
        selected.push(item);
        estimatedTokens += itemTokens;
    }
    return selected;
}
// Format selected items into a context string
export function formatContextBlock(items) {
    const sections = {
        session: [],
        error: [],
        learning: [],
        decision: [],
        unfinished: [],
    };
    for (const item of items) {
        sections[item.type].push(item.content);
    }
    const parts = [];
    if (sections.session.length > 0) {
        parts.push('RECENT SESSIONS:\n' + sections.session.join('\n\n'));
    }
    if (sections.unfinished.length > 0) {
        parts.push('UNFINISHED:\n' + sections.unfinished.map(u => `  - ${u}`).join('\n'));
    }
    if (sections.error.length > 0) {
        parts.push('KNOWN ERRORS:\n' + sections.error.join('\n'));
    }
    if (sections.learning.length > 0) {
        parts.push('ACTIVE PATTERNS (auto-block):\n' + sections.learning.join('\n'));
    }
    if (sections.decision.length > 0) {
        parts.push('KEY DECISIONS:\n' + sections.decision.join('\n'));
    }
    return parts.join('\n\n');
}
//# sourceMappingURL=relevance-scorer.js.map