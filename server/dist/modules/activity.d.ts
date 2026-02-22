export interface ActivityEntry {
    tool_name: string;
    entity_type?: string;
    entity_id?: number;
    action: string;
    old_value?: string;
    new_value?: string;
    session_id?: string;
}
export declare function logActivity(entry: ActivityEntry): {
    id: number | bigint;
};
export interface ActivityFilter {
    entity_type?: string;
    entity_id?: number;
    action?: string;
    since?: string;
    limit?: number;
}
export declare function listActivity(filter?: ActivityFilter): unknown[];
//# sourceMappingURL=activity.d.ts.map