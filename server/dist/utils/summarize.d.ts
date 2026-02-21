export interface SessionSummaryInput {
    toolCalls: ToolCallRecord[];
    filesChanged: string[];
    errorsEncountered: string[];
    decisions: string[];
}
export interface ToolCallRecord {
    tool: string;
    input: Record<string, unknown>;
    output?: string;
    timestamp?: string;
}
export interface ExtractedSessionData {
    summary: string;
    keyChanges: KeyChange[];
    decisions: ExtractedDecision[];
    errors: ExtractedError[];
    learnings: ExtractedLearning[];
    unfinished: string[];
}
export interface KeyChange {
    file: string;
    action: 'added' | 'modified' | 'deleted' | 'renamed';
    description: string;
}
export interface ExtractedDecision {
    title: string;
    reasoning: string;
    category: string;
    filesAffected: string[];
}
export interface ExtractedError {
    message: string;
    rootCause?: string;
    fix?: string;
    filesInvolved: string[];
}
export interface ExtractedLearning {
    antiPattern: string;
    correctPattern: string;
    context: string;
}
export declare function extractFilesFromToolCalls(toolCalls: ToolCallRecord[]): string[];
export declare function categorizeToolCalls(toolCalls: ToolCallRecord[]): Record<string, number>;
export declare function generateBasicSummary(toolCalls: ToolCallRecord[]): string;
//# sourceMappingURL=summarize.d.ts.map