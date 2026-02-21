export interface Decision {
    id: number;
    session_id: string | null;
    created_at: string;
    category: string;
    title: string;
    reasoning: string;
    alternatives: Alternative[] | null;
    files_affected: string[] | null;
    superseded_by: number | null;
    confidence: string;
    access_count: number;
    last_accessed: string | null;
    archived_at: string | null;
}
export interface Alternative {
    option: string;
    reason_rejected: string;
}
export interface AddDecisionInput {
    session_id?: string;
    category: string;
    title: string;
    reasoning: string;
    alternatives?: Alternative[];
    files_affected?: string[];
    confidence?: string;
}
export declare function addDecision(input: AddDecisionInput): Decision;
export declare function getDecision(id: number): Decision | null;
export declare function listDecisions(options?: {
    category?: string;
    limit?: number;
    includeSuperseded?: boolean;
}): Decision[];
export declare function searchDecisions(query: string, limit?: number): Decision[];
export declare function supersedeDecision(oldId: number, newId: number): void;
export interface DecisionPruningResult {
    decisions_archived: number;
}
export declare function runDecisionsPruning(): DecisionPruningResult;
export declare function getDecisionsForFile(filePath: string): Decision[];
//# sourceMappingURL=decisions.d.ts.map