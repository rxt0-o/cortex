import { getDb, now } from '../db.js';

export interface DiffRecord {
  id: number;
  session_id: string | null;
  file_path: string;
  diff_content: string;
  change_type: string | null;
  lines_added: number;
  lines_removed: number;
  created_at: string;
}

export interface AddDiffInput {
  session_id?: string;
  file_path: string;
  diff_content: string;
  change_type?: string;
  lines_added?: number;
  lines_removed?: number;
}

export function addDiff(input: AddDiffInput): DiffRecord {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO diffs (session_id, file_path, diff_content, change_type, lines_added, lines_removed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.session_id ?? null,
    input.file_path,
    input.diff_content,
    input.change_type ?? null,
    input.lines_added ?? 0,
    input.lines_removed ?? 0,
    now()
  );

  return getDiff(Number(result.lastInsertRowid))!;
}

export function getDiff(id: number): DiffRecord | null {
  const db = getDb();
  return db.prepare('SELECT * FROM diffs WHERE id = ?').get(id) as DiffRecord | undefined ?? null;
}

export function getDiffsForFile(filePath: string, limit = 20): DiffRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM diffs WHERE file_path = ? ORDER BY created_at DESC LIMIT ?
  `).all(filePath, limit) as unknown as DiffRecord[];
}

export function getDiffsForSession(sessionId: string): DiffRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM diffs WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId) as unknown as DiffRecord[];
}

export function getRecentDiffs(limit = 50): DiffRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM diffs ORDER BY created_at DESC LIMIT ?
  `).all(limit) as unknown as DiffRecord[];
}

export function getDiffStats(): {
  totalDiffs: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  fileCount: number;
} {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_diffs,
      SUM(lines_added) as total_added,
      SUM(lines_removed) as total_removed,
      COUNT(DISTINCT file_path) as file_count
    FROM diffs
  `).get() as Record<string, number>;

  return {
    totalDiffs: stats.total_diffs ?? 0,
    totalLinesAdded: stats.total_added ?? 0,
    totalLinesRemoved: stats.total_removed ?? 0,
    fileCount: stats.file_count ?? 0,
  };
}
