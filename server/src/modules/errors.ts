import { getDb, now, toJson, parseJson, type SQLInputValue } from '../db.js';
import { createHash } from 'crypto';

export interface CortexError {
  id: number;
  session_id: string | null;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  error_signature: string;
  error_message: string;
  root_cause: string | null;
  fix_description: string | null;
  fix_diff: string | null;
  files_involved: string[] | null;
  prevention_rule: string | null;
  severity: string;
  access_count: number;
  last_accessed: string | null;
  archived_at: string | null;
}

export interface AddErrorInput {
  session_id?: string;
  error_message: string;
  root_cause?: string;
  fix_description?: string;
  fix_diff?: string;
  files_involved?: string[];
  prevention_rule?: string;
  severity?: string;
}

// Create a normalized fingerprint for an error message
export function createErrorSignature(message: string): string {
  // Normalize: remove line numbers, paths, timestamps, hex values
  const normalized = message
    .replace(/\d+/g, 'N')          // Numbers → N
    .replace(/\/[\w./\-]+/g, 'PATH') // Paths → PATH
    .replace(/0x[a-fA-F0-9]+/g, 'HEX') // Hex → HEX
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim()
    .toLowerCase();

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function addError(input: AddErrorInput): CortexError {
  const db = getDb();
  const signature = createErrorSignature(input.error_message);
  const timestamp = now();

  // Upsert: increment if exists, insert if new
  const existing = db.prepare(
    'SELECT id, occurrences FROM errors WHERE error_signature = ?'
  ).get(signature) as { id: number; occurrences: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE errors SET
        last_seen = ?,
        occurrences = occurrences + 1,
        root_cause = COALESCE(?, root_cause),
        fix_description = COALESCE(?, fix_description),
        fix_diff = COALESCE(?, fix_diff),
        files_involved = COALESCE(?, files_involved),
        prevention_rule = COALESCE(?, prevention_rule),
        severity = COALESCE(?, severity)
      WHERE id = ?
    `).run(
      timestamp,
      input.root_cause ?? null,
      input.fix_description ?? null,
      input.fix_diff ?? null,
      toJson(input.files_involved) ?? null,
      input.prevention_rule ?? null,
      input.severity ?? null,
      existing.id
    );
    return getError(existing.id)!;
  }

  const result = db.prepare(`
    INSERT INTO errors (session_id, first_seen, last_seen, error_signature, error_message,
      root_cause, fix_description, fix_diff, files_involved, prevention_rule, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id ?? null,
    timestamp, timestamp,
    signature,
    input.error_message,
    input.root_cause ?? null,
    input.fix_description ?? null,
    input.fix_diff ?? null,
    toJson(input.files_involved),
    input.prevention_rule ?? null,
    input.severity ?? 'medium'
  );

  const insertedId = Number(result.lastInsertRowid);

  // Fire-and-forget embedding
  import('./embed-hooks.js').then(({ embedAsync }) =>
    embedAsync('error', insertedId, { error_message: input.error_message, root_cause: input.root_cause, fix_description: input.fix_description })
  ).catch(() => {});

  return getError(insertedId)!;
}

export function getError(id: number): CortexError | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM errors WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare('UPDATE errors SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now(), id);
  return {
    ...row,
    files_involved: parseJson<string[]>(row.files_involved as string),
  } as CortexError;
}

export function listErrors(options: {
  severity?: string;
  file?: string;
  limit?: number;
  withFix?: boolean;
} = {}): CortexError[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];
  conditions.push('archived_at IS NULL');

  if (options.severity) {
    conditions.push('severity = ?');
    params.push(options.severity);
  }
  if (options.file) {
    conditions.push('files_involved LIKE ?');
    params.push(`%${options.file}%`);
  }
  if (options.withFix) {
    conditions.push('fix_description IS NOT NULL');
  }

  let sql = 'SELECT * FROM errors';
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY last_seen DESC LIMIT ?';
  params.push(options.limit ?? 20);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    files_involved: parseJson<string[]>(row.files_involved as string),
  })) as CortexError[];
}

export function searchErrors(query: string, limit = 10): CortexError[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.* FROM errors e
    JOIN errors_fts fts ON e.id = fts.rowid
    WHERE errors_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    files_involved: parseJson<string[]>(row.files_involved as string),
  })) as CortexError[];
}

export function getErrorsForFiles(filePaths: string[]): CortexError[] {
  const db = getDb();
  const results: CortexError[] = [];

  for (const filePath of filePaths) {
    const rows = db.prepare(`
      SELECT * FROM errors
      WHERE files_involved LIKE ?
      ORDER BY occurrences DESC
    `).all(`%${filePath}%`) as Record<string, unknown>[];

    for (const row of rows) {
      results.push({
        ...row,
        files_involved: parseJson<string[]>(row.files_involved as string),
      } as CortexError);
    }
  }

  // Dedupe by id
  const seen = new Set<number>();
  return results.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

export interface UpdateErrorInput {
  id: number;
  fix_description?: string;
  root_cause?: string;
  fix_diff?: string;
  prevention_rule?: string;
  severity?: string;
}

export function updateError(input: UpdateErrorInput): CortexError | null {
  const db = getDb();
  const sets: string[] = [];
  const values: SQLInputValue[] = [];

  if (input.fix_description !== undefined) { sets.push('fix_description = ?'); values.push(input.fix_description); }
  if (input.root_cause !== undefined) { sets.push('root_cause = ?'); values.push(input.root_cause); }
  if (input.fix_diff !== undefined) { sets.push('fix_diff = ?'); values.push(input.fix_diff); }
  if (input.prevention_rule !== undefined) { sets.push('prevention_rule = ?'); values.push(input.prevention_rule); }
  if (input.severity !== undefined) { sets.push('severity = ?'); values.push(input.severity); }

  if (sets.length === 0) return getError(input.id);
  values.push(input.id);
  db.prepare(`UPDATE errors SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getError(input.id);
}

export interface ErrorPruningResult {
  errors_archived: number;
}

export function runErrorsPruning(): ErrorPruningResult {
  const db = getDb();
  const result = db.prepare(`
    UPDATE errors
    SET archived_at = ?
    WHERE archived_at IS NULL
      AND (
        (first_seen < datetime('now', '-90 days') AND access_count = 0)
        OR
        (first_seen < datetime('now', '-365 days') AND access_count < 3)
      )
  `).run(now());
  return { errors_archived: Number(result.changes) };
}

export function getPreventionRules(): Array<{ id: number; prevention_rule: string; error_message: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT id, prevention_rule, error_message FROM errors
    WHERE prevention_rule IS NOT NULL
  `).all() as Array<{ id: number; prevention_rule: string; error_message: string }>;
}
