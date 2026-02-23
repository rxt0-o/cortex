import { getDb, now } from '../db.js';
export function addUnfinished(input) {
    const db = getDb();
    const result = db.prepare(`
    INSERT INTO unfinished (session_id, created_at, description, context, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.session_id ?? null, now(), input.description, input.context ?? null, input.priority ?? 'medium');
    const insertedId = Number(result.lastInsertRowid);
    // Fire-and-forget embedding
    import('./embed-hooks.js').then(({ embedAsync }) => embedAsync('todo', insertedId, { description: input.description, context: input.context })).catch(() => { });
    return getUnfinished(insertedId);
}
export function getUnfinished(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM unfinished WHERE id = ?').get(id) ?? null;
}
export function listUnfinished(options = {}) {
    const db = getDb();
    let sql = 'SELECT * FROM unfinished';
    const params = [];
    if (!options.includeResolved) {
        sql += ' WHERE resolved_at IS NULL';
    }
    sql += ' ORDER BY CASE priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC LIMIT ?';
    params.push(options.limit ?? 50);
    return db.prepare(sql).all(...params);
}
export function resolveUnfinished(id, resolvedSession) {
    const db = getDb();
    db.prepare(`
    UPDATE unfinished SET resolved_at = ?, resolved_session = ? WHERE id = ?
  `).run(now(), resolvedSession ?? null, id);
    return db.prepare('SELECT * FROM unfinished WHERE id = ?').get(id);
}
export function getOpenCount() {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM unfinished WHERE resolved_at IS NULL').get();
    return row.count;
}
//# sourceMappingURL=unfinished.js.map