import { getDb, toJson, parseJson } from '../db.js';

export interface Dependency {
  id: number;
  source_file: string;
  target_file: string;
  import_type: string;
  symbols: string[] | null;
}

export interface AddDependencyInput {
  source_file: string;
  target_file: string;
  import_type?: string;
  symbols?: string[];
}

export function addDependency(input: AddDependencyInput): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO dependencies (source_file, target_file, import_type, symbols)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_file, target_file) DO UPDATE SET
      import_type = excluded.import_type,
      symbols = excluded.symbols
  `).run(
    input.source_file,
    input.target_file,
    input.import_type ?? 'static',
    toJson(input.symbols)
  );
}

export function setFileDependencies(sourceFile: string, deps: AddDependencyInput[]): void {
  const db = getDb();
  // Use manual transaction (DatabaseSync has no .transaction() method)
  db.exec('BEGIN');  // eslint-disable-line
  try {
    // Remove old dependencies for this source
    db.prepare('DELETE FROM dependencies WHERE source_file = ?').run(sourceFile);
    // Insert new ones
    const stmt = db.prepare(`
      INSERT INTO dependencies (source_file, target_file, import_type, symbols)
      VALUES (?, ?, ?, ?)
    `);
    for (const dep of deps) {
      stmt.run(dep.source_file, dep.target_file, dep.import_type ?? 'static', toJson(dep.symbols));
    }
    db.exec('COMMIT');  // eslint-disable-line
  } catch (err) {
    db.exec('ROLLBACK');  // eslint-disable-line
    throw err;
  }
}

// What does this file import?
export function getImports(filePath: string): Dependency[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM dependencies WHERE source_file = ?'
  ).all(filePath) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    symbols: parseJson<string[]>(row.symbols as string),
  })) as Dependency[];
}

// What files import this file?
export function getImporters(filePath: string): Dependency[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM dependencies WHERE target_file = ?'
  ).all(filePath) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    symbols: parseJson<string[]>(row.symbols as string),
  })) as Dependency[];
}

// Full impact analysis: what would be affected if this file changes?
export function getImpactTree(filePath: string, maxDepth = 3): string[] {
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.file) || current.depth > maxDepth) continue;
    visited.add(current.file);

    const importers = getImporters(current.file);
    for (const imp of importers) {
      if (!visited.has(imp.source_file)) {
        queue.push({ file: imp.source_file, depth: current.depth + 1 });
      }
    }
  }

  visited.delete(filePath); // Remove the file itself
  return [...visited];
}

// Get dependency tree for a file (what it depends on, recursively)
export function getDependencyTree(filePath: string, maxDepth = 3): string[] {
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.file) || current.depth > maxDepth) continue;
    visited.add(current.file);

    const imports = getImports(current.file);
    for (const imp of imports) {
      if (!visited.has(imp.target_file)) {
        queue.push({ file: imp.target_file, depth: current.depth + 1 });
      }
    }
  }

  visited.delete(filePath);
  return [...visited];
}

export function getDependencyStats(): { totalFiles: number; totalEdges: number; orphans: number } {
  const db = getDb();
  const edges = db.prepare('SELECT COUNT(*) as count FROM dependencies').get() as { count: number };
  const allSources = db.prepare('SELECT DISTINCT source_file FROM dependencies').all() as Array<{ source_file: string }>;
  const allTargets = db.prepare('SELECT DISTINCT target_file FROM dependencies').all() as Array<{ target_file: string }>;
  const allFiles = new Set([...allSources.map(s => s.source_file), ...allTargets.map(t => t.target_file)]);
  const orphanRows = db.prepare(`
    SELECT path FROM project_files
    WHERE path NOT IN (SELECT source_file FROM dependencies)
    AND path NOT IN (SELECT target_file FROM dependencies)
  `).all() as Array<{ path: string }>;

  return {
    totalFiles: allFiles.size,
    totalEdges: edges.count,
    orphans: orphanRows.length,
  };
}
