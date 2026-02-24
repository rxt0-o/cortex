import { getDb, now, type SQLInputValue } from '../db.js';

export interface Extraction {
  id: number;
  session_id: string;
  type: string;
  content: string;
  confidence: number;
  status: string;
  source_context: string | null;
  promoted_to_type: string | null;
  promoted_to_id: number | null;
  created_at: string;
}

/**
 * List pending or all auto-extractions.
 */
export function listExtractions(opts?: {
  status?: string;
  limit?: number;
}): Extraction[] {
  const db = getDb();
  const status = opts?.status ?? 'pending';
  const limit = opts?.limit ?? 50;

  if (status === 'all') {
    return db.prepare(
      'SELECT * FROM auto_extractions ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as unknown as Extraction[];
  }

  return db.prepare(
    'SELECT * FROM auto_extractions WHERE status = ? ORDER BY confidence DESC, created_at DESC LIMIT ?'
  ).all(status, limit) as unknown as Extraction[];
}

/**
 * Promote an extraction to a real cortex entry.
 */
export function promoteExtraction(id: number): { promoted: boolean; type: string; targetId: number } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM auto_extractions WHERE id = ?').get(id) as unknown as Extraction | undefined;
  if (!row) throw new Error(`Extraction #${id} not found`);
  if (row.status !== 'pending') throw new Error(`Extraction #${id} is already ${row.status}`);

  const ts = now();
  let targetId = 0;

  if (row.type === 'decision') {
    const result = db.prepare(
      `INSERT INTO decisions (session_id, created_at, category, title, reasoning, confidence)
       VALUES (?, ?, 'auto-extracted', ?, '[auto-extracted]', 'low')`
    ).run(row.session_id, ts, row.content);
    targetId = Number(result.lastInsertRowid);
  } else if (row.type === 'error') {
    const sig = `auto-${id}-${Date.now()}`;
    const result = db.prepare(
      `INSERT INTO errors (session_id, first_seen, last_seen, error_signature, error_message, severity)
       VALUES (?, ?, ?, ?, ?, 'medium')`
    ).run(row.session_id, ts, ts, sig, row.content);
    targetId = Number(result.lastInsertRowid);
  } else if (row.type === 'learning') {
    const result = db.prepare(
      `INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, context, confidence)
       VALUES (?, ?, ?, '[auto-extracted]', 'auto-extracted from transcript', 0.4)`
    ).run(row.session_id, ts, row.content);
    targetId = Number(result.lastInsertRowid);
  } else if (row.type === 'convention') {
    const result = db.prepare(
      `INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, context, confidence)
       VALUES (?, ?, ?, '[convention]', 'auto-extracted convention', 0.4)`
    ).run(row.session_id, ts, row.content);
    targetId = Number(result.lastInsertRowid);
  } else {
    throw new Error(`Unknown extraction type: ${row.type}`);
  }

  db.prepare(
    `UPDATE auto_extractions SET status = 'promoted', promoted_to_type = ?, promoted_to_id = ? WHERE id = ?`
  ).run(row.type === 'convention' ? 'learning' : row.type, targetId, id);

  return { promoted: true, type: row.type, targetId };
}

/**
 * Reject an extraction (mark as rejected).
 */
export function rejectExtraction(id: number): void {
  const db = getDb();
  const row = db.prepare('SELECT status FROM auto_extractions WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new Error(`Extraction #${id} not found`);
  db.prepare(`UPDATE auto_extractions SET status = 'rejected' WHERE id = ?`).run(id);
}
