export interface Learning {
    id: number;
    session_id: string | null;
    created_at: string;
    anti_pattern: string;
    correct_pattern: string;
    detection_regex: string | null;
    context: string;
    severity: string;
    occurrences: number;
    auto_block: boolean;
}
export interface AddLearningInput {
    session_id?: string;
    anti_pattern: string;
    correct_pattern: string;
    detection_regex?: string;
    context: string;
    severity?: string;
    auto_block?: boolean;
}
export declare function addLearning(input: AddLearningInput): Learning;
export declare function getLearning(id: number): Learning | null;
export declare function listLearnings(options?: {
    severity?: string;
    autoBlockOnly?: boolean;
    limit?: number;
}): Learning[];
export declare function searchLearnings(query: string, limit?: number): Learning[];
export declare function getAutoBlockLearnings(): Learning[];
export interface UpdateLearningInput {
    id: number;
    anti_pattern?: string;
    correct_pattern?: string;
    detection_regex?: string | null;
    context?: string;
    severity?: string;
    auto_block?: boolean;
}
export declare function updateLearning(input: UpdateLearningInput): Learning | null;
export declare function deleteLearning(id: number): boolean;
export declare function incrementLearningOccurrence(id: number): void;
export declare function checkContentAgainstLearnings(content: string): Array<{
    learning: Learning;
    match: string;
}>;
//# sourceMappingURL=learnings.d.ts.map