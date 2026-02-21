#!/usr/bin/env node
// Auto-Regex Generator — Erzeugt detection_regex für Learnings ohne Regex
// Wird max 1x täglich ausgeführt (via meta-Tabelle getrackt)

import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

export async function runAutoRegex(cwd) {
  const dbPath = join(cwd, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);
  try {
    // Max 1x täglich: letzten Lauf prüfen
    let lastRun = null;
    try {
      lastRun = db.prepare(
        "SELECT value FROM meta WHERE key = 'auto_regex_last_run'"
      ).get()?.value;
    } catch { /* meta table may not exist yet */ }

    if (lastRun) {
      const hoursSince = (Date.now() - new Date(lastRun).getTime()) / 3600000;
      if (hoursSince < 22) return;
    }

    // Learnings ohne Regex holen
    const learnings = db.prepare(`
      SELECT id, anti_pattern, correct_pattern, context, severity
      FROM learnings
      WHERE detection_regex IS NULL AND auto_block = 1
      LIMIT 5
    `).all();

    if (learnings.length === 0) return;

    for (const learning of learnings) {
      try {
        const prompt = `Generate a JavaScript/Node.js regex pattern (for RegExp constructor) that detects this anti-pattern in source code:

Anti-pattern: ${learning.anti_pattern}
Correct alternative: ${learning.correct_pattern}
Context: ${learning.context}

Rules:
- The regex should match the BAD pattern (what to BLOCK), not the good one
- Keep it simple and precise — avoid false positives
- Works in multiline mode (gm flags)
- Return ONLY the regex pattern string, no flags, no slashes, no explanation
- Example output: auth\.uid\(\)(?!\s*\))
- If you cannot create a reliable regex, return: SKIP`;

        const result = await execFileAsync('claude', [
          '--model', 'claude-haiku-4-5-20251001',
          '--max-tokens', '80',
          '-p', prompt,
        ], { timeout: 15000, encoding: 'utf-8' });

        const regex = result.stdout.trim();
        if (!regex || regex === 'SKIP' || regex.length > 200) continue;

        // Regex validieren bevor speichern
        try {
          new RegExp(regex, 'gm');
        } catch {
          continue; // Ungültige Regex — überspringen
        }

        db.prepare('UPDATE learnings SET detection_regex = ? WHERE id = ?')
          .run(regex, learning.id);

      } catch { /* Einzelnes Learning kann fehlschlagen */ }
    }

    // Lauf-Zeitstempel aktualisieren
    try {
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('auto_regex_last_run', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new Date().toISOString());
    } catch { /* non-critical */ }

  } finally {
    db.close();
  }
}
