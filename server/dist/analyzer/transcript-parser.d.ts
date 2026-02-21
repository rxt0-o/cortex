export interface TranscriptMessage {
    type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
    content: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    timestamp?: string;
}
export interface ParsedTranscript {
    messages: TranscriptMessage[];
    toolCalls: ToolCall[];
    filesModified: string[];
    errorMessages: string[];
}
export interface ToolCall {
    tool: string;
    input: Record<string, unknown>;
    output?: string;
}
export declare function parseTranscript(transcriptPath: string): Promise<ParsedTranscript>;
export declare function extractDecisions(messages: TranscriptMessage[]): string[];
export declare function extractUnfinished(messages: TranscriptMessage[]): string[];
//# sourceMappingURL=transcript-parser.d.ts.map