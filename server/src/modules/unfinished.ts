import { getDb, now, type SQLInputValue } from '../db.js';

export interface UnfinishedItem {
  id: number;
  session_id: string | null;
  created_at: string;
  description: string;
  context: string | null;
  priority: string;
  resolved_at: string | null;
  resolved_session: string | null;
}

export interface AddUnfinishedInput {
  session_id?: string;
  description: string;
  context?: string;
  priority?: string;
}

export function addUnfinished(input: AddUnfinishedInput): UnfinishedItem {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO unfinished (session_id, created_at, description, context, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.session_id ?? null,
    now(),
    input.description,
    input.context ?? null,
    input.priority ?? 'medium'
  );

  const insertedId = Number(result.lastInsertRowid);

  // Fire-and-forget embedding
  import('./embed-hooks.js').then(({ embedAsync }) =>
    embedAsync('todo', insertedId, { description: input.description, context: input.context })
  ).catch(() => {});

  return getUnfinished(insertedId)!;
}

export function getUnfinished(id: number): UnfinishedItem | null {
  const db = getDb();
  return db.prepare('SELECT * FROM unfinished WHERE id = ?').get(id) as UnfinishedItem | undefined ?? null;
}

export function listUnfinished(options: {
  includeResolved?: boolean;
  limit?: number;
} = {}): UnfinishedItem[] {
  const db = getDb();
  let sql = 'SELECT * FROM unfinished';
  const params: SQLInputValue[] = [];

  if (!options.includeResolved) {
    sql += ' WHERE resolved_at IS NULL';
  }

  sql += ' ORDER BY CASE priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC LIMIT ?';
  params.push(options.limit ?? 50);

  return db.prepare(sql).all(...params) as unknown as UnfinishedItem[];
}

export function resolveUnfinished(id: number, resolvedSession?: string): unknown {
  const db = getDb();
  db.prepare(`
    UPDATE unfinished SET resolved_at = ?, resolved_session = ? WHERE id = ?
  `).run(now(), resolvedSession ?? null, id);
  return db.prepare('SELECT * FROM unfinished WHERE id = ?').get(id);
}

export function getOpenCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM unfinished WHERE resolved_at IS NULL').get() as { count: number };
  return row.count;
}
