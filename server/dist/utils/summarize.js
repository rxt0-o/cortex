// LLM-basierte Zusammenfassung
// In Hooks wird type: "prompt" genutzt. Im MCP Server wird kein eigener LLM-Call gemacht,
// stattdessen liefern wir strukturierte Daten und lassen Claude die Zusammenfassung erstellen.
// Simple heuristic-based extraction (no LLM needed for basic data)
export function extractFilesFromToolCalls(toolCalls) {
    const files = new Set();
    for (const call of toolCalls) {
        const input = call.input;
        if (typeof input.file_path === 'string') {
            files.add(input.file_path);
        }
        if (typeof input.path === 'string') {
            files.add(input.path);
        }
    }
    return [...files];
}
export function categorizeToolCalls(toolCalls) {
    const counts = {};
    for (const call of toolCalls) {
        counts[call.tool] = (counts[call.tool] ?? 0) + 1;
    }
    return counts;
}
// Generate a basic summary from tool call data (without LLM)
export function generateBasicSummary(toolCalls) {
    const files = extractFilesFromToolCalls(toolCalls);
    const categories = categorizeToolCalls(toolCalls);
    const parts = [];
    if (files.length > 0) {
        parts.push(`Files touched: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` (+${files.length - 10} more)` : ''}`);
    }
    const actions = Object.entries(categories)
        .sort(([, a], [, b]) => b - a)
        .map(([tool, count]) => `${tool}: ${count}`)
        .join(', ');
    if (actions) {
        parts.push(`Actions: ${actions}`);
    }
    return parts.join('\n') || 'No significant activity recorded.';
}
//# sourceMappingURL=summarize.js.map