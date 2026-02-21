/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { getDb, now, toJson, parseJson } from '../db.js';
export function upsertModule(input) {
    const db = getDb();
    db.prepare(`
    INSERT INTO project_modules (path, name, layer, description, entry_points, conventions, last_scanned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      layer = excluded.layer,
      description = COALESCE(excluded.description, project_modules.description),
      entry_points = COALESCE(excluded.entry_points, project_modules.entry_points),
      conventions = COALESCE(excluded.conventions, project_modules.conventions),
      last_scanned = excluded.last_scanned
  `).run(input.path, input.name, input.layer, input.description ?? null, toJson(input.entry_points), toJson(input.conventions), now());
    return getModuleByPath(input.path);
}
export function getModuleByPath(path) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM project_modules WHERE path = ?').get(path);
    if (!row)
        return null;
    return {
        ...row,
        entry_points: parseJson(row.entry_points),
        conventions: parseJson(row.conventions),
    };
}
export function listModules(layer) {
    const db = getDb();
    let sql = 'SELECT * FROM project_modules';
    const params = [];
    if (layer) {
        sql += ' WHERE layer = ?';
        params.push(layer);
    }
    sql += ' ORDER BY layer, name';
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
        ...row,
        entry_points: parseJson(row.entry_points),
        conventions: parseJson(row.conventions),
    }));
}
export function upsertFile(input) {
    const db = getDb();
    db.prepare(`
    INSERT INTO project_files (path, module_id, file_type, description, exports)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      module_id = COALESCE(excluded.module_id, project_files.module_id),
      file_type = COALESCE(excluded.file_type, project_files.file_type),
      description = COALESCE(excluded.description, project_files.description),
      exports = COALESCE(excluded.exports, project_files.exports)
  `).run(input.path, input.module_id ?? null, input.file_type ?? null, input.description ?? null, toJson(input.exports));
    return getFileByPath(input.path);
}
export function getFileByPath(path) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM project_files WHERE path = ?').get(path);
    if (!row)
        return null;
    return {
        ...row,
        exports: parseJson(row.exports),
    };
}
export function trackFileChange(filePath, sessionId) {
    const db = getDb();
    const timestamp = now();
    // Upsert file entry
    db.prepare(`
    INSERT INTO project_files (path, change_count, last_changed, last_changed_session)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      change_count = project_files.change_count + 1,
      last_changed = ?,
      last_changed_session = COALESCE(?, project_files.last_changed_session)
  `).run(filePath, timestamp, sessionId ?? null, timestamp, sessionId ?? null);
}
export function getHotZones(limit = 20) {
    const db = getDb();
    const rows = db.prepare(`
    SELECT * FROM project_files
    WHERE change_count > 0
    ORDER BY change_count DESC
    LIMIT ?
  `).all(limit);
    return rows.map((row) => ({
        ...row,
        exports: parseJson(row.exports),
    }));
}
export function getModuleSummary() {
    const db = getDb();
    const modules = db.prepare(`
    SELECT m.*, COUNT(f.id) as file_count
    FROM project_modules m
    LEFT JOIN project_files f ON f.module_id = m.id
    GROUP BY m.id
    ORDER BY m.layer, m.name
  `).all();
    const layerMap = new Map();
    for (const m of modules) {
        const layer = m.layer;
        if (!layerMap.has(layer))
            layerMap.set(layer, []);
        layerMap.get(layer).push({
            name: m.name,
            path: m.path,
            fileCount: m.file_count,
        });
    }
    return [...layerMap.entries()].map(([layer, mods]) => ({ layer, modules: mods }));
}
export function inferFileType(filePath) {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/components/'))
        return 'component';
    if (normalized.includes('/services/') || normalized.endsWith('service.ts'))
        return 'service';
    if (normalized.includes('/hooks/'))
        return 'hook';
    if (normalized.includes('/routes/') || normalized.includes('/api/'))
        return 'route';
    if (normalized.includes('/migrations/') || normalized.endsWith('.sql'))
        return 'migration';
    if (normalized.includes('/config/') || normalized.includes('.config.'))
        return 'config';
    if (normalized.includes('.test.') || normalized.includes('.spec.') || normalized.includes('__tests__'))
        return 'test';
    if (normalized.includes('/pages/') || normalized.includes('/views/'))
        return 'page';
    if (normalized.includes('/types/') || normalized.endsWith('.d.ts'))
        return 'type';
    if (normalized.includes('/utils/') || normalized.includes('/helpers/'))
        return 'util';
    return null;
}
export function inferModulePath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    // AriseTools-spezifische Grenzen zuerst prüfen
    const boundaries = ['frontend/src', 'backend/app', 'supabase/migrations'];
    for (const boundary of boundaries) {
        const boundaryParts = boundary.split('/');
        for (let i = 0; i <= parts.length - boundaryParts.length; i++) {
            if (boundaryParts.every((bp, j) => parts[i + j] === bp)) {
                const moduleEnd = i + boundaryParts.length + 1;
                if (moduleEnd <= parts.length) {
                    return parts.slice(0, moduleEnd).join('/');
                }
            }
        }
    }
    // Generische Grenzen als Fallback
    for (let i = parts.length - 2; i >= 0; i--) {
        const dir = parts[i];
        if (['src', 'app', 'lib'].includes(dir)) {
            return parts.slice(0, i + 2).join('/');
        }
    }
    return parts.slice(0, -1).join('/') || null;
}
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.sql'];
const EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', '__pycache__', '.claude',
    'build', 'coverage', 'venv', '.venv', '.mypy_cache', '.pytest_cache', '.tox',
]);
export function scanProject(rootPath) {
    const db = getDb();
    const allFiles = collectFiles(rootPath);
    let depsCount = 0;
    // Alles in einer Transaktion für Atomizität und Performance
    db.exec('BEGIN');
    try {
        for (const filePath of allFiles) {
            const relativePath = filePath.replace(/\\/g, '/');
            const fileType = inferFileType(relativePath);
            const modulePath = inferModulePath(relativePath);
            if (modulePath) {
                const moduleName = modulePath.split('/').pop() ?? modulePath;
                const layer = inferLayer(relativePath);
                upsertModule({ path: modulePath, name: moduleName, layer });
                const mod = getModuleByPath(modulePath);
                if (mod) {
                    upsertFile({ path: relativePath, module_id: mod.id, file_type: fileType ?? undefined });
                }
            }
            else {
                upsertFile({ path: relativePath, file_type: fileType ?? undefined });
            }
            try {
                const ext = path.extname(filePath).slice(1).toLowerCase();
                if (['ts', 'tsx', 'js', 'jsx', 'py'].includes(ext)) {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const imports = extractImports(content, ext);
                    db.prepare('DELETE FROM dependencies WHERE source_file = ?').run(relativePath);
                    const stmt = db.prepare('INSERT OR IGNORE INTO dependencies (source_file, target_file, import_type) VALUES (?, ?, ?)');
                    for (const imp of imports) {
                        stmt.run(relativePath, imp, 'static');
                        depsCount++;
                    }
                }
            }
            catch { /* Datei nicht lesbar — überspringen */ }
        }
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    const moduleCount = db.prepare('SELECT COUNT(*) as c FROM project_modules').get().c;
    const fileCount = db.prepare('SELECT COUNT(*) as c FROM project_files').get().c;
    return { scanned: allFiles.length, modules: moduleCount, files: fileCount, dependencies: depsCount };
}
function collectFiles(dir) {
    const result = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (EXCLUDE_DIRS.has(entry.name))
                continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                result.push(...collectFiles(fullPath));
            }
            else if (SCAN_EXTENSIONS.includes(path.extname(entry.name))) {
                result.push(fullPath);
            }
        }
    }
    catch { /* nicht lesbar */ }
    return result;
}
function inferLayer(filePath) {
    const p = filePath.replace(/\\/g, '/').toLowerCase();
    if (p.includes('frontend/'))
        return 'frontend';
    if (p.includes('backend/'))
        return 'backend';
    if (p.includes('supabase/'))
        return 'database';
    if (p.includes('scripts/'))
        return 'tooling';
    return 'other';
}
function extractImports(content, ext) {
    const imports = [];
    if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
        const re = /import\s+(?:type\s+)?(?:\{[^}]*\}|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(content))) {
            if (m[1].startsWith('.') || m[1].startsWith('/'))
                imports.push(m[1]);
        }
    }
    else if (ext === 'py') {
        const re = /from\s+([\w.]+)\s+import/g;
        let m;
        while ((m = re.exec(content))) {
            if (m[1].startsWith('app') || m[1].includes('.'))
                imports.push(m[1]);
        }
    }
    return imports;
}
//# sourceMappingURL=project-map.js.map