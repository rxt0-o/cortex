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
    `ALTER TABLE learnings ADD COLUMN superseded_by INTEGER REFERENCES learnings(id)`,
    `ALTER TABLE learnings ADD COLUMN superseded_at TEXT`,
    `ALTER TABLE learnings ADD COLUMN relevance TEXT DEFAULT 'maybe_relevant'`,
    `ALTER TABLE learnings ADD COLUMN write_gate_reason TEXT`,
    `CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id),
      created_at TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'fact',
      valid_until TEXT,
      superseded_by INTEGER REFERENCES facts(id),
      superseded_at TEXT,
      source TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id),
      created_at TEXT NOT NULL,
      observation TEXT NOT NULL,
      implication TEXT NOT NULL,
      context TEXT,
      relevance TEXT DEFAULT 'maybe_relevant'
    )`,
    `ALTER TABLE sessions ADD COLUMN sentiment TEXT`,
    `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT, created_at TEXT DEFAULT (datetime('now')), session_id TEXT)`,
    `CREATE TABLE IF NOT EXISTS user_profile (id INTEGER PRIMARY KEY DEFAULT 1, name TEXT, role TEXT, working_style TEXT, expertise_areas TEXT, communication_preference TEXT, updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS attention_anchors (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, priority INTEGER DEFAULT 5, created_at TEXT DEFAULT (datetime('now')), last_touched TEXT)`,
    `ALTER TABLE sessions ADD COLUMN emotional_tone TEXT`,
    `ALTER TABLE sessions ADD COLUMN mood_score INTEGER`,
    `ALTER TABLE sessions ADD COLUMN tags TEXT`,
    `ALTER TABLE notes ADD COLUMN project TEXT`,
    `ALTER TABLE unfinished ADD COLUMN project TEXT`,
    // FTS5 Virtual Tables fuer BM25-Search
    `CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(anti_pattern, correct_pattern, context, content='learnings', content_rowid='id')`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, reasoning, content='decisions', content_rowid='id')`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(error_message, root_cause, fix_description, content='errors', content_rowid='id')`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', content_rowid='id')`,
    // INSERT Trigger fuer automatische FTS-Sync
    `CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context) VALUES (new.id, new.anti_pattern, new.correct_pattern, new.context); END`,
    `CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN INSERT INTO decisions_fts(rowid, title, reasoning) VALUES (new.id, new.title, new.reasoning); END`,
    `CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description) VALUES (new.id, new.error_message, new.root_cause, new.fix_description); END`,
    `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END`,
  ];
  for (const sql of v04migrations) { try { db.exec(sql); } catch {} }  // eslint-disable-line

  // FTS Backfill: bestehende Daten in FTS-Tabellen laden (nur wenn leer)
  try {
    const ftsCount = db.prepare('SELECT COUNT(*) as c FROM learnings_fts').get()?.c ?? 0;
    if (ftsCount === 0) {
      db.prepare('INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context) SELECT id, anti_pattern, correct_pattern, context FROM learnings WHERE archived_at IS NULL').run();
      db.prepare('INSERT INTO decisions_fts(rowid, title, reasoning) SELECT id, title, reasoning FROM decisions WHERE archived_at IS NULL').run();
      db.prepare("INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description) SELECT id, error_message, COALESCE(root_cause,''), COALESCE(fix_description,'') FROM errors").run();
      db.prepare('INSERT INTO notes_fts(rowid, text) SELECT id, text FROM notes').run();
    }
  } catch { /* FTS-Tabellen noch nicht vorhanden oder bereits befuellt */ }

  return db;
}
