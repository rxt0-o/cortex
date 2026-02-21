// Shared DB initialization for hook scripts
import { existsSync, mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
  duration_seconds INTEGER, summary TEXT, key_changes TEXT,
  chain_id TEXT, chain_label TEXT, status TEXT DEFAULT 'active',
  tags TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
  reasoning TEXT NOT NULL, alternatives TEXT, files_affected TEXT,
  superseded_by INTEGER REFERENCES decisions(id), confidence TEXT DEFAULT 'high'
);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, occurrences INTEGER DEFAULT 1,
  error_signature TEXT NOT NULL UNIQUE, error_message TEXT NOT NULL,
  root_cause TEXT, fix_description TEXT, fix_diff TEXT,
  files_involved TEXT, prevention_rule TEXT, severity TEXT DEFAULT 'medium'
);
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL, anti_pattern TEXT NOT NULL, correct_pattern TEXT NOT NULL,
  detection_regex TEXT, context TEXT NOT NULL, severity TEXT DEFAULT 'medium',
  occurrences INTEGER DEFAULT 1, auto_block INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, layer TEXT NOT NULL, description TEXT,
  entry_points TEXT, conventions TEXT, last_scanned TEXT, last_changed TEXT
);
CREATE TABLE IF NOT EXISTS project_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
  module_id INTEGER REFERENCES project_modules(id), file_type TEXT,
  description TEXT, exports TEXT, change_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0, last_changed TEXT, last_changed_session TEXT
);
CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL,
  target_file TEXT NOT NULL, import_type TEXT DEFAULT 'static', symbols TEXT,
  UNIQUE(source_file, target_file)
);
CREATE TABLE IF NOT EXISTS diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  file_path TEXT NOT NULL, diff_content TEXT NOT NULL, change_type TEXT,
  lines_added INTEGER DEFAULT 0, lines_removed INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL, detection_pattern TEXT, violation_pattern TEXT,
  examples_good TEXT, examples_bad TEXT, scope TEXT, source TEXT,
  violation_count INTEGER DEFAULT 0, last_violated TEXT
);
CREATE TABLE IF NOT EXISTS unfinished (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL, description TEXT NOT NULL, context TEXT,
  priority TEXT DEFAULT 'medium', resolved_at TEXT, resolved_session TEXT
);
CREATE TABLE IF NOT EXISTS health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL, metrics TEXT NOT NULL, trend TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_errors_signature ON errors(error_signature);
CREATE INDEX IF NOT EXISTS idx_learnings_auto_block ON learnings(auto_block);
CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(path);
CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_file);
CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_file);
CREATE INDEX IF NOT EXISTS idx_diffs_session ON diffs(session_id);
CREATE INDEX IF NOT EXISTS idx_diffs_file ON diffs(file_path);
CREATE INDEX IF NOT EXISTS idx_unfinished_resolved ON unfinished(resolved_at);
`;

export function openDb(cwd) {
  const claudeDir = join(cwd, '.claude');
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  const dbPath = join(claudeDir, 'cortex.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');  // eslint-disable-line
  db.exec('PRAGMA foreign_keys = ON');  // eslint-disable-line
  // Ensure schema
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (!t) db.exec(SCHEMA);  // eslint-disable-line

  // v04 migrations — idempotent, Fehler werden ignoriert (Spalte existiert bereits)
  const v04migrations = [
    `ALTER TABLE unfinished ADD COLUMN snooze_until TEXT`,
    `ALTER TABLE unfinished ADD COLUMN priority_score INTEGER DEFAULT 50`,
    `ALTER TABLE learnings ADD COLUMN archived INTEGER DEFAULT 0`,
    `ALTER TABLE learnings ADD COLUMN core_memory INTEGER DEFAULT 0`,
    `ALTER TABLE learnings ADD COLUMN example_code TEXT`,
    `ALTER TABLE learnings ADD COLUMN theoretical_hits INTEGER DEFAULT 0`,
    `ALTER TABLE learnings ADD COLUMN practical_violations INTEGER DEFAULT 0`,
    `ALTER TABLE decisions ADD COLUMN archived INTEGER DEFAULT 0`,
    `ALTER TABLE decisions ADD COLUMN stale INTEGER DEFAULT 0`,
    `ALTER TABLE decisions ADD COLUMN reviewed_at TEXT`,
    `ALTER TABLE decisions ADD COLUMN counter_arguments TEXT`,
    `ALTER TABLE errors ADD COLUMN archived INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN sentiment TEXT`,
    `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT, created_at TEXT DEFAULT (datetime('now')), session_id TEXT)`,
  ];
  for (const sql of v04migrations) { try { db.exec(sql); } catch {} }  // eslint-disable-line

  return db;
}
