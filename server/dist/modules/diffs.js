import { getDb, now } from '../db.js';
export function addDiff(input) {
    const db = getDb();
    const result = db.prepare(`
    INSERT INTO diffs (session_id, file_path, diff_content, change_type, lines_added, lines_removed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.session_id ?? null, input.file_path, input.diff_content, input.change_type ?? null, input.lines_added ?? 0, input.lines_removed ?? 0, now());
    return getDiff(Number(result.lastInsertRowid));
}
export function getDiff(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM diffs WHERE id = ?').get(id) ?? null;
}
export function getDiffsForFile(filePath, limit = 20) {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM diffs WHERE file_path = ? ORDER BY created_at DESC LIMIT ?
  `).all(filePath, limit);
}
export function getDiffsForSession(sessionId) {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM diffs WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId);
}
export function getRecentDiffs(limit = 50) {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM diffs ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}
export function getDiffStats() {
    const db = getDb();
    const stats = db.prepare(`
    SELECT
      COUNT(*) as total_diffs,
      SUM(lines_added) as total_added,
      SUM(lines_removed) as total_removed,
      COUNT(DISTINCT file_path) as file_count
    FROM diffs
  `).get();
    return {
        totalDiffs: stats.total_diffs ?? 0,
        totalLinesAdded: stats.total_added ?? 0,
        totalLinesRemoved: stats.total_removed ?? 0,
        fileCount: stats.file_count ?? 0,
    };
}
//# sourceMappingURL=diffs.js.map