import { getDb, now, toJson, parseJson, type SQLInputValue } from '../db.js';

export interface Decision {
  id: number;
  session_id: string | null;
  created_at: string;
  category: string;
  title: string;
  reasoning: string;
  alternatives: Alternative[] | null;
  files_affected: string[] | null;
  superseded_by: number | null;
  confidence: string;
}

export interface Alternative {
  option: string;
  reason_rejected: string;
}

export interface AddDecisionInput {
  session_id?: string;
  category: string;
  title: string;
  reasoning: string;
  alternatives?: Alternative[];
  files_affected?: string[];
  confidence?: string;
}

export function addDecision(input: AddDecisionInput): Decision {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO decisions (session_id, created_at, category, title, reasoning, alternatives, files_affected, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id ?? null,
    now(),
    input.category,
    input.title,
    input.reasoning,
    toJson(input.alternatives),
    toJson(input.files_affected),
    input.confidence ?? 'high'
  );

  return getDecision(Number(result.lastInsertRowid))!;
}

export function getDecision(id: number): Decision | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    alternatives: parseJson<Alternative[]>(row.alternatives as string),
    files_affected: parseJson<string[]>(row.files_affected as string),
  } as Decision;
}

export function listDecisions(options: {
  category?: string;
  limit?: number;
  includeSuperseded?: boolean;
} = {}): Decision[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

  if (options.category) {
    conditions.push('category = ?');
    params.push(options.category);
  }
  if (!options.includeSuperseded) {
    conditions.push('superseded_by IS NULL');
  }

  let sql = 'SELECT * FROM decisions';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(options.limit ?? 20);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    alternatives: parseJson<Alternative[]>(row.alternatives as string),
    files_affected: parseJson<string[]>(row.files_affected as string),
  })) as Decision[];
}

export function searchDecisions(query: string, limit = 10): Decision[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.* FROM decisions d
    JOIN decisions_fts fts ON d.id = fts.rowid
    WHERE decisions_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    alternatives: parseJson<Alternative[]>(row.alternatives as string),
    files_affected: parseJson<string[]>(row.files_affected as string),
  })) as Decision[];
}

export function supersedeDecision(oldId: number, newId: number): void {
  const db = getDb();
  db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(newId, oldId);
}

export function getDecisionsForFile(filePath: string): Decision[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM decisions
    WHERE files_affected LIKE ?
    AND superseded_by IS NULL
    ORDER BY created_at DESC
  `).all(`%${filePath}%`) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    alternatives: parseJson<Alternative[]>(row.alternatives as string),
    files_affected: parseJson<string[]>(row.files_affected as string),
  })) as Decision[];
}
