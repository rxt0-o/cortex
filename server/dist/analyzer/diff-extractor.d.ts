export interface ParsedDiff {
    filePath: string;
    changeType: 'added' | 'modified' | 'deleted' | 'renamed';
    hunks: DiffHunk[];
    linesAdded: number;
    linesRemoved: number;
}
export interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
}
export interface DiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
    lineNumber: number;
}
export declare function parseDiff(diffText: string): ParsedDiff[];
export declare function summarizeDiff(diffs: ParsedDiff[]): string;
//# sourceMappingURL=diff-extractor.d.ts.map