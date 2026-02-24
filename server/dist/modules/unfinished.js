import { getDb, now } from '../db.js';
export function addUnfinished(input) {
    const db = getDb();
    const blockedBy = normalizeBlockedBy(input.blocked_by);
    const warnings = [];
    db.exec('BEGIN');
    try {
        const result = db.prepare(`
      INSERT INTO unfinished (session_id, created_at, description, context, priority, blocked_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.session_id ?? null, now(), input.description, input.context ?? null, input.priority ?? 'medium', blockedBy.length > 0 ? JSON.stringify(blockedBy) : null);
        const insertedId = Number(result.lastInsertRowid);
        // Defensive check: should never happen for create-flow, but keeps data clean if ID is forced.
        if (blockedBy.includes(insertedId)) {
            throw new Error(`Self-dependency: item ${insertedId} cannot block itself`);
        }
        if (blockedBy.length > 0) {
            const existsStmt = db.prepare('SELECT id FROM unfinished WHERE id = ? AND resolved_at IS NULL');
            const depBlockedByStmt = db.prepare('SELECT blocked_by FROM unfinished WHERE id = ? AND resolved_at IS NULL');
            for (const depId of blockedBy) {
                const exists = existsStmt.get(depId);
                if (!exists) {
                    warnings.push(`Dependency #${depId} not found or already resolved`);
                    continue;
                }
                const dep = depBlockedByStmt.get(depId);
                if (!dep?.blocked_by || !isValidBlockedByJson(dep.blocked_by))
                    continue;
                const depBlockedBy = parseBlockedBy(dep.blocked_by);
                if (depBlockedBy.includes(insertedId)) {
                    warnings.push(`Cycle detected: #${insertedId} <-> #${depId}`);
                }
            }
        }
        db.exec('COMMIT');
        // Fire-and-forget embedding
        import('./embed-hooks.js').then(({ embedAsync }) => embedAsync('todo', insertedId, { description: input.description, context: input.context })).catch(() => { });
        return {
            item: getUnfinished(insertedId),
            warnings,
        };
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* ignore */ }
        throw error;
    }
}
export function getUnfinished(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM unfinished WHERE id = ?').get(id);
    return row ?? null;
}
export function listUnfinished(options = {}) {
    const db = getDb();
    let sql = 'SELECT * FROM unfinished';
    const where = [];
    const params = [];
    if (!options.includeResolved) {
        where.push('resolved_at IS NULL');
    }
    if (options.filter === 'actionable') {
        if (options.includeResolved) {
            throw new Error('filter="actionable" cannot be combined with includeResolved=true');
        }
        where.push(`
      (
        blocked_by IS NULL
        OR blocked_by = ''
        OR (
          json_valid(blocked_by) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(blocked_by) AS dep
            WHERE CAST(dep.value AS INTEGER) IN (
              SELECT id FROM unfinished WHERE resolved_at IS NULL
            )
          )
        )
      )
    `);
    }
    if (where.length > 0) {
        sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY COALESCE(priority_score, 50) DESC, CASE priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC LIMIT ?';
    params.push(options.limit ?? 50);
    return db.prepare(sql).all(...params);
}
export function resolveUnfinished(id, resolvedSession) {
    const db = getDb();
    db.prepare(`
    UPDATE unfinished SET resolved_at = ?, resolved_session = ? WHERE id = ?
  `).run(now(), resolvedSession ?? null, id);
    const item = getUnfinished(id);
    const newlyUnblocked = db.prepare(`
    SELECT id, description
    FROM unfinished
    WHERE resolved_at IS NULL
      AND blocked_by IS NOT NULL
      AND blocked_by != ''
      AND json_valid(blocked_by) = 1
      AND EXISTS (
        SELECT 1
        FROM json_each(blocked_by) AS dep
        WHERE CAST(dep.value AS INTEGER) = ?
      )
    ORDER BY COALESCE(priority_score, 50) DESC, created_at DESC
  `).all(id);
    return { item, newly_unblocked: newlyUnblocked };
}
export function getOpenCount() {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM unfinished WHERE resolved_at IS NULL').get();
    return row.count;
}
function normalizeBlockedBy(blockedBy) {
    if (!blockedBy || blockedBy.length === 0)
        return [];
    if (!Array.isArray(blockedBy) || !blockedBy.every((id) => Number.isInteger(id) && id > 0)) {
        throw new Error('blocked_by must be an array of positive integers');
    }
    return [...new Set(blockedBy)];
}
function parseBlockedBy(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((id) => Number.isInteger(id) && id > 0);
    }
    catch {
        return [];
    }
}
function isValidBlockedByJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=unfinished.js.map