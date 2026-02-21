import { getDb } from '../db.js';
export function calculateHealth() {
    const db = getDb();
    const openErrors = db.prepare('SELECT COUNT(*) as count FROM errors WHERE fix_description IS NULL').get().count;
    const unresolvedUnfinished = db.prepare('SELECT COUNT(*) as count FROM unfinished WHERE resolved_at IS NULL').get().count;
    const conventionViolations = db.prepare('SELECT SUM(violation_count) as total FROM conventions').get().total ?? 0;
    const hotZoneCount = db.prepare('SELECT COUNT(*) as count FROM project_files WHERE change_count > 20').get().count;
    const avgChange = db.prepare('SELECT AVG(change_count) as avg FROM project_files WHERE change_count > 0').get().avg ?? 0;
    // Unfixte Bugs in den letzten 7 Tagen (behobene Fehler nicht bestrafen)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentBugs = db.prepare('SELECT COUNT(*) as count FROM errors WHERE last_seen > ? AND fix_description IS NULL').get(weekAgo).count;
    // Files with known file_type vs total (proxy für "wie gut kennt Cortex das Projekt")
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM project_files').get().count;
    const typedFiles = db.prepare('SELECT COUNT(*) as count FROM project_files WHERE file_type IS NOT NULL').get().count;
    const docCoverage = totalFiles > 0 ? Math.round((typedFiles / totalFiles) * 100) : 100;
    return {
        openErrors,
        unresolvedUnfinished,
        conventionViolations,
        hotZoneCount,
        avgChangeFrequency: Math.round(avgChange * 10) / 10,
        recentBugRate: recentBugs,
        documentationCoverage: docCoverage,
    };
}
export function computeScore(metrics) {
    let score = 100;
    // Deductions
    score -= metrics.openErrors * 5; // -5 per unfixed error
    score -= metrics.unresolvedUnfinished * 2; // -2 per open TODO
    score -= Math.min(metrics.conventionViolations, 20); // -1 per violation, max -20
    score -= metrics.hotZoneCount * 2; // -2 per hot zone
    score -= metrics.recentBugRate * 3; // -3 per recent bug
    score += Math.round(metrics.documentationCoverage / 10); // +0-10 for docs
    return Math.max(0, Math.min(100, Math.round(score)));
}
export function saveSnapshot() {
    const db = getDb();
    const metrics = calculateHealth();
    const score = computeScore(metrics);
    const today = new Date().toISOString().split('T')[0];
    // Get previous snapshot for trend
    const prev = db.prepare('SELECT score FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
    let trend = 'stable';
    if (prev) {
        if (score > prev.score + 2)
            trend = 'up';
        else if (score < prev.score - 2)
            trend = 'down';
    }
    db.prepare(`
    INSERT INTO health_snapshots (date, score, metrics, trend)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      score = excluded.score,
      metrics = excluded.metrics,
      trend = excluded.trend
  `).run(today, score, JSON.stringify(metrics), trend);
    return getLatestSnapshot();
}
export function getLatestSnapshot() {
    const db = getDb();
    const row = db.prepare('SELECT * FROM health_snapshots ORDER BY date DESC LIMIT 1').get();
    if (!row)
        return null;
    return {
        ...row,
        metrics: JSON.parse(row.metrics),
    };
}
export function getHealthHistory(limit = 30) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM health_snapshots ORDER BY date DESC LIMIT ?').all(limit);
    return rows.map((row) => ({
        ...row,
        metrics: JSON.parse(row.metrics),
    }));
}
//# sourceMappingURL=health.js.map