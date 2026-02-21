export interface ScoredItem {
    type: 'session' | 'error' | 'learning' | 'decision' | 'unfinished';
    content: string;
    score: number;
    id: number | string;
}
export interface ScoringContext {
    currentFiles: string[];
    currentBranch: string;
    recentSessionIds: string[];
}
export declare function scoreSession(sessionSummary: string | null, sessionFiles: string[], context: ScoringContext, recencyDays: number): number;
export declare function scoreError(errorFiles: string[], occurrences: number, hasFix: boolean, context: ScoringContext): number;
export declare function scoreLearning(autoBlock: boolean, occurrences: number, severity: string): number;
export declare function selectTopItems(items: ScoredItem[], maxTokens: number): ScoredItem[];
export declare function formatContextBlock(items: ScoredItem[]): string;
//# sourceMappingURL=relevance-scorer.d.ts.map