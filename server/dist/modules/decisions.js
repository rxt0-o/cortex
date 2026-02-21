import { getDb, now, toJson, parseJson } from '../db.js';
export function addDecision(input) {
    const db = getDb();
    const result = db.prepare(`
    INSERT INTO decisions (session_id, created_at, category, title, reasoning, alternatives, files_affected, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.session_id ?? null, now(), input.category, input.title, input.reasoning, toJson(input.alternatives), toJson(input.files_affected), input.confidence ?? 'high');
    return getDecision(Number(result.lastInsertRowid));
}
export function getDecision(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    if (!row)
        return null;
    return {
        ...row,
        alternatives: parseJson(row.alternatives),
        files_affected: parseJson(row.files_affected),
    };
}
export function listDecisions(options = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (options.category) {
        conditions.push('category = ?');
        params.push(options.category);
    }
    if (!options.includeSuperseded) {
        conditions.push('superseded_by IS NULL');
    }
    let sql = 'SELECT * FROM decisions';
    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(options.limit ?? 20);
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
        ...row,
        alternatives: parseJson(row.alternatives),
        files_affected: parseJson(row.files_affected),
    }));
}
export function searchDecisions(query, limit = 10) {
    const db = getDb();
    const rows = db.prepare(`
    SELECT d.* FROM decisions d
    JOIN decisions_fts fts ON d.id = fts.rowid
    WHERE decisions_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit);
    return rows.map((row) => ({
        ...row,
        alternatives: parseJson(row.alternatives),
        files_affected: parseJson(row.files_affected),
    }));
}
export function supersedeDecision(oldId, newId) {
    const db = getDb();
    db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(newId, oldId);
}
export function getDecisionsForFile(filePath) {
    const db = getDb();
    const rows = db.prepare(`
    SELECT * FROM decisions
    WHERE files_affected LIKE ?
    AND superseded_by IS NULL
    ORDER BY created_at DESC
  `).all(`%${filePath}%`);
    return rows.map((row) => ({
        ...row,
        alternatives: parseJson(row.alternatives),
        files_affected: parseJson(row.files_affected),
    }));
}
//# sourceMappingURL=decisions.js.map