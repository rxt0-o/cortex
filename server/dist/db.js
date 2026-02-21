import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
let db = null;
const SCHEMA_VERSION = 2;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  summary TEXT,
  key_changes TEXT,
  chain_id TEXT,
  chain_label TEXT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  alternatives TEXT,
  files_affected TEXT,
  superseded_by INTEGER REFERENCES decisions(id),
  confidence TEXT DEFAULT 'high',
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrences INTEGER DEFAULT 1,
  error_signature TEXT NOT NULL UNIQUE,
  error_message TEXT NOT NULL,
  root_cause TEXT,
  fix_description TEXT,
  fix_diff TEXT,
  files_involved TEXT,
  prevention_rule TEXT,
  severity TEXT DEFAULT 'medium',
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  anti_pattern TEXT NOT NULL,
  correct_pattern TEXT NOT NULL,
  detection_regex TEXT,
  context TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  occurrences INTEGER DEFAULT 1,
  auto_block INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS project_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  layer TEXT NOT NULL,
  description TEXT,
  entry_points TEXT,
  conventions TEXT,
  last_scanned TEXT,
  last_changed TEXT
);

CREATE TABLE IF NOT EXISTS project_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  module_id INTEGER REFERENCES project_modules(id),
  file_type TEXT,
  description TEXT,
  exports TEXT,
  change_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  last_changed TEXT,
  last_changed_session TEXT
);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  import_type TEXT DEFAULT 'static',
  symbols TEXT,
  UNIQUE(source_file, target_file)
);

CREATE TABLE IF NOT EXISTS diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  file_path TEXT NOT NULL,
  diff_content TEXT NOT NULL,
  change_type TEXT,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  detection_pattern TEXT,
  violation_pattern TEXT,
  examples_good TEXT,
  examples_bad TEXT,
  scope TEXT,
  source TEXT,
  violation_count INTEGER DEFAULT 0,
  last_violated TEXT
);

CREATE TABLE IF NOT EXISTS unfinished (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  description TEXT NOT NULL,
  context TEXT,
  priority TEXT DEFAULT 'medium',
  resolved_at TEXT,
  resolved_session TEXT
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  trend TEXT
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_chain_id ON sessions(chain_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
CREATE INDEX IF NOT EXISTS idx_errors_signature ON errors(error_signature);
CREATE INDEX IF NOT EXISTS idx_errors_severity ON errors(severity);
CREATE INDEX IF NOT EXISTS idx_learnings_auto_block ON learnings(auto_block);
CREATE INDEX IF NOT EXISTS idx_project_files_module ON project_files(module_id);
CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(path);
CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_file);
CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_file);
CREATE INDEX IF NOT EXISTS idx_diffs_session ON diffs(session_id);
CREATE INDEX IF NOT EXISTS idx_diffs_file ON diffs(file_path);
CREATE INDEX IF NOT EXISTS idx_unfinished_resolved ON unfinished(resolved_at);
CREATE INDEX IF NOT EXISTS idx_decisions_archived ON decisions(archived_at);
CREATE INDEX IF NOT EXISTS idx_learnings_archived ON learnings(archived_at);
CREATE INDEX IF NOT EXISTS idx_errors_archived ON errors(archived_at);
`;
function getDbPath(projectDir) {
    const dir = projectDir ?? process.cwd();
    const claudeDir = path.join(dir, '.claude');
    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
    }
    return path.join(claudeDir, 'cortex.db');
}
export function getDb(projectDir) {
    if (db)
        return db;
    const dbPath = getDbPath(projectDir);
    db = new DatabaseSync(dbPath);
    // Performance pragmas
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    initSchema(db);
    return db;
}
function initSchema(database) {
    const versionRow = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    if (!versionRow) {
        database.exec(SCHEMA_SQL);
        database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        return;
    }
    const current = database.prepare('SELECT version FROM schema_version').get();
    if (!current || current.version < SCHEMA_VERSION) {
        // Migration v1 auf v2: Access-Counter und Archivierung
        if (!current || current.version < 2) {
            const migrations = [
                'ALTER TABLE decisions ADD COLUMN access_count INTEGER DEFAULT 0',
                'ALTER TABLE decisions ADD COLUMN last_accessed TEXT',
                'ALTER TABLE decisions ADD COLUMN archived_at TEXT',
                'ALTER TABLE learnings ADD COLUMN access_count INTEGER DEFAULT 0',
                'ALTER TABLE learnings ADD COLUMN last_accessed TEXT',
                'ALTER TABLE learnings ADD COLUMN archived_at TEXT',
                'ALTER TABLE errors ADD COLUMN access_count INTEGER DEFAULT 0',
                'ALTER TABLE errors ADD COLUMN last_accessed TEXT',
                'ALTER TABLE errors ADD COLUMN archived_at TEXT',
            ];
            for (const sql of migrations) {
                try {
                    database.exec(sql);
                }
                catch { /* Spalte existiert bereits */ }
            }
        }
        database.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }
}
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
export function now() {
    return new Date().toISOString();
}
export function parseJson(value) {
    if (value === null || value === undefined || typeof value === 'number')
        return null;
    if (typeof value !== 'string')
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
export function toJson(value) {
    if (value === null || value === undefined)
        return null;
    return JSON.stringify(value);
}
export function ageLabel(dateStr) {
    if (!dateStr)
        return 'unknown';
    const d = (Date.now() - new Date(dateStr).getTime()) / 86400000;
    if (d < 3)
        return 'fresh';
    if (d < 14)
        return 'recent';
    if (d < 90)
        return 'established';
    if (d < 365)
        return 'legacy';
    return 'ancient';
}
//# sourceMappingURL=db.js.map