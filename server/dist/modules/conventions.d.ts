export interface Convention {
    id: number;
    name: string;
    description: string;
    detection_pattern: string | null;
    violation_pattern: string | null;
    examples_good: string[] | null;
    examples_bad: string[] | null;
    scope: string | null;
    source: string | null;
    violation_count: number;
    last_violated: string | null;
}
export interface AddConventionInput {
    name: string;
    description: string;
    detection_pattern?: string;
    violation_pattern?: string;
    examples_good?: string[];
    examples_bad?: string[];
    scope?: string;
    source?: string;
}
export declare function addConvention(input: AddConventionInput): Convention;
export declare function getConventionByName(name: string): Convention | null;
export declare function listConventions(scope?: string): Convention[];
export declare function recordViolation(conventionId: number): void;
export declare function checkContentAgainstConventions(content: string): Array<{
    convention: Convention;
    match: string;
    type: 'violation';
}>;
//# sourceMappingURL=conventions.d.ts.map