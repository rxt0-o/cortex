// server/src/analyzer/chunk-analyzer.ts
// Natural Boundary Chunking — erkennt Funktions-/Klassengrenzen in Diffs
// Regex-Patterns fuer Funktions- und Klassengrenzen
const BOUNDARY_PATTERNS = [
    /^\s*export\s+(?:async\s+)?function\s+(\w+)/,
    /^\s*(?:async\s+)?function\s+(\w+)/,
    /^\s*export\s+class\s+(\w+)/,
    /^\s*class\s+(\w+)/,
    /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^\s*def\s+(\w+)/, // Python
    /^\s*func\s+(\w+)/, // Go/Swift
];
const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'return']);
function detectFunctionName(line) {
    for (const pat of BOUNDARY_PATTERNS) {
        const m = line.match(pat);
        if (m?.[1] && !SKIP.has(m[1]))
            return m[1];
    }
    return null;
}
/**
 * Gruppiert DiffHunks nach der Funktion/Klasse in der sie liegen.
 */
export function chunkByFunctions(diff) {
    const chunks = new Map();
    for (const hunk of diff.hunks) {
        let current = 'module-level';
        for (const line of hunk.lines) {
            const det = detectFunctionName(line.content);
            if (det)
                current = det;
        }
        if (!chunks.has(current)) {
            chunks.set(current, {
                functionName: current,
                startLine: hunk.newStart,
                hunks: [],
                linesAdded: 0,
                linesRemoved: 0,
            });
        }
        const chunk = chunks.get(current);
        chunk.hunks.push(hunk);
        chunk.linesAdded += hunk.lines.filter(l => l.type === 'add').length;
        chunk.linesRemoved += hunk.lines.filter(l => l.type === 'remove').length;
    }
    return Array.from(chunks.values());
}
/**
 * Erzeugt eine lesbare Zusammenfassung der geaenderten Funktionen.
 * Beispiel: "server/src/index.ts -> addLearning() +5/-2, cortex_search() +12/-8"
 */
export function summarizeFunctionChanges(diff) {
    const chunks = chunkByFunctions(diff);
    if (chunks.length === 0)
        return diff.filePath + ': no changes';
    return diff.filePath + ' -> ' +
        chunks.map(c => c.functionName + '() +' + c.linesAdded + '/-' + c.linesRemoved).join(', ');
}
//# sourceMappingURL=chunk-analyzer.js.map