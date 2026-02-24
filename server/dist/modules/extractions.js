import { getDb, now } from '../db.js';
/**
 * List pending or all auto-extractions.
 */
export function listExtractions(opts) {
    const db = getDb();
    const status = opts?.status ?? 'pending';
    const limit = opts?.limit ?? 50;
    if (status === 'all') {
        return db.prepare('SELECT * FROM auto_extractions ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    return db.prepare('SELECT * FROM auto_extractions WHERE status = ? ORDER BY confidence DESC, created_at DESC LIMIT ?').all(status, limit);
}
/**
 * Promote an extraction to a real cortex entry.
 */
export function promoteExtraction(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM auto_extractions WHERE id = ?').get(id);
    if (!row)
        throw new Error(`Extraction #${id} not found`);
    if (row.status !== 'pending')
        throw new Error(`Extraction #${id} is already ${row.status}`);
    const ts = now();
    let targetId = 0;
    if (row.type === 'decision') {
        const result = db.prepare(`INSERT INTO decisions (session_id, created_at, category, title, reasoning, confidence)
       VALUES (?, ?, 'auto-extracted', ?, '[auto-extracted]', 'low')`).run(row.session_id, ts, row.content);
        targetId = Number(result.lastInsertRowid);
    }
    else if (row.type === 'error') {
        const sig = `auto-${id}-${Date.now()}`;
        const result = db.prepare(`INSERT INTO errors (session_id, first_seen, last_seen, error_signature, error_message, severity)
       VALUES (?, ?, ?, ?, ?, 'medium')`).run(row.session_id, ts, ts, sig, row.content);
        targetId = Number(result.lastInsertRowid);
    }
    else if (row.type === 'learning') {
        const result = db.prepare(`INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, context, confidence)
       VALUES (?, ?, ?, '[auto-extracted]', 'auto-extracted from transcript', 0.4)`).run(row.session_id, ts, row.content);
        targetId = Number(result.lastInsertRowid);
    }
    else if (row.type === 'convention') {
        const result = db.prepare(`INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, context, confidence)
       VALUES (?, ?, ?, '[convention]', 'auto-extracted convention', 0.4)`).run(row.session_id, ts, row.content);
        targetId = Number(result.lastInsertRowid);
    }
    else {
        throw new Error(`Unknown extraction type: ${row.type}`);
    }
    db.prepare(`UPDATE auto_extractions SET status = 'promoted', promoted_to_type = ?, promoted_to_id = ? WHERE id = ?`).run(row.type === 'convention' ? 'learning' : row.type, targetId, id);
    return { promoted: true, type: row.type, targetId };
}
/**
 * Reject an extraction (mark as rejected).
 */
export function rejectExtraction(id) {
    const db = getDb();
    const row = db.prepare('SELECT status FROM auto_extractions WHERE id = ?').get(id);
    if (!row)
        throw new Error(`Extraction #${id} not found`);
    db.prepare(`UPDATE auto_extractions SET status = 'rejected' WHERE id = ?`).run(id);
}
//# sourceMappingURL=extractions.js.map