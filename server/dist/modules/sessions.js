import { getDb, now, toJson, parseJson } from '../db.js';
export function createSession(input) {
    const db = getDb();
    const startedAt = input.started_at ?? now();
    db.prepare(`
    INSERT OR IGNORE INTO sessions (id, started_at, status)
    VALUES (?, ?, 'active')
  `).run(input.id, startedAt);
    return getSession(input.id);
}
export function getSession(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row)
        return null;
    return {
        ...row,
        key_changes: parseJson(row.key_changes),
    };
}
export function updateSession(id, input) {
    const db = getDb();
    const sets = [];
    const values = [];
    if (input.ended_at !== undefined) {
        sets.push('ended_at = ?');
        values.push(input.ended_at);
    }
    if (input.duration_seconds !== undefined) {
        sets.push('duration_seconds = ?');
        values.push(input.duration_seconds);
    }
    if (input.summary !== undefined) {
        sets.push('summary = ?');
        values.push(input.summary);
    }
    if (input.key_changes !== undefined) {
        sets.push('key_changes = ?');
        values.push(toJson(input.key_changes));
    }
    if (input.chain_id !== undefined) {
        sets.push('chain_id = ?');
        values.push(input.chain_id);
    }
    if (input.chain_label !== undefined) {
        sets.push('chain_label = ?');
        values.push(input.chain_label);
    }
    if (input.status !== undefined) {
        sets.push('status = ?');
        values.push(input.status);
    }
    if (sets.length === 0)
        return getSession(id);
    values.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getSession(id);
}
export function listSessions(limit = 20, chainId) {
    const db = getDb();
    let sql = 'SELECT * FROM sessions';
    const params = [];
    if (chainId) {
        sql += ' WHERE chain_id = ?';
        params.push(chainId);
    }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
        ...row,
        key_changes: parseJson(row.key_changes),
    }));
}
export function searchSessions(query, limit = 10) {
    const db = getDb();
    try {
        const rows = db.prepare(`
      SELECT s.* FROM sessions s
      JOIN sessions_fts fts ON s.rowid = fts.rowid
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit);
        return rows.map((row) => ({
            ...row,
            key_changes: parseJson(row.key_changes),
        }));
    }
    catch {
        // FTS-Tabelle nicht vorhanden -- LIKE-Fallback
        const likeQuery = `%${query}%`;
        const rows = db.prepare(`
      SELECT * FROM sessions
      WHERE summary LIKE ? OR key_changes LIKE ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(likeQuery, likeQuery, limit);
        return rows.map((row) => ({
            ...row,
            key_changes: parseJson(row.key_changes),
        }));
    }
}
export function getRecentSummaries(limit = 3) {
    const db = getDb();
    return db.prepare(`
    SELECT id, started_at, summary FROM sessions
    WHERE status != 'active'
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit);
}
export function detectSessionChain(sessionId) {
    const db = getDb();
    // Check if current session touches same files as recent sessions
    const currentDiffs = db.prepare(`
    SELECT DISTINCT file_path FROM diffs WHERE session_id = ?
  `).all(sessionId);
    if (currentDiffs.length === 0)
        return null;
    const currentFiles = currentDiffs.map((d) => d.file_path);
    // Look at recent sessions' files
    const recentSessions = db.prepare(`
    SELECT DISTINCT d.session_id, s.chain_id
    FROM diffs d
    JOIN sessions s ON s.id = d.session_id
    WHERE d.session_id != ?
    AND d.file_path IN (${currentFiles.map(() => '?').join(',')})
    ORDER BY s.started_at DESC
    LIMIT 5
  `).all(sessionId, ...currentFiles);
    // If recent session has a chain, join it
    for (const s of recentSessions) {
        if (s.chain_id)
            return s.chain_id;
    }
    // If >50% file overlap with a recent session, create a new chain
    if (recentSessions.length > 0) {
        return `chain_${Date.now()}`;
    }
    return null;
}
//# sourceMappingURL=sessions.js.map