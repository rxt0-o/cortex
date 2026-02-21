import { getDb, now, toJson, parseJson, type SQLInputValue } from '../db.js';

export interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  summary: string | null;
  key_changes: KeyChange[] | null;
  chain_id: string | null;
  chain_label: string | null;
  status: string;
  tags: string[] | null;
}

export interface KeyChange {
  file: string;
  action: string;
  description: string;
}

export interface CreateSessionInput {
  id: string;
  started_at?: string;
}

export interface UpdateSessionInput {
  ended_at?: string;
  duration_seconds?: number;
  summary?: string;
  key_changes?: KeyChange[];
  chain_id?: string;
  chain_label?: string;
  status?: string;
}

export function createSession(input: CreateSessionInput): Session {
  const db = getDb();
  const startedAt = input.started_at ?? now();

  db.prepare(`
    INSERT OR IGNORE INTO sessions (id, started_at, status)
    VALUES (?, ?, 'active')
  `).run(input.id, startedAt);

  return getSession(input.id)!;
}

export function getSession(id: string): Session | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    key_changes: parseJson<KeyChange[]>(row.key_changes as string),
    tags: parseJson<string[]>(row.tags as string),
  } as Session;
}

export function updateSession(id: string, input: UpdateSessionInput): Session | null {
  const db = getDb();
  const sets: string[] = [];
  const values: SQLInputValue[] = [];

  if (input.ended_at !== undefined) { sets.push('ended_at = ?'); values.push(input.ended_at); }
  if (input.duration_seconds !== undefined) { sets.push('duration_seconds = ?'); values.push(input.duration_seconds); }
  if (input.summary !== undefined) { sets.push('summary = ?'); values.push(input.summary); }
  if (input.key_changes !== undefined) { sets.push('key_changes = ?'); values.push(toJson(input.key_changes)); }
  if (input.chain_id !== undefined) { sets.push('chain_id = ?'); values.push(input.chain_id); }
  if (input.chain_label !== undefined) { sets.push('chain_label = ?'); values.push(input.chain_label); }
  if (input.status !== undefined) { sets.push('status = ?'); values.push(input.status); }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export function listSessions(limit = 20, chainId?: string): Session[] {
  const db = getDb();
  let sql = 'SELECT * FROM sessions';
  const params: SQLInputValue[] = [];

  if (chainId) {
    sql += ' WHERE chain_id = ?';
    params.push(chainId);
  }

  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    key_changes: parseJson<KeyChange[]>(row.key_changes as string),
    tags: parseJson<string[]>(row.tags as string),
  })) as Session[];
}

export function searchSessions(query: string, limit = 10): Session[] {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT s.* FROM sessions s
      JOIN sessions_fts fts ON s.rowid = fts.rowid
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...row,
      key_changes: parseJson<KeyChange[]>(row.key_changes as string),
    })) as Session[];
  } catch {
    // FTS-Tabelle nicht vorhanden -- LIKE-Fallback
    const likeQuery = `%${query}%`;
    const rows = db.prepare(`
      SELECT * FROM sessions
      WHERE summary LIKE ? OR key_changes LIKE ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(likeQuery, likeQuery, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...row,
      key_changes: parseJson<KeyChange[]>(row.key_changes as string),
    })) as Session[];
  }
}

export function getRecentSummaries(limit = 3): Array<{ id: string; started_at: string; summary: string | null }> {
  const db = getDb();
  return db.prepare(`
    SELECT id, started_at, summary FROM sessions
    WHERE status != 'active'
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as Array<{ id: string; started_at: string; summary: string | null }>;
}

export function detectSessionChain(sessionId: string): string | null {
  const db = getDb();
  // Check if current session touches same files as recent sessions
  const currentDiffs = db.prepare(`
    SELECT DISTINCT file_path FROM diffs WHERE session_id = ?
  `).all(sessionId) as Array<{ file_path: string }>;

  if (currentDiffs.length === 0) return null;

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
  `).all(sessionId, ...currentFiles) as Array<{ session_id: string; chain_id: string | null }>;

  // If recent session has a chain, join it
  for (const s of recentSessions) {
    if (s.chain_id) return s.chain_id;
  }

  // If >50% file overlap with a recent session, create a new chain
  if (recentSessions.length > 0) {
    return `chain_${Date.now()}`;
  }

  return null;
}
