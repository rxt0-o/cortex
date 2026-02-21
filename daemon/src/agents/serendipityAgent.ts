import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync, appendFileSync } from 'fs';

export async function runSerendipityAgent(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Pick 1-3 random old learnings (>30 days)
    const oldItems = db.prepare(`
      SELECT anti_pattern, correct_pattern, created_at FROM learnings
      WHERE created_at < datetime('now', '-30 days')
        AND archived != 1
      ORDER BY RANDOM() LIMIT 3
    `).all() as any[];

    if (oldItems.length === 0) return;

    // Also try old notes
    let oldNotes: any[] = [];
    try {
      oldNotes = db.prepare(`
        SELECT text, created_at FROM notes
        WHERE created_at < datetime('now', '-30 days')
        ORDER BY RANDOM() LIMIT 2
      `).all() as any[];
    } catch {}

    const flashes: string[] = [];
    for (const item of oldItems) {
      flashes.push(`Memory from ${item.created_at?.slice(0,10)}: ${item.anti_pattern} → ${item.correct_pattern}`);
    }
    for (const note of oldNotes) {
      if (!note.text.startsWith('[SYNTHESIS]')) {
        flashes.push(`Old note (${note.created_at?.slice(0,10)}): ${note.text.slice(0, 120)}`);
      }
    }

    if (flashes.length === 0) return;

    // Write to cortex-feedback.jsonl so session-start picks it up
    const feedbackPath = join(projectPath, '.claude', 'cortex-feedback.jsonl');
    const entry = {
      file: '__serendipity__',
      message: `MEMORY FLASH:\n${flashes.map(f => '  ' + f).join('\n')}`,
      ts: new Date().toISOString(),
    };
    appendFileSync(feedbackPath, JSON.stringify(entry) + '\n', 'utf-8');
    process.stdout.write(`[cortex-daemon] Serendipity: ${flashes.length} memory flash(es) queued\n`);
  } finally {
    db.close();
  }
}
