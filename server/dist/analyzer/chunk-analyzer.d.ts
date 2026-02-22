import type { ParsedDiff, DiffHunk } from './diff-extractor.js';
export interface FunctionChunk {
    functionName: string;
    startLine: number;
    hunks: DiffHunk[];
    linesAdded: number;
    linesRemoved: number;
}
/**
 * Gruppiert DiffHunks nach der Funktion/Klasse in der sie liegen.
 */
export declare function chunkByFunctions(diff: ParsedDiff): FunctionChunk[];
/**
 * Erzeugt eine lesbare Zusammenfassung der geaenderten Funktionen.
 * Beispiel: "server/src/index.ts -> addLearning() +5/-2, cortex_search() +12/-8"
 */
export declare function summarizeFunctionChanges(diff: ParsedDiff): string;
//# sourceMappingURL=chunk-analyzer.d.ts.map