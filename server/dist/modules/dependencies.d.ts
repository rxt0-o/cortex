export interface Dependency {
    id: number;
    source_file: string;
    target_file: string;
    import_type: string;
    symbols: string[] | null;
}
export interface AddDependencyInput {
    source_file: string;
    target_file: string;
    import_type?: string;
    symbols?: string[];
}
export declare function addDependency(input: AddDependencyInput): void;
export declare function setFileDependencies(sourceFile: string, deps: AddDependencyInput[]): void;
export declare function getImports(filePath: string): Dependency[];
export declare function getImporters(filePath: string): Dependency[];
export declare function getImpactTree(filePath: string, maxDepth?: number): string[];
export declare function getDependencyTree(filePath: string, maxDepth?: number): string[];
export declare function getDependencyStats(): {
    totalFiles: number;
    totalEdges: number;
    orphans: number;
};
//# sourceMappingURL=dependencies.d.ts.map