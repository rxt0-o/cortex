import { getDb, now } from '../db.js';
export function addConvention(input) {
    const db = getDb();
    db.prepare(`
    INSERT INTO conventions (name, description, detection_pattern, violation_pattern, examples_good, examples_bad, scope, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      detection_pattern = COALESCE(excluded.detection_pattern, conventions.detection_pattern),
      violation_pattern = COALESCE(excluded.violation_pattern, conventions.violation_pattern),
      examples_good = COALESCE(excluded.examples_good, conventions.examples_good),
      examples_bad = COALESCE(excluded.examples_bad, conventions.examples_bad),
      scope = COALESCE(excluded.scope, conventions.scope),
      source = COALESCE(excluded.source, conventions.source)
  `).run(input.name, input.description, input.detection_pattern ?? null, input.violation_pattern ?? null, input.examples_good ? JSON.stringify(input.examples_good) : null, input.examples_bad ? JSON.stringify(input.examples_bad) : null, input.scope ?? null, input.source ?? null);
    return getConventionByName(input.name);
}
export function getConventionByName(name) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM conventions WHERE name = ?').get(name);
    if (!row)
        return null;
    return parseConventionRow(row);
}
export function listConventions(scope) {
    const db = getDb();
    let sql = 'SELECT * FROM conventions';
    const params = [];
    if (scope) {
        sql += ' WHERE scope = ?';
        params.push(scope);
    }
    sql += ' ORDER BY violation_count DESC, name';
    const rows = db.prepare(sql).all(...params);
    return rows.map(parseConventionRow);
}
export function recordViolation(conventionId) {
    const db = getDb();
    db.prepare('UPDATE conventions SET violation_count = violation_count + 1, last_violated = ? WHERE id = ?')
        .run(now(), conventionId);
}
export function checkContentAgainstConventions(content) {
    const conventions = listConventions();
    const results = [];
    for (const conv of conventions) {
        if (!conv.violation_pattern)
            continue;
        try {
            const regex = new RegExp(conv.violation_pattern, 'gm');
            if (regex.test(content)) {
                results.push({ convention: conv, match: conv.violation_pattern, type: 'violation' });
                recordViolation(conv.id);
            }
        }
        catch {
            // Invalid regex, skip
        }
    }
    return results;
}
function parseConventionRow(row) {
    return {
        ...row,
        examples_good: row.examples_good ? JSON.parse(row.examples_good) : null,
        examples_bad: row.examples_bad ? JSON.parse(row.examples_bad) : null,
    };
}
//# sourceMappingURL=conventions.js.map