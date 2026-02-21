export interface HealthSnapshot {
    id: number;
    date: string;
    score: number;
    metrics: HealthMetrics;
    trend: string | null;
}
export interface HealthMetrics {
    openErrors: number;
    unresolvedUnfinished: number;
    conventionViolations: number;
    hotZoneCount: number;
    avgChangeFrequency: number;
    recentBugRate: number;
    documentationCoverage: number;
}
export declare function calculateHealth(): HealthMetrics;
export declare function computeScore(metrics: HealthMetrics): number;
export declare function saveSnapshot(): HealthSnapshot;
export declare function getLatestSnapshot(): HealthSnapshot | null;
export declare function getHealthHistory(limit?: number): HealthSnapshot[];
//# sourceMappingURL=health.d.ts.map