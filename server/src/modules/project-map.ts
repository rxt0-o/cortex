import { getDb, now, toJson, parseJson, type SQLInputValue } from '../db.js';

export interface ProjectModule {
  id: number;
  path: string;
  name: string;
  layer: string;
  description: string | null;
  entry_points: string[] | null;
  conventions: string[] | null;
  last_scanned: string | null;
  last_changed: string | null;
}

export interface ProjectFile {
  id: number;
  path: string;
  module_id: number | null;
  file_type: string | null;
  description: string | null;
  exports: string[] | null;
  change_count: number;
  error_count: number;
  last_changed: string | null;
  last_changed_session: string | null;
}

export interface UpsertModuleInput {
  path: string;
  name: string;
  layer: string;
  description?: string;
  entry_points?: string[];
  conventions?: string[];
}

export interface UpsertFileInput {
  path: string;
  module_id?: number;
  file_type?: string;
  description?: string;
  exports?: string[];
}

export function upsertModule(input: UpsertModuleInput): ProjectModule {
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
  `).run(
    input.path,
    input.name,
    input.layer,
    input.description ?? null,
    toJson(input.entry_points),
    toJson(input.conventions),
    now()
  );

  return getModuleByPath(input.path)!;
}

export function getModuleByPath(path: string): ProjectModule | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM project_modules WHERE path = ?').get(path) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    entry_points: parseJson<string[]>(row.entry_points as string),
    conventions: parseJson<string[]>(row.conventions as string),
  } as ProjectModule;
}

export function listModules(layer?: string): ProjectModule[] {
  const db = getDb();
  let sql = 'SELECT * FROM project_modules';
  const params: SQLInputValue[] = [];

  if (layer) {
    sql += ' WHERE layer = ?';
    params.push(layer);
  }
  sql += ' ORDER BY layer, name';

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...row,
    entry_points: parseJson<string[]>(row.entry_points as string),
    conventions: parseJson<string[]>(row.conventions as string),
  })) as ProjectModule[];
}

export function upsertFile(input: UpsertFileInput): ProjectFile {
  const db = getDb();
  db.prepare(`
    INSERT INTO project_files (path, module_id, file_type, description, exports)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      module_id = COALESCE(excluded.module_id, project_files.module_id),
      file_type = COALESCE(excluded.file_type, project_files.file_type),
      description = COALESCE(excluded.description, project_files.description),
      exports = COALESCE(excluded.exports, project_files.exports)
  `).run(
    input.path,
    input.module_id ?? null,
    input.file_type ?? null,
    input.description ?? null,
    toJson(input.exports)
  );

  return getFileByPath(input.path)!;
}

export function getFileByPath(path: string): ProjectFile | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM project_files WHERE path = ?').get(path) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    exports: parseJson<string[]>(row.exports as string),
  } as ProjectFile;
}

export function trackFileChange(filePath: string, sessionId?: string): void {
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

export function getHotZones(limit = 20): ProjectFile[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM project_files
    WHERE change_count > 0
    ORDER BY change_count DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    exports: parseJson<string[]>(row.exports as string),
  })) as ProjectFile[];
}

export function getModuleSummary(): Array<{
  layer: string;
  modules: Array<{ name: string; path: string; fileCount: number }>;
}> {
  const db = getDb();
  const modules = db.prepare(`
    SELECT m.*, COUNT(f.id) as file_count
    FROM project_modules m
    LEFT JOIN project_files f ON f.module_id = m.id
    GROUP BY m.id
    ORDER BY m.layer, m.name
  `).all() as Array<Record<string, unknown>>;

  const layerMap = new Map<string, Array<{ name: string; path: string; fileCount: number }>>();
  for (const m of modules) {
    const layer = m.layer as string;
    if (!layerMap.has(layer)) layerMap.set(layer, []);
    layerMap.get(layer)!.push({
      name: m.name as string,
      path: m.path as string,
      fileCount: m.file_count as number,
    });
  }

  return [...layerMap.entries()].map(([layer, mods]) => ({ layer, modules: mods }));
}

export function inferFileType(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/components/')) return 'component';
  if (normalized.includes('/services/') || normalized.endsWith('service.ts')) return 'service';
  if (normalized.includes('/hooks/')) return 'hook';
  if (normalized.includes('/routes/') || normalized.includes('/api/')) return 'route';
  if (normalized.includes('/migrations/') || normalized.endsWith('.sql')) return 'migration';
  if (normalized.includes('/config/') || normalized.includes('.config.')) return 'config';
  if (normalized.includes('.test.') || normalized.includes('.spec.') || normalized.includes('__tests__')) return 'test';
  if (normalized.includes('/pages/') || normalized.includes('/views/')) return 'page';
  if (normalized.includes('/types/') || normalized.endsWith('.d.ts')) return 'type';
  if (normalized.includes('/utils/') || normalized.includes('/helpers/')) return 'util';
  return null;
}

export function inferModulePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  // Extract the directory up to the first meaningful boundary
  const parts = normalized.split('/');
  // Look for common module boundaries
  for (let i = parts.length - 2; i >= 0; i--) {
    const dir = parts[i];
    if (['src', 'app', 'lib'].includes(dir)) {
      return parts.slice(0, i + 2).join('/');
    }
  }
  // Fallback: parent directory
  return parts.slice(0, -1).join('/') || null;
}
