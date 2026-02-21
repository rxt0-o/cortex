import { getDb, now, type SQLInputValue } from '../db.js';

export interface Learning {
  id: number;
  session_id: string | null;
  created_at: string;
  anti_pattern: string;
  correct_pattern: string;
  detection_regex: string | null;
  context: string;
  severity: string;
  occurrences: number;
  auto_block: boolean;
}

export interface AddLearningInput {
  session_id?: string;
  anti_pattern: string;
  correct_pattern: string;
  detection_regex?: string;
  context: string;
  severity?: string;
  auto_block?: boolean;
}

export function addLearning(input: AddLearningInput): Learning {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO learnings (session_id, created_at, anti_pattern, correct_pattern, detection_regex, context, severity, auto_block)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id ?? null,
    now(),
    input.anti_pattern,
    input.correct_pattern,
    input.detection_regex ?? null,
    input.context,
    input.severity ?? 'medium',
    input.auto_block ? 1 : 0
  );

  return getLearning(Number(result.lastInsertRowid))!;
}

export function getLearning(id: number): Learning | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...row, auto_block: Boolean(row.auto_block) } as unknown as Learning;
}

export function listLearnings(options: {
  severity?: string;
  autoBlockOnly?: boolean;
  limit?: number;
} = {}): Learning[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

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

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, auto_block: Boolean(row.auto_block) })) as unknown as Learning[];
}

export function searchLearnings(query: string, limit = 10): Learning[] {
  const db = getDb();
  // Try FTS first, fallback to LIKE
  try {
    const rows = db.prepare(`
      SELECT l.* FROM learnings l
      JOIN learnings_fts fts ON l.id = fts.rowid
      WHERE learnings_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Record<string, unknown>[];
    return rows.map((row) => ({ ...row, auto_block: Boolean(row.auto_block) })) as unknown as Learning[];
  } catch {
    // FTS not available, fallback
    const likeQuery = `%${query}%`;
    const rows = db.prepare(`
      SELECT * FROM learnings
      WHERE anti_pattern LIKE ? OR correct_pattern LIKE ? OR context LIKE ?
      LIMIT ?
    `).all(likeQuery, likeQuery, likeQuery, limit) as Record<string, unknown>[];
    return rows.map((row) => ({ ...row, auto_block: Boolean(row.auto_block) })) as unknown as Learning[];
  }
}

export function getAutoBlockLearnings(): Learning[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM learnings WHERE auto_block = 1').all() as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, auto_block: true })) as unknown as Learning[];
}

export function incrementLearningOccurrence(id: number): void {
  const db = getDb();
  db.prepare('UPDATE learnings SET occurrences = occurrences + 1 WHERE id = ?').run(id);
}

export function checkContentAgainstLearnings(content: string): Array<{
  learning: Learning;
  match: string;
}> {
  const learnings = getAutoBlockLearnings();
  const matches: Array<{ learning: Learning; match: string }> = [];

  for (const learning of learnings) {
    if (!learning.detection_regex) continue;
    try {
      const regex = new RegExp(learning.detection_regex, 'gm');
      const m = regex.test(content);
      if (m) {
        matches.push({ learning, match: learning.detection_regex });
        incrementLearningOccurrence(learning.id);
      }
    } catch {
      // Invalid regex, skip
    }
  }

  return matches;
}
