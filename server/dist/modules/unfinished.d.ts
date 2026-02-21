export interface UnfinishedItem {
    id: number;
    session_id: string | null;
    created_at: string;
    description: string;
    context: string | null;
    priority: string;
    resolved_at: string | null;
    resolved_session: string | null;
}
export interface AddUnfinishedInput {
    session_id?: string;
    description: string;
    context?: string;
    priority?: string;
}
export declare function addUnfinished(input: AddUnfinishedInput): UnfinishedItem;
export declare function getUnfinished(id: number): UnfinishedItem | null;
export declare function listUnfinished(options?: {
    includeResolved?: boolean;
    limit?: number;
}): UnfinishedItem[];
export declare function resolveUnfinished(id: number, resolvedSession?: string): unknown;
export declare function getOpenCount(): number;
//# sourceMappingURL=unfinished.d.ts.map