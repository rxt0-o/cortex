export type ToolCategory = 'memory' | 'decisions' | 'errors' | 'map' | 'tracking' | 'notes' | 'intelligence' | 'stats' | 'activity';
export declare const TOOL_CATEGORIES: Record<ToolCategory, string>;
export declare const VALID_CATEGORIES: ToolCategory[];
export declare function getToolGuidance(categories: string[]): string;
export declare const PRELOAD_GUIDANCE: string;
//# sourceMappingURL=tool-registry.d.ts.map