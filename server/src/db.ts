import { DatabaseSync } from 'node:sqlite';
export type { SQLInputValue } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { FTS_TABLES, FTS_TRIGGER_DROPS, FTS_TRIGGERS } from './shared/fts-schema.js';

let db: InstanceType<typeof DatabaseSync> | null = null;
let vecAvailable = false;
let vecExtensionPath: string | null = null;
let vecInitError: string | null = null;
const require = createRequire(import.meta.url);

const SCHEMA_VERSION = 10;

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
  status TEXT DEFAULT 'active',
  tags TEXT,
  sentiment TEXT,
  emotional_tone TEXT,
  mood_score INTEGER
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
  archived_at TEXT,
  archived INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0,
  reviewed_at TEXT,
  counter_arguments TEXT,
  scope TEXT DEFAULT 'project',
  memory_strength REAL DEFAULT 1.0,
  importance_score REAL DEFAULT 0.5
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
  archived_at TEXT,
  archived INTEGER DEFAULT 0,
  scope TEXT DEFAULT 'project',
  memory_strength REAL DEFAULT 1.0,
  importance_score REAL DEFAULT 0.5
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
  archived_at TEXT,
  archived INTEGER DEFAULT 0,
  core_memory INTEGER DEFAULT 0,
  example_code TEXT,
  theoretical_hits INTEGER DEFAULT 0,
  practical_violations INTEGER DEFAULT 0,
  superseded_by INTEGER REFERENCES learnings(id),
  superseded_at TEXT,
  relevance TEXT DEFAULT 'maybe_relevant',
  write_gate_reason TEXT,
  confidence REAL DEFAULT 0.7,
  shared INTEGER DEFAULT 0,
  scope TEXT DEFAULT 'project',
  memory_strength REAL DEFAULT 1.0,
  importance_score REAL DEFAULT 0.5
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
  last_changed_session TEXT,
  cluster_id INTEGER
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
  resolved_session TEXT,
  snooze_until TEXT,
  priority_score INTEGER DEFAULT 50,
  project TEXT,
  blocked_by TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  memory_strength REAL DEFAULT 1.0,
  importance_score REAL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  trend TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  tags TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  session_id TEXT,
  project TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  memory_strength REAL DEFAULT 1.0,
  importance_score REAL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  tool_name TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS embedding_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS working_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  activation_level REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  last_accessed TEXT DEFAULT (datetime('now')),
  access_count INTEGER DEFAULT 1,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS auto_extractions (
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
);

CREATE TABLE IF NOT EXISTS memory_associations (
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
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_embedding_meta_entity ON embedding_meta(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_wm_session_activation ON working_memory(session_id, activation_level DESC);
CREATE INDEX IF NOT EXISTS idx_ae_session_status ON auto_extractions(session_id, status);
CREATE INDEX IF NOT EXISTS idx_ae_confidence ON auto_extractions(confidence);

CREATE INDEX IF NOT EXISTS idx_ma_source ON memory_associations(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_ma_target ON memory_associations(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_decisions_strength ON decisions(memory_strength);
CREATE INDEX IF NOT EXISTS idx_decisions_importance ON decisions(importance_score);
CREATE INDEX IF NOT EXISTS idx_errors_strength ON errors(memory_strength);
CREATE INDEX IF NOT EXISTS idx_errors_importance ON errors(importance_score);
CREATE INDEX IF NOT EXISTS idx_learnings_strength ON learnings(memory_strength);
CREATE INDEX IF NOT EXISTS idx_learnings_importance ON learnings(importance_score);
CREATE INDEX IF NOT EXISTS idx_notes_strength ON notes(memory_strength);
CREATE INDEX IF NOT EXISTS idx_notes_importance ON notes(importance_score);
CREATE INDEX IF NOT EXISTS idx_unfinished_strength ON unfinished(memory_strength);
CREATE INDEX IF NOT EXISTS idx_unfinished_importance ON unfinished(importance_score);
`;

// FTS_TABLES und FTS_TRIGGERS werden dynamisch in initSchema() eingefügt

const COMPAT_MIGRATIONS: string[] = [
  // Canonical tables (safe on existing DBs)
  `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    session_id TEXT,
    project TEXT,
    entity_type TEXT,
    entity_id INTEGER
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    tool_name TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    session_id TEXT
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id)
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS embedding_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id)
  )
  `,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,

  // v2 server fields
  `ALTER TABLE decisions ADD COLUMN access_count INTEGER DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN last_accessed TEXT`,
  `ALTER TABLE decisions ADD COLUMN archived_at TEXT`,
  `ALTER TABLE learnings ADD COLUMN access_count INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN last_accessed TEXT`,
  `ALTER TABLE learnings ADD COLUMN archived_at TEXT`,
  `ALTER TABLE errors ADD COLUMN access_count INTEGER DEFAULT 0`,
  `ALTER TABLE errors ADD COLUMN last_accessed TEXT`,
  `ALTER TABLE errors ADD COLUMN archived_at TEXT`,

  // Hook/runtime fields that server tools reference
  `ALTER TABLE sessions ADD COLUMN tags TEXT`,
  `ALTER TABLE sessions ADD COLUMN sentiment TEXT`,
  `ALTER TABLE sessions ADD COLUMN emotional_tone TEXT`,
  `ALTER TABLE sessions ADD COLUMN mood_score INTEGER`,
  `ALTER TABLE decisions ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN stale INTEGER DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN reviewed_at TEXT`,
  `ALTER TABLE decisions ADD COLUMN counter_arguments TEXT`,
  `ALTER TABLE decisions ADD COLUMN scope TEXT DEFAULT 'project'`,
  `ALTER TABLE errors ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE errors ADD COLUMN scope TEXT DEFAULT 'project'`,
  `ALTER TABLE learnings ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN core_memory INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN example_code TEXT`,
  `ALTER TABLE learnings ADD COLUMN theoretical_hits INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN practical_violations INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN superseded_by INTEGER REFERENCES learnings(id)`,
  `ALTER TABLE learnings ADD COLUMN superseded_at TEXT`,
  `ALTER TABLE learnings ADD COLUMN relevance TEXT DEFAULT 'maybe_relevant'`,
  `ALTER TABLE learnings ADD COLUMN write_gate_reason TEXT`,
  `ALTER TABLE learnings ADD COLUMN confidence REAL DEFAULT 0.7`,
  `ALTER TABLE learnings ADD COLUMN shared INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN scope TEXT DEFAULT 'project'`,
  `ALTER TABLE unfinished ADD COLUMN snooze_until TEXT`,
  `ALTER TABLE unfinished ADD COLUMN priority_score INTEGER DEFAULT 50`,
  `ALTER TABLE unfinished ADD COLUMN project TEXT`,
  `ALTER TABLE unfinished ADD COLUMN blocked_by TEXT`,
  `ALTER TABLE project_files ADD COLUMN cluster_id INTEGER`,
  `ALTER TABLE notes ADD COLUMN project TEXT`,
  `ALTER TABLE notes ADD COLUMN entity_type TEXT`,
  `ALTER TABLE notes ADD COLUMN entity_id INTEGER`,

  // Safety indexes
  `CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_chain_id ON sessions(chain_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category)`,
  `CREATE INDEX IF NOT EXISTS idx_errors_signature ON errors(error_signature)`,
  `CREATE INDEX IF NOT EXISTS idx_errors_severity ON errors(severity)`,
  `CREATE INDEX IF NOT EXISTS idx_learnings_auto_block ON learnings(auto_block)`,
  `CREATE INDEX IF NOT EXISTS idx_project_files_module ON project_files(module_id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(path)`,
  `CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_file)`,
  `CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_file)`,
  `CREATE INDEX IF NOT EXISTS idx_diffs_session ON diffs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_diffs_file ON diffs(file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_unfinished_resolved ON unfinished(resolved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_archived ON decisions(archived_at)`,
  `CREATE INDEX IF NOT EXISTS idx_learnings_archived ON learnings(archived_at)`,
  `CREATE INDEX IF NOT EXISTS idx_errors_archived ON errors(archived_at)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embedding_meta_entity ON embedding_meta(entity_type, entity_id)`,

  // Phase 4: Brain Foundation — neue Tabellen
  `CREATE TABLE IF NOT EXISTS working_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL,
    activation_level REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now')),
    last_accessed TEXT DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 1,
    metadata TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wm_session_activation ON working_memory(session_id, activation_level DESC)`,
  `CREATE TABLE IF NOT EXISTS auto_extractions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ae_session_status ON auto_extractions(session_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_confidence ON auto_extractions(confidence)`,

  // Phase 4: memory_strength + importance_score auf allen 5 Content-Tabellen
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

  // Phase 4: access_count + last_accessed nur auf notes + unfinished (decisions/errors/learnings haben es bereits)
  `ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0`,
  `ALTER TABLE notes ADD COLUMN last_accessed TEXT`,
  `ALTER TABLE unfinished ADD COLUMN access_count INTEGER DEFAULT 0`,
  `ALTER TABLE unfinished ADD COLUMN last_accessed TEXT`,

  // Phase 4: Neue Indizes fuer Decay + Importance-Queries
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

  // Phase 6: memory_associations Tabelle
  `CREATE TABLE IF NOT EXISTS memory_associations (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ma_source ON memory_associations(source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ma_target ON memory_associations(target_type, target_id)`,
];

function getDbPath(projectDir?: string): string {
  const dir = projectDir ?? process.cwd();
  const claudeDir = path.join(dir, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return path.join(claudeDir, 'cortex.db');
}

export function getDb(projectDir?: string): InstanceType<typeof DatabaseSync> {
  if (db) return db;

  const dbPath = getDbPath(projectDir);
  db = new DatabaseSync(dbPath, { allowExtension: true });

  // Performance pragmas
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  initVecExtension(db);
  initSchema(db);
  return db;
}

function initSchema(database: InstanceType<typeof DatabaseSync>): void {
  const hasAnyCoreTable = hasTable(database, 'sessions')
    || hasTable(database, 'decisions')
    || hasTable(database, 'errors')
    || hasTable(database, 'learnings')
    || hasTable(database, 'unfinished');

  if (!hasAnyCoreTable) {
    database.exec(SCHEMA_SQL);
    database.exec(FTS_TABLES);
    database.exec(FTS_TRIGGER_DROPS);
    database.exec(FTS_TRIGGERS);
    ensureVecSchema(database);
    ensureSchemaVersionRow(database);
    database.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    return;
  }

  for (const sql of COMPAT_MIGRATIONS) {
    try {
      database.exec(sql);
    } catch {
      // Intentionally ignored: migration is idempotent and may already be applied.
    }
  }

  try {
    database.exec(SCHEMA_SQL);
  } catch {
    // Existing DBs may still contain legacy shape; compat migrations above are authoritative.
  }

  // FTS Tables — idempotent (IF NOT EXISTS)
  try { database.exec(FTS_TABLES); } catch { /* bereits vorhanden */ }

  // FTS Triggers: DROP + CREATE — kaputte Trigger werden ersetzt
  database.exec(FTS_TRIGGER_DROPS);
  database.exec(FTS_TRIGGERS);
  ensureVecSchema(database);

  // Phase 4: Backfill — NULL-Werte auf Defaults setzen
  const backfillSql = [
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
  for (const sql of backfillSql) {
    try { database.exec(sql); } catch { /* Spalte noch nicht vorhanden auf sehr alten DBs */ }
  }

  ensureSchemaVersionRow(database);
  database.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
}

function initVecExtension(database: InstanceType<typeof DatabaseSync>): void {
  vecAvailable = false;
  vecExtensionPath = null;
  vecInitError = null;

  if (process.env.CORTEX_VEC_DISABLE === '1') {
    vecInitError = 'disabled by CORTEX_VEC_DISABLE=1';
    return;
  }

  if (tryLoadVecFromPackage(database)) {
    return;
  }

  const resolvedPath = resolveVecExtensionPath();
  if (!resolvedPath) {
    vecInitError = 'sqlite-vec not found (install npm package "sqlite-vec", or set CORTEX_VEC_DLL_PATH / server/native/vec0.dll)';
    return;
  }

  try {
    database.loadExtension(resolvedPath);
    vecAvailable = true;
    vecExtensionPath = resolvedPath;
  } catch (error) {
    vecInitError = error instanceof Error ? error.message : String(error);
  }
}

function tryLoadVecFromPackage(database: InstanceType<typeof DatabaseSync>): boolean {
  try {
    const sqliteVec = require('sqlite-vec') as {
      load?: (db: InstanceType<typeof DatabaseSync>) => void;
      default?: { load?: (db: InstanceType<typeof DatabaseSync>) => void };
    };
    const loadFn = sqliteVec?.load ?? sqliteVec?.default?.load;
    if (typeof loadFn !== 'function') {
      return false;
    }

    loadFn(database);
    vecAvailable = true;
    vecExtensionPath = 'npm:sqlite-vec';
    return true;
  } catch {
    return false;
  }
}

function resolveVecExtensionPath(): string | null {
  const envPath = process.env.CORTEX_VEC_DLL_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const nativeDirs = [
    path.resolve(moduleDir, '../native'),
    path.resolve(moduleDir, '../../native'),
  ];

  const candidateNames = process.platform === 'win32'
    ? ['vec0.dll']
    : process.platform === 'darwin'
      ? ['vec0.dylib', 'libvec0.dylib']
      : ['vec0.so', 'libvec0.so'];

  for (const dir of nativeDirs) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function ensureVecSchema(database: InstanceType<typeof DatabaseSync>): void {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_meta_entity
      ON embedding_meta(entity_type, entity_id);
    `);
  } catch {
    // Non-critical: legacy DB might still be migrating.
  }

  if (!vecAvailable) return;

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        embedding float[384]
      );
    `);
  } catch (error) {
    vecAvailable = false;
    vecInitError = error instanceof Error ? error.message : String(error);
    return;
  }

  try {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS embedding_meta_ad
      AFTER DELETE ON embedding_meta
      BEGIN
        DELETE FROM vec_embeddings WHERE rowid = old.id;
      END;
    `);
  } catch {
    // Optional cleanup trigger.
  }
}

function hasTable(database: InstanceType<typeof DatabaseSync>, name: string): boolean {
  const row = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name) as Record<string, unknown> | undefined;
  return Boolean(row);
}

function ensureSchemaVersionRow(database: InstanceType<typeof DatabaseSync>): void {
  const row = database.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  if (!row) {
    database.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  vecAvailable = false;
  vecExtensionPath = null;
  vecInitError = null;
}

export function isVecAvailable(): boolean {
  return vecAvailable;
}

export function getVecStatus(): { available: boolean; extensionPath: string | null; error: string | null } {
  return {
    available: vecAvailable,
    extensionPath: vecExtensionPath,
    error: vecInitError,
  };
}

export function now(): string {
  return new Date().toISOString();
}

export function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined || typeof value === 'number') return null;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function ageLabel(dateStr: string | null | undefined): string {
  if (!dateStr) return 'unknown';
  const d = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (d < 3) return 'fresh';
  if (d < 14) return 'recent';
  if (d < 90) return 'established';
  if (d < 365) return 'legacy';
  return 'ancient';
}
