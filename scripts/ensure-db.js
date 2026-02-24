// Shared DB initialization for hook scripts
import { existsSync, mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

// FTS-Schema aus Build-Artefakt laden (Single Source of Truth).
// Fallback: Inline-Konstanten falls dist/ nicht existiert (fresh clone ohne Build).
let ftsSchema;
try {
  ftsSchema = await import('../server/dist/shared/fts-schema.js');
} catch {
  ftsSchema = null;
}

// Inline-Fallback FTS-Definitionen (nur verwendet wenn Build-Artefakt nicht vorhanden)
const INLINE_FTS_TABLES = `
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(anti_pattern, correct_pattern, context, content='learnings', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, reasoning, content='decisions', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(error_message, root_cause, fix_description, content='errors', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(summary, key_changes, content='sessions', content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS unfinished_fts USING fts5(description, context, content='unfinished', content_rowid='id');
`;

const INLINE_FTS_TRIGGER_DROPS = `
DROP TRIGGER IF EXISTS learnings_ai;
DROP TRIGGER IF EXISTS learnings_au;
DROP TRIGGER IF EXISTS learnings_ad;
DROP TRIGGER IF EXISTS decisions_ai;
DROP TRIGGER IF EXISTS decisions_au;
DROP TRIGGER IF EXISTS decisions_ad;
DROP TRIGGER IF EXISTS errors_ai;
DROP TRIGGER IF EXISTS errors_au;
DROP TRIGGER IF EXISTS errors_ad;
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_au;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS sessions_ai;
DROP TRIGGER IF EXISTS sessions_au;
DROP TRIGGER IF EXISTS sessions_ad;
DROP TRIGGER IF EXISTS unfinished_ai;
DROP TRIGGER IF EXISTS unfinished_au;
DROP TRIGGER IF EXISTS unfinished_ad;
`;

const INLINE_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
    INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context)
    VALUES (new.id, new.anti_pattern, new.correct_pattern, COALESCE(new.context,''));
END;

CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE OF anti_pattern, correct_pattern, context ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, anti_pattern, correct_pattern, context)
    VALUES ('delete', old.id, old.anti_pattern, old.correct_pattern, COALESCE(old.context,''));
    INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context)
    VALUES (new.id, new.anti_pattern, new.correct_pattern, COALESCE(new.context,''));
END;

CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
    INSERT INTO learnings_fts(learnings_fts, rowid, anti_pattern, correct_pattern, context)
    VALUES ('delete', old.id, old.anti_pattern, old.correct_pattern, COALESCE(old.context,''));
END;

CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
    INSERT INTO decisions_fts(rowid, title, reasoning)
    VALUES (new.id, new.title, COALESCE(new.reasoning,''));
END;

CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE OF title, reasoning ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, reasoning)
    VALUES ('delete', old.id, old.title, COALESCE(old.reasoning,''));
    INSERT INTO decisions_fts(rowid, title, reasoning)
    VALUES (new.id, new.title, COALESCE(new.reasoning,''));
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, reasoning)
    VALUES ('delete', old.id, old.title, COALESCE(old.reasoning,''));
END;

CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN
    INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description)
    VALUES (new.id, COALESCE(new.error_message,''), COALESCE(new.root_cause,''), COALESCE(new.fix_description,''));
END;

CREATE TRIGGER IF NOT EXISTS errors_au AFTER UPDATE OF error_message, root_cause, fix_description ON errors BEGIN
    INSERT INTO errors_fts(errors_fts, rowid, error_message, root_cause, fix_description)
    VALUES ('delete', old.id, COALESCE(old.error_message,''), COALESCE(old.root_cause,''), COALESCE(old.fix_description,''));
    INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description)
    VALUES (new.id, COALESCE(new.error_message,''), COALESCE(new.root_cause,''), COALESCE(new.fix_description,''));
END;

CREATE TRIGGER IF NOT EXISTS errors_ad AFTER DELETE ON errors BEGIN
    INSERT INTO errors_fts(errors_fts, rowid, error_message, root_cause, fix_description)
    VALUES ('delete', old.id, COALESCE(old.error_message,''), COALESCE(old.root_cause,''), COALESCE(old.fix_description,''));
END;

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, text)
    VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF text ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
    INSERT INTO notes_fts(rowid, text)
    VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, summary, key_changes)
    VALUES (new.rowid, COALESCE(new.summary,''), COALESCE(new.key_changes,''));
END;

CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE OF summary, key_changes ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, summary, key_changes)
    VALUES ('delete', old.rowid, COALESCE(old.summary,''), COALESCE(old.key_changes,''));
    INSERT INTO sessions_fts(rowid, summary, key_changes)
    VALUES (new.rowid, COALESCE(new.summary,''), COALESCE(new.key_changes,''));
END;

CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, summary, key_changes)
    VALUES ('delete', old.rowid, COALESCE(old.summary,''), COALESCE(old.key_changes,''));
END;

CREATE TRIGGER IF NOT EXISTS unfinished_ai AFTER INSERT ON unfinished BEGIN
    INSERT INTO unfinished_fts(rowid, description, context)
    VALUES (new.id, new.description, COALESCE(new.context,''));
END;

CREATE TRIGGER IF NOT EXISTS unfinished_au AFTER UPDATE OF description, context ON unfinished BEGIN
    INSERT INTO unfinished_fts(unfinished_fts, rowid, description, context)
    VALUES ('delete', old.id, old.description, COALESCE(old.context,''));
    INSERT INTO unfinished_fts(rowid, description, context)
    VALUES (new.id, new.description, COALESCE(new.context,''));
END;

CREATE TRIGGER IF NOT EXISTS unfinished_ad AFTER DELETE ON unfinished BEGIN
    INSERT INTO unfinished_fts(unfinished_fts, rowid, description, context)
    VALUES ('delete', old.id, old.description, COALESCE(old.context,''));
END;
`;

const FTS_TABLES = ftsSchema ? ftsSchema.FTS_TABLES : INLINE_FTS_TABLES;
const FTS_TRIGGER_DROPS = ftsSchema ? ftsSchema.FTS_TRIGGER_DROPS : INLINE_FTS_TRIGGER_DROPS;
const FTS_TRIGGERS = ftsSchema ? ftsSchema.FTS_TRIGGERS : INLINE_FTS_TRIGGERS;

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
  superseded_by INTEGER REFERENCES decisions(id), confidence TEXT DEFAULT 'high',
  access_count INTEGER DEFAULT 0, last_accessed TEXT, archived_at TEXT,
  scope TEXT DEFAULT 'project'
);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, occurrences INTEGER DEFAULT 1,
  error_signature TEXT NOT NULL UNIQUE, error_message TEXT NOT NULL,
  root_cause TEXT, fix_description TEXT, fix_diff TEXT,
  files_involved TEXT, prevention_rule TEXT, severity TEXT DEFAULT 'medium',
  access_count INTEGER DEFAULT 0, last_accessed TEXT, archived_at TEXT,
  scope TEXT DEFAULT 'project'
);
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL, anti_pattern TEXT NOT NULL, correct_pattern TEXT NOT NULL,
  detection_regex TEXT, context TEXT NOT NULL, severity TEXT DEFAULT 'medium',
  occurrences INTEGER DEFAULT 1, auto_block INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0, last_accessed TEXT, archived_at TEXT,
  scope TEXT DEFAULT 'project'
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
  priority TEXT DEFAULT 'medium', resolved_at TEXT, resolved_session TEXT,
  blocked_by TEXT
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
CREATE INDEX IF NOT EXISTS idx_decisions_archived ON decisions(archived_at);
CREATE INDEX IF NOT EXISTS idx_learnings_archived ON learnings(archived_at);
CREATE INDEX IF NOT EXISTS idx_errors_archived ON errors(archived_at);
`;

export function openDb(cwd) {
  const claudeDir = join(cwd, '.claude');
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  const dbPath = join(claudeDir, 'cortex.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // Ensure schema
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (!t) db.exec(SCHEMA);

  // v04 migrations --- idempotent, Fehler werden ignoriert (Spalte existiert bereits)
  const v04migrations = [
    `ALTER TABLE unfinished ADD COLUMN snooze_until TEXT`,
    `ALTER TABLE unfinished ADD COLUMN priority_score INTEGER DEFAULT 50`,
    `ALTER TABLE decisions ADD COLUMN access_count INTEGER DEFAULT 0`,
    `ALTER TABLE decisions ADD COLUMN last_accessed TEXT`,
    `ALTER TABLE decisions ADD COLUMN archived_at TEXT`,
    `ALTER TABLE learnings ADD COLUMN access_count INTEGER DEFAULT 0`,
    `ALTER TABLE learnings ADD COLUMN last_accessed TEXT`,
    `ALTER TABLE learnings ADD COLUMN archived_at TEXT`,
    `ALTER TABLE errors ADD COLUMN access_count INTEGER DEFAULT 0`,
    `ALTER TABLE errors ADD COLUMN last_accessed TEXT`,
    `ALTER TABLE errors ADD COLUMN archived_at TEXT`,
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
    `ALTER TABLE unfinished ADD COLUMN blocked_by TEXT`,
    `ALTER TABLE decisions ADD COLUMN scope TEXT DEFAULT 'project'`,
    `ALTER TABLE errors ADD COLUMN scope TEXT DEFAULT 'project'`,
    `ALTER TABLE learnings ADD COLUMN scope TEXT DEFAULT 'project'`,
    `ALTER TABLE sessions ADD COLUMN sentiment TEXT`,
    `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT, created_at TEXT DEFAULT (datetime('now')), session_id TEXT)`,
    `ALTER TABLE sessions ADD COLUMN emotional_tone TEXT`,
    `ALTER TABLE sessions ADD COLUMN mood_score INTEGER`,
    `ALTER TABLE sessions ADD COLUMN tags TEXT`,
    `ALTER TABLE notes ADD COLUMN project TEXT`,
    `ALTER TABLE unfinished ADD COLUMN project TEXT`,
    // entity-links fuer notes + activity_log
    `ALTER TABLE notes ADD COLUMN entity_type TEXT`,
    `ALTER TABLE notes ADD COLUMN entity_id INTEGER`,
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      tool_name TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      session_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)`,
    `ALTER TABLE project_files ADD COLUMN cluster_id INTEGER`,
    `ALTER TABLE learnings ADD COLUMN confidence REAL DEFAULT 0.7`,
    `ALTER TABLE learnings ADD COLUMN shared INTEGER DEFAULT 0`,
    // Embeddings table for semantic search
    `CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, entity_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id)`,
    ];
  for (const sql of v04migrations) { try { db.exec(sql); } catch {} }

  // Phase 4: Brain Foundation --- neue Tabellen (idempotent)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS working_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      activation_level REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      last_accessed TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 1,
      metadata TEXT
    )`);
  } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_wm_session_activation ON working_memory(session_id, activation_level DESC)`); } catch {}

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      source_context TEXT,
      promoted_to_type TEXT,
      promoted_to_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ae_session_status ON auto_extractions(session_id, status)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ae_confidence ON auto_extractions(confidence)`); } catch {}

  // Phase 4: memory_strength + importance_score auf alle 5 Content-Tabellen
  const p4memStrengthMigrations = [
    `ALTER TABLE decisions ADD COLUMN memory_strength REAL DEFAULT 1.0`,
    `ALTER TABLE decisions ADD COLUMN importance_score REAL DEFAULT 0.5`,
    `ALTER TABLE errors ADD COLUMN memory_strength REAL DEFAULT 1.0`,
    `ALTER TABLE errors ADD COLUMN importance_score REAL DEFAULT 0.5`,
    `ALTER TABLE learnings ADD COLUMN memory_strength REAL DEFAULT 1.0`,
    `ALTER TABLE learnings ADD COLUMN importance_score REAL DEFAULT 0.5`,
    `ALTER TABLE notes ADD COLUMN memory_strength REAL DEFAULT 1.0`,
    `ALTER TABLE notes ADD COLUMN importance_score REAL DEFAULT 0.5`,
    `ALTER TABLE unfinished ADD COLUMN memory_strength REAL DEFAULT 1.0`,
    `ALTER TABLE unfinished ADD COLUMN importance_score REAL DEFAULT 0.5`,
    `ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0`,
    `ALTER TABLE notes ADD COLUMN last_accessed TEXT`,
    `ALTER TABLE unfinished ADD COLUMN access_count INTEGER DEFAULT 0`,
    `ALTER TABLE unfinished ADD COLUMN last_accessed TEXT`,
  ];
  for (const sql of p4memStrengthMigrations) { try { db.exec(sql); } catch {} }

  // Phase 4: Backfill NULL-Werte
  const p4backfills = [
    `UPDATE decisions SET memory_strength = 1.0 WHERE memory_strength IS NULL`,
    `UPDATE decisions SET importance_score = 0.5 WHERE importance_score IS NULL`,
    `UPDATE errors SET memory_strength = 1.0 WHERE memory_strength IS NULL`,
    `UPDATE errors SET importance_score = 0.5 WHERE importance_score IS NULL`,
    `UPDATE learnings SET memory_strength = 1.0 WHERE memory_strength IS NULL`,
    `UPDATE learnings SET importance_score = 0.5 WHERE importance_score IS NULL`,
    `UPDATE notes SET memory_strength = 1.0 WHERE memory_strength IS NULL`,
    `UPDATE notes SET importance_score = 0.5 WHERE importance_score IS NULL`,
    `UPDATE unfinished SET memory_strength = 1.0 WHERE memory_strength IS NULL`,
    `UPDATE unfinished SET importance_score = 0.5 WHERE importance_score IS NULL`,
    `UPDATE notes SET access_count = 0 WHERE access_count IS NULL`,
    `UPDATE unfinished SET access_count = 0 WHERE access_count IS NULL`,
  ];
  for (const sql of p4backfills) { try { db.prepare(sql).run(); } catch {} }

  // Phase 4: Neue Indizes fuer memory_strength + importance_score
  const p4IndexMigrations = [
    `CREATE INDEX IF NOT EXISTS idx_decisions_strength ON decisions(memory_strength)`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_importance ON decisions(importance_score)`,
    `CREATE INDEX IF NOT EXISTS idx_errors_strength ON errors(memory_strength)`,
    `CREATE INDEX IF NOT EXISTS idx_errors_importance ON errors(importance_score)`,
    `CREATE INDEX IF NOT EXISTS idx_learnings_strength ON learnings(memory_strength)`,
    `CREATE INDEX IF NOT EXISTS idx_learnings_importance ON learnings(importance_score)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_strength ON notes(memory_strength)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_importance ON notes(importance_score)`,
    `CREATE INDEX IF NOT EXISTS idx_unfinished_strength ON unfinished(memory_strength)`,
    `CREATE INDEX IF NOT EXISTS idx_unfinished_importance ON unfinished(importance_score)`,
  ];
  for (const sql of p4IndexMigrations) { try { db.exec(sql); } catch {} }

  // Phase 6: memory_associations Tabelle (idempotent)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_associations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      strength REAL DEFAULT 1.0,
      last_activated TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_type, source_id, target_type, target_id, relation),
      CHECK(strength >= 0.0 AND strength <= 1.0),
      CHECK(NOT (source_type = target_type AND source_id = target_id))
    )`);
  } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ma_source ON memory_associations(source_type, source_id)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ma_target ON memory_associations(target_type, target_id)`); } catch {}

  // Phase 0: FTS5 Virtual Tables --- idempotent (IF NOT EXISTS)
  try { db.exec(FTS_TABLES); } catch {}

  // Phase 0: FTS Trigger DROP + CREATE --- kaputte Trigger werden ersetzt
  try { db.exec(FTS_TRIGGER_DROPS); } catch {}
  try { db.exec(FTS_TRIGGERS); } catch {}

  // Backfill: NULL confidence → 0.7 (eliminiert COALESCE in allen Queries)
  try { db.prepare(`UPDATE learnings SET confidence = 0.7 WHERE confidence IS NULL`).run(); } catch {}

  // FTS Backfill: bestehende Daten in FTS-Tabellen laden (nur wenn leer)
  try {
    const ftsCount = db.prepare('SELECT COUNT(*) as c FROM learnings_fts').get()?.c ?? 0;
    if (ftsCount === 0) {
      db.prepare("INSERT INTO learnings_fts(rowid, anti_pattern, correct_pattern, context) SELECT id, anti_pattern, correct_pattern, COALESCE(context,'') FROM learnings WHERE archived_at IS NULL").run();
      db.prepare("INSERT INTO decisions_fts(rowid, title, reasoning) SELECT id, title, COALESCE(reasoning,'') FROM decisions WHERE archived_at IS NULL").run();
      db.prepare("INSERT INTO errors_fts(rowid, error_message, root_cause, fix_description) SELECT id, error_message, COALESCE(root_cause,''), COALESCE(fix_description,'') FROM errors").run();
      db.prepare('INSERT INTO notes_fts(rowid, text) SELECT id, text FROM notes').run();
    }
  } catch { /* FTS-Tabellen noch nicht vorhanden oder bereits befuellt */ }

  // Sessions + Unfinished FTS Backfill
  try {
    const sftsCount = db.prepare('SELECT COUNT(*) as c FROM sessions_fts').get()?.c ?? 0;
    if (sftsCount === 0) {
      db.prepare("INSERT INTO sessions_fts(rowid, summary, key_changes) SELECT rowid, COALESCE(summary,''), COALESCE(key_changes,'') FROM sessions WHERE status != 'active'").run();
    }
  } catch {}
  try {
    const uftsCount = db.prepare('SELECT COUNT(*) as c FROM unfinished_fts').get()?.c ?? 0;
    if (uftsCount === 0) {
      db.prepare("INSERT INTO unfinished_fts(rowid, description, context) SELECT id, description, COALESCE(context,'') FROM unfinished WHERE resolved_at IS NULL").run();
    }
  } catch {}

  return db;
}
