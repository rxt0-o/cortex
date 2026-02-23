import { getDb, now, toJson, parseJson, type SQLInputValue } from '../db.js';
import { findSimilar } from '../utils/similarity.js';

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
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
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

export interface AddDecisionResult {
  decision: Decision;
  duplicate?: { id: number; score: number; title: string };
}

export function addDecision(input: AddDecisionInput): AddDecisionResult {
  const db = getDb();

  // Duplikat-Check vor INSERT
  const existing = db.prepare(
    'SELECT id, title, reasoning FROM decisions WHERE archived_at IS NULL LIMIT 200'
  ).all() as { id: number; title: string; reasoning: string }[];
  const corpus = existing.map(e => ({ id: e.id, text: e.title + ' ' + e.reasoning }));
  const similar = findSimilar(input.title + ' ' + input.reasoning, corpus);

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

  const insertedId = Number(result.lastInsertRowid);

  // Fire-and-forget embedding
  import('./embed-hooks.js').then(({ embedAsync }) =>
    embedAsync('decision', insertedId, { title: input.title, reasoning: input.reasoning })
  ).catch(() => {});

  const decision = getDecision(insertedId)!;

  if (similar.length > 0) {
    const top = similar[0];
    const topEntry = existing.find(e => e.id === top.id);
    return {
      decision,
      duplicate: {
        id: top.id,
        score: Math.round(top.score * 100),
        title: topEntry?.title ?? '',
      },
    };
  }

  return { decision };
}

export function getDecision(id: number): Decision | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('UPDATE decisions SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
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
  conditions.push('archived_at IS NULL');

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

export interface DecisionPruningResult {
  decisions_archived: number;
}

export function runDecisionsPruning(): DecisionPruningResult {
  const db = getDb();
  const result = db.prepare(`
    UPDATE decisions
    SET archived_at = ?
    WHERE archived_at IS NULL
      AND superseded_by IS NULL
      AND (
        (created_at < datetime('now', '-90 days') AND access_count = 0)
        OR
        (created_at < datetime('now', '-365 days') AND access_count < 3)
      )
  `).run(now());
  return { decisions_archived: Number(result.changes) };
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
