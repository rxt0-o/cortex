export interface GitLogEntry {
    hash: string;
    date: string;
    message: string;
    author: string;
}
export interface GitDiffStat {
    file: string;
    additions: number;
    deletions: number;
}
export declare function getStatus(cwd?: string): Promise<string>;
export declare function getCurrentBranch(cwd?: string): Promise<string>;
export declare function getLog(limit?: number, cwd?: string): Promise<GitLogEntry[]>;
export declare function getDiff(ref?: string, cwd?: string): Promise<string>;
export declare function getDiffStat(ref?: string, cwd?: string): Promise<GitDiffStat[]>;
export declare function getChangedFiles(sinceCommit?: string, cwd?: string): Promise<string[]>;
export declare function getFileBlame(filePath: string, cwd?: string): Promise<string>;
export declare function getLastCommitForFile(filePath: string, cwd?: string): Promise<GitLogEntry | null>;
export declare function getSessionDiff(startCommit: string, endCommit?: string, cwd?: string): Promise<string>;
//# sourceMappingURL=git.d.ts.map