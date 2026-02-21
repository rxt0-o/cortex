import { DatabaseSync } from 'node:sqlite';
export type { SQLInputValue } from 'node:sqlite';
export declare function getDb(projectDir?: string): InstanceType<typeof DatabaseSync>;
export declare function closeDb(): void;
export declare function now(): string;
export declare function parseJson<T>(value: unknown): T | null;
export declare function toJson(value: unknown): string | null;
export declare function ageLabel(dateStr: string | null | undefined): string;
//# sourceMappingURL=db.d.ts.map