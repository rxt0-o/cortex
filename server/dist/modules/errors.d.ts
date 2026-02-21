export interface CortexError {
    id: number;
    session_id: string | null;
    first_seen: string;
    last_seen: string;
    occurrences: number;
    error_signature: string;
    error_message: string;
    root_cause: string | null;
    fix_description: string | null;
    fix_diff: string | null;
    files_involved: string[] | null;
    prevention_rule: string | null;
    severity: string;
}
export interface AddErrorInput {
    session_id?: string;
    error_message: string;
    root_cause?: string;
    fix_description?: string;
    fix_diff?: string;
    files_involved?: string[];
    prevention_rule?: string;
    severity?: string;
}
export declare function createErrorSignature(message: string): string;
export declare function addError(input: AddErrorInput): CortexError;
export declare function getError(id: number): CortexError | null;
export declare function listErrors(options?: {
    severity?: string;
    file?: string;
    limit?: number;
    withFix?: boolean;
}): CortexError[];
export declare function searchErrors(query: string, limit?: number): CortexError[];
export declare function getErrorsForFiles(filePaths: string[]): CortexError[];
export declare function getPreventionRules(): Array<{
    id: number;
    prevention_rule: string;
    error_message: string;
}>;
//# sourceMappingURL=errors.d.ts.map