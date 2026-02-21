import { getDb, toJson, parseJson } from '../db.js';
export function addDependency(input) {
    const db = getDb();
    db.prepare(`
    INSERT INTO dependencies (source_file, target_file, import_type, symbols)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_file, target_file) DO UPDATE SET
      import_type = excluded.import_type,
      symbols = excluded.symbols
  `).run(input.source_file, input.target_file, input.import_type ?? 'static', toJson(input.symbols));
}
export function setFileDependencies(sourceFile, deps) {
    const db = getDb();
    // Use manual transaction (DatabaseSync has no .transaction() method)
    db.exec('BEGIN'); // eslint-disable-line
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
        db.exec('COMMIT'); // eslint-disable-line
    }
    catch (err) {
        db.exec('ROLLBACK'); // eslint-disable-line
        throw err;
    }
}
// What does this file import?
export function getImports(filePath) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM dependencies WHERE source_file = ?').all(filePath);
    return rows.map((row) => ({
        ...row,
        symbols: parseJson(row.symbols),
    }));
}
// What files import this file?
export function getImporters(filePath) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM dependencies WHERE target_file = ?').all(filePath);
    return rows.map((row) => ({
        ...row,
        symbols: parseJson(row.symbols),
    }));
}
// Full impact analysis: what would be affected if this file changes?
export function getImpactTree(filePath, maxDepth = 3) {
    const visited = new Set();
    const queue = [{ file: filePath, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current.file) || current.depth > maxDepth)
            continue;
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
export function getDependencyTree(filePath, maxDepth = 3) {
    const visited = new Set();
    const queue = [{ file: filePath, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current.file) || current.depth > maxDepth)
            continue;
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
export function getDependencyStats() {
    const db = getDb();
    const edges = db.prepare('SELECT COUNT(*) as count FROM dependencies').get();
    const allSources = db.prepare('SELECT DISTINCT source_file FROM dependencies').all();
    const allTargets = db.prepare('SELECT DISTINCT target_file FROM dependencies').all();
    const allFiles = new Set([...allSources.map(s => s.source_file), ...allTargets.map(t => t.target_file)]);
    const orphanRows = db.prepare(`
    SELECT path FROM project_files
    WHERE path NOT IN (SELECT source_file FROM dependencies)
    AND path NOT IN (SELECT target_file FROM dependencies)
  `).all();
    return {
        totalFiles: allFiles.size,
        totalEdges: edges.count,
        orphans: orphanRows.length,
    };
}
//# sourceMappingURL=dependencies.js.map