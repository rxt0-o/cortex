import { getDb, now, type SQLInputValue } from '../db.js';

export interface Convention {
  id: number;
  name: string;
  description: string;
  detection_pattern: string | null;
  violation_pattern: string | null;
  examples_good: string[] | null;
  examples_bad: string[] | null;
  scope: string | null;
  source: string | null;
  violation_count: number;
  last_violated: string | null;
}

export interface AddConventionInput {
  name: string;
  description: string;
  detection_pattern?: string;
  violation_pattern?: string;
  examples_good?: string[];
  examples_bad?: string[];
  scope?: string;
  source?: string;
}

export function addConvention(input: AddConventionInput): Convention {
  const db = getDb();
  db.prepare(`
    INSERT INTO conventions (name, description, detection_pattern, violation_pattern, examples_good, examples_bad, scope, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      detection_pattern = COALESCE(excluded.detection_pattern, conventions.detection_pattern),
      violation_pattern = COALESCE(excluded.violation_pattern, conventions.violation_pattern),
      examples_good = COALESCE(excluded.examples_good, conventions.examples_good),
      examples_bad = COALESCE(excluded.examples_bad, conventions.examples_bad),
      scope = COALESCE(excluded.scope, conventions.scope),
      source = COALESCE(excluded.source, conventions.source)
  `).run(
    input.name,
    input.description,
    input.detection_pattern ?? null,
    input.violation_pattern ?? null,
    input.examples_good ? JSON.stringify(input.examples_good) : null,
    input.examples_bad ? JSON.stringify(input.examples_bad) : null,
    input.scope ?? null,
    input.source ?? null
  );

  return getConventionByName(input.name)!;
}

export function getConventionByName(name: string): Convention | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM conventions WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return null;
  return parseConventionRow(row);
}

export function listConventions(scope?: string): Convention[] {
  const db = getDb();
  let sql = 'SELECT * FROM conventions';
  const params: SQLInputValue[] = [];

  if (scope) {
    sql += ' WHERE scope = ?';
    params.push(scope);
  }
  sql += ' ORDER BY violation_count DESC, name';

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(parseConventionRow);
}

export function recordViolation(conventionId: number): void {
  const db = getDb();
  db.prepare('UPDATE conventions SET violation_count = violation_count + 1, last_violated = ? WHERE id = ?')
    .run(now(), conventionId);
}

export function checkContentAgainstConventions(content: string): Array<{
  convention: Convention;
  match: string;
  type: 'violation';
}> {
  const conventions = listConventions();
  const results: Array<{ convention: Convention; match: string; type: 'violation' }> = [];

  for (const conv of conventions) {
    if (!conv.violation_pattern) continue;
    try {
      const regex = new RegExp(conv.violation_pattern, 'gm');
      if (regex.test(content)) {
        results.push({ convention: conv, match: conv.violation_pattern, type: 'violation' });
        recordViolation(conv.id);
      }
    } catch {
      // Invalid regex, skip
    }
  }

  return results;
}

function parseConventionRow(row: Record<string, unknown>): Convention {
  return {
    ...row,
    examples_good: row.examples_good ? JSON.parse(row.examples_good as string) : null,
    examples_bad: row.examples_bad ? JSON.parse(row.examples_bad as string) : null,
  } as unknown as Convention;
}
