import { getDb, now } from '../db.js';
import { findSimilar } from '../utils/similarity.js';
export function addLearning(input) {
    const db = getDb();
    // Duplikat-Check vor INSERT
    const existing = db.prepare('SELECT id, anti_pattern, correct_pattern FROM learnings WHERE archived_at IS NULL LIMIT 500').all();
    const corpus = existing.map(e => ({ id: e.id, text: e.anti_pattern + ' ' + e.correct_pattern }));
    const similar = findSimilar(input.anti_pattern + ' ' + input.correct_pattern, corpus);
    const result = db.prepare(`
    INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, detection_regex, context, severity, auto_block, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.7)
  `).run(input.session_id ?? null, now(), input.anti_pattern, input.correct_pattern, input.detection_regex ?? null, input.context, input.severity ?? 'medium', input.auto_block ? 1 : 0);
    // Auto-share high-severity learnings
    if (input.severity === 'high') {
        db.prepare('UPDATE learnings SET shared = 1 WHERE id = ?').run(Number(result.lastInsertRowid));
    }
    const insertedId = Number(result.lastInsertRowid);
    // Fire-and-forget embedding
    import('./embed-hooks.js').then(({ embedAsync }) => embedAsync('learning', insertedId, { anti_pattern: input.anti_pattern, correct_pattern: input.correct_pattern, context: input.context })).catch(() => { });
    const learning = getLearning(insertedId);
    if (similar.length > 0) {
        const top = similar[0];
        const topEntry = existing.find(e => e.id === top.id);
        return {
            learning,
            duplicate: {
                id: top.id,
                score: Math.round(top.score * 100),
                anti_pattern: topEntry?.anti_pattern ?? '',
            },
        };
    }
    return { learning };
}
export function getLearning(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id);
    if (!row)
        return null;
    db.prepare('UPDATE learnings SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
    return { ...row, auto_block: Boolean(row.auto_block) };
}
export function listLearnings(options = {}) {
    const db = getDb();
    const conditions = [];
    const params = [];
    conditions.push('archived_at IS NULL');
    if (options.severity) {
        conditions.push('severity = ?');
        params.push(options.severity);
    }
    if (options.autoBlockOnly) {
        conditions.push('auto_block = 1');
    }
    let sql = 'SELECT * FROM learnings';
    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY occurrences DESC, created_at DESC LIMIT ?';
    params.push(options.limit ?? 50);
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({ ...row, auto_block: Boolean(row.auto_block) }));
}
export function searchLearnings(query, limit = 10) {
    const db = getDb();
    // Try FTS first, fallback to LIKE
    try {
        const rows = db.prepare(`
      SELECT l.* FROM learnings l
      JOIN learnings_fts fts ON l.id = fts.rowid
      WHERE learnings_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit);
        return rows.map((row) => ({ ...row, auto_block: Boolean(row.auto_block) }));
    }
    catch {
        // FTS not available, fallback
        const likeQuery = `%${query}%`;
        const rows = db.prepare(`
      SELECT * FROM learnings
      WHERE anti_pattern LIKE ? OR correct_pattern LIKE ? OR context LIKE ?
      LIMIT ?
    `).all(likeQuery, likeQuery, likeQuery, limit);
        return rows.map((row) => ({ ...row, auto_block: Boolean(row.auto_block) }));
    }
}
export function getAutoBlockLearnings() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM learnings WHERE auto_block = 1 AND archived_at IS NULL').all();
    return rows.map((row) => ({ ...row, auto_block: true }));
}
export function updateLearning(input) {
    const db = getDb();
    const sets = [];
    const values = [];
    if (input.anti_pattern !== undefined) {
        sets.push('anti_pattern = ?');
        values.push(input.anti_pattern);
    }
    if (input.correct_pattern !== undefined) {
        sets.push('correct_pattern = ?');
        values.push(input.correct_pattern);
    }
    if ('detection_regex' in input) {
        sets.push('detection_regex = ?');
        values.push(input.detection_regex ?? null);
    }
    if (input.context !== undefined) {
        sets.push('context = ?');
        values.push(input.context);
    }
    if (input.severity !== undefined) {
        sets.push('severity = ?');
        values.push(input.severity);
    }
    if (input.auto_block !== undefined) {
        sets.push('auto_block = ?');
        values.push(input.auto_block ? 1 : 0);
    }
    if (input.confidence !== undefined) {
        sets.push('confidence = ?');
        values.push(input.confidence);
    }
    if (sets.length === 0)
        return getLearning(input.id);
    values.push(input.id);
    db.prepare(`UPDATE learnings SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getLearning(input.id);
}
export function deleteLearning(id) {
    const db = getDb();
    const result = db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
    return result.changes > 0;
}
export function incrementLearningOccurrence(id) {
    const db = getDb();
    db.prepare('UPDATE learnings SET occurrences = occurrences + 1 WHERE id = ?').run(id);
}
export function checkContentAgainstLearnings(content) {
    const learnings = getAutoBlockLearnings();
    const matches = [];
    for (const learning of learnings) {
        if (!learning.detection_regex)
            continue;
        try {
            const regex = new RegExp(learning.detection_regex, 'gm');
            const m = regex.test(content);
            if (m) {
                matches.push({ learning, match: learning.detection_regex });
                incrementLearningOccurrence(learning.id);
            }
        }
        catch {
            // Invalid regex, skip
        }
    }
    return matches;
}
export function runLearningsPruning() {
    const db = getDb();
    // auto_block = 1 wird NIEMALS archiviert
    const result = db.prepare(`
    UPDATE learnings
    SET archived_at = ?
    WHERE archived_at IS NULL
      AND auto_block = 0
      AND (
        (created_at < datetime('now', '-90 days') AND access_count = 0)
        OR
        (created_at < datetime('now', '-365 days') AND access_count < 3)
      )
  `).run(now());
    return { learnings_archived: Number(result.changes) };
}
//# sourceMappingURL=learnings.js.map