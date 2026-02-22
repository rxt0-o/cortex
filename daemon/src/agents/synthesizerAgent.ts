import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

export async function runSynthesizerAgent(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Only run every 10 completed sessions
    const total = (db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE status='completed'`).get() as any)?.c ?? 0;
    if (total === 0 || total % 10 !== 0) return;

    // Check if we already synthesized at this count
    let lastCount = 0;
    try {
      const meta = db.prepare(`SELECT value FROM meta WHERE key='synthesizer_last_count'`).get() as any;
      lastCount = parseInt(meta?.value ?? '0', 10);
    } catch {}
    if (lastCount === total) return;

    // Gather last 50 session summaries + learnings
    const sessions = db.prepare(`
      SELECT summary, started_at FROM sessions
      WHERE status='completed' AND summary IS NOT NULL
      ORDER BY started_at DESC LIMIT 50
    `).all() as any[];

    const learnings = db.prepare(`
      SELECT anti_pattern, correct_pattern FROM learnings
      WHERE archived != 1 ORDER BY occurrences DESC LIMIT 20
    `).all() as any[];

    if (sessions.length === 0) return;

    const sessionStr = sessions.map(s => `[${s.started_at?.slice(0,10)}] ${s.summary}`).join('\n');
    const learningStr = learnings.map(l => `- ${l.anti_pattern} → ${l.correct_pattern}`).join('\n');

    const prompt = `You are a development memory synthesizer. Based on these recent sessions and learnings, write a 2-3 sentence synthesis paragraph that captures the key patterns, progress, and recurring themes. Be concrete and specific.

RECENT SESSIONS (last 50):
${sessionStr}

KEY LEARNINGS:
${learningStr || '(none)'}

Respond with ONLY the synthesis paragraph (no headers, no preamble).`;

    const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 60000, agentName: 'synthesizer' });

    if (result.success && result.output?.trim()) {
      const synthesis = result.output.trim();
      const ts = new Date().toISOString();
      // Save as note with synthesis tag
      try {
        db.prepare(`INSERT INTO notes (text, tags, created_at) VALUES (?, ?, ?)`).run(
          `[SYNTHESIS] ${synthesis}`,
          JSON.stringify(['synthesis', 'auto']),
          ts
        );
        // Update meta
        db.prepare(`INSERT INTO meta (key,value) VALUES ('synthesizer_last_count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(total));
        process.stdout.write(`[cortex-daemon] Synthesizer: synthesis saved after ${total} sessions\n`);
      } catch (e) {
        process.stderr.write(`[cortex-daemon] Synthesizer: failed to save note: ${e}\n`);
      }
    }
  } finally {
    db.close();
  }
}
