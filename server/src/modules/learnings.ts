import { getDb, now, type SQLInputValue } from '../db.js';
import { findSimilar } from '../utils/similarity.js';

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
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
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

export interface AddLearningResult {
  learning: Learning;
  duplicate?: { id: number; score: number; anti_pattern: string };
}

export function addLearning(input: AddLearningInput): AddLearningResult {
  const db = getDb();

  // Duplikat-Check vor INSERT
  const existing = db.prepare(
    'SELECT id, anti_pattern, correct_pattern FROM learnings WHERE archived_at IS NULL LIMIT 500'
  ).all() as { id: number; anti_pattern: string; correct_pattern: string }[];
  const corpus = existing.map(e => ({ id: e.id, text: e.anti_pattern + ' ' + e.correct_pattern }));
  const similar = findSimilar(input.anti_pattern + ' ' + input.correct_pattern, corpus);

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

  const learning = getLearning(Number(result.lastInsertRowid))!;

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

export function getLearning(id: number): Learning | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('UPDATE learnings SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
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
  const rows = db.prepare('SELECT * FROM learnings WHERE auto_block = 1 AND archived_at IS NULL').all() as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, auto_block: true })) as unknown as Learning[];
}

export interface UpdateLearningInput {
  id: number;
  anti_pattern?: string;
  correct_pattern?: string;
  detection_regex?: string | null;
  context?: string;
  severity?: string;
  auto_block?: boolean;
}

export function updateLearning(input: UpdateLearningInput): Learning | null {
  const db = getDb();
  const sets: string[] = [];
  const values: SQLInputValue[] = [];

  if (input.anti_pattern !== undefined) { sets.push('anti_pattern = ?'); values.push(input.anti_pattern); }
  if (input.correct_pattern !== undefined) { sets.push('correct_pattern = ?'); values.push(input.correct_pattern); }
  if ('detection_regex' in input) { sets.push('detection_regex = ?'); values.push(input.detection_regex ?? null); }
  if (input.context !== undefined) { sets.push('context = ?'); values.push(input.context); }
  if (input.severity !== undefined) { sets.push('severity = ?'); values.push(input.severity); }
  if (input.auto_block !== undefined) { sets.push('auto_block = ?'); values.push(input.auto_block ? 1 : 0); }

  if (sets.length === 0) return getLearning(input.id);
  values.push(input.id);
  db.prepare(`UPDATE learnings SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getLearning(input.id);
}

export function deleteLearning(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
  return result.changes > 0;
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

export interface LearningPruningResult {
  learnings_archived: number;
}

export function runLearningsPruning(): LearningPruningResult {
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
