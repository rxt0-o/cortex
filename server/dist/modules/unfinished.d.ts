export interface UnfinishedItem {
    id: number;
    session_id: string | null;
    created_at: string;
    description: string;
    context: string | null;
    priority: string;
    resolved_at: string | null;
    resolved_session: string | null;
    snooze_until?: string | null;
    priority_score?: number | null;
    project?: string | null;
    blocked_by?: string | null;
}
export interface AddUnfinishedInput {
    session_id?: string;
    description: string;
    context?: string;
    priority?: string;
    blocked_by?: number[];
}
export interface AddUnfinishedResult {
    item: UnfinishedItem;
    warnings: string[];
}
export interface ResolveUnfinishedResult {
    item: UnfinishedItem | null;
    newly_unblocked: Array<{
        id: number;
        description: string;
    }>;
}
export declare function addUnfinished(input: AddUnfinishedInput): AddUnfinishedResult;
export declare function getUnfinished(id: number): UnfinishedItem | null;
export declare function listUnfinished(options?: {
    includeResolved?: boolean;
    limit?: number;
    filter?: 'all' | 'actionable';
}): UnfinishedItem[];
export declare function resolveUnfinished(id: number, resolvedSession?: string): ResolveUnfinishedResult;
export declare function getOpenCount(): number;
//# sourceMappingURL=unfinished.d.ts.map