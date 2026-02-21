export interface Session {
    id: string;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    summary: string | null;
    key_changes: KeyChange[] | null;
    chain_id: string | null;
    chain_label: string | null;
    status: string;
}
export interface KeyChange {
    file: string;
    action: string;
    description: string;
}
export interface CreateSessionInput {
    id: string;
    started_at?: string;
}
export interface UpdateSessionInput {
    ended_at?: string;
    duration_seconds?: number;
    summary?: string;
    key_changes?: KeyChange[];
    chain_id?: string;
    chain_label?: string;
    status?: string;
}
export declare function createSession(input: CreateSessionInput): Session;
export declare function getSession(id: string): Session | null;
export declare function updateSession(id: string, input: UpdateSessionInput): Session | null;
export declare function listSessions(limit?: number, chainId?: string): Session[];
export declare function searchSessions(query: string, limit?: number): Session[];
export declare function getRecentSummaries(limit?: number): Array<{
    id: string;
    started_at: string;
    summary: string | null;
}>;
export declare function detectSessionChain(sessionId: string): string | null;
//# sourceMappingURL=sessions.d.ts.map