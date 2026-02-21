export interface DiffRecord {
    id: number;
    session_id: string | null;
    file_path: string;
    diff_content: string;
    change_type: string | null;
    lines_added: number;
    lines_removed: number;
    created_at: string;
}
export interface AddDiffInput {
    session_id?: string;
    file_path: string;
    diff_content: string;
    change_type?: string;
    lines_added?: number;
    lines_removed?: number;
}
export declare function addDiff(input: AddDiffInput): DiffRecord;
export declare function getDiff(id: number): DiffRecord | null;
export declare function getDiffsForFile(filePath: string, limit?: number): DiffRecord[];
export declare function getDiffsForSession(sessionId: string): DiffRecord[];
export declare function getRecentDiffs(limit?: number): DiffRecord[];
export declare function getDiffStats(): {
    totalDiffs: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    fileCount: number;
};
//# sourceMappingURL=diffs.d.ts.map