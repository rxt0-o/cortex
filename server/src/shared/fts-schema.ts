/**
 * Single Source of Truth für FTS5 Virtual Tables und Trigger.
 * Wird importiert von:
 *   - server/src/db.ts (TS-Import)
 *   - scripts/ensure-db.js (via Build-Artefakt: server/dist/shared/fts-schema.js)
 */

export const FTS_TABLES = `
CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(anti_pattern, correct_pattern, context, content='learnings', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, reasoning, content='decisions', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(error_message, root_cause, fix_description, content='errors', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text, content='notes', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(summary, key_changes, content='sessions', content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS unfinished_fts USING fts5(description, context, content='unfinished', content_rowid='id');
`;

export const FTS_TRIGGER_DROPS = `
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

export const FTS_TRIGGERS = `
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
