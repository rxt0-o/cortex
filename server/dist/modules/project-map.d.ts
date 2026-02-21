export interface ProjectModule {
    id: number;
    path: string;
    name: string;
    layer: string;
    description: string | null;
    entry_points: string[] | null;
    conventions: string[] | null;
    last_scanned: string | null;
    last_changed: string | null;
}
export interface ProjectFile {
    id: number;
    path: string;
    module_id: number | null;
    file_type: string | null;
    description: string | null;
    exports: string[] | null;
    change_count: number;
    error_count: number;
    last_changed: string | null;
    last_changed_session: string | null;
}
export interface UpsertModuleInput {
    path: string;
    name: string;
    layer: string;
    description?: string;
    entry_points?: string[];
    conventions?: string[];
}
export interface UpsertFileInput {
    path: string;
    module_id?: number;
    file_type?: string;
    description?: string;
    exports?: string[];
}
export declare function upsertModule(input: UpsertModuleInput): ProjectModule;
export declare function getModuleByPath(path: string): ProjectModule | null;
export declare function listModules(layer?: string): ProjectModule[];
export declare function upsertFile(input: UpsertFileInput): ProjectFile;
export declare function getFileByPath(path: string): ProjectFile | null;
export declare function trackFileChange(filePath: string, sessionId?: string): void;
export declare function getHotZones(limit?: number): ProjectFile[];
export declare function getModuleSummary(): Array<{
    layer: string;
    modules: Array<{
        name: string;
        path: string;
        fileCount: number;
    }>;
}>;
export declare function inferFileType(filePath: string): string | null;
export declare function inferModulePath(filePath: string): string | null;
export interface ScanResult {
    scanned: number;
    modules: number;
    files: number;
    dependencies: number;
}
export declare function scanProject(rootPath: string): ScanResult;
//# sourceMappingURL=project-map.d.ts.map