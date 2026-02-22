// server/src/modules/activity.ts
import { getDb } from '../db.js';
export function logActivity(entry) {
    const db = getDb();
    const r = db.prepare(`
    INSERT INTO activity_log (tool_name, entity_type, entity_id, action, old_value, new_value, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.tool_name, entry.entity_type ?? null, entry.entity_id ?? null, entry.action, entry.old_value ?? null, entry.new_value ?? null, entry.session_id ?? null);
    return { id: r.lastInsertRowid };
}
export function listActivity(filter = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filter.entity_type) {
        conditions.push('entity_type=?');
        params.push(filter.entity_type);
    }
    if (filter.entity_id != null) {
        conditions.push('entity_id=?');
        params.push(filter.entity_id);
    }
    if (filter.action) {
        conditions.push('action=?');
        params.push(filter.action);
    }
    if (filter.since) {
        conditions.push('created_at >= ?');
        params.push(filter.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = filter.limit ?? 50;
    params.push(lim);
    return db.prepare(`SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
}
//# sourceMappingURL=activity.js.map