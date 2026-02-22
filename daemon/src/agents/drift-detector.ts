import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

export async function runDriftDetectorAgent(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Check last run — max once per 22 hours
    let lastRun: string | null = null;
    try {
      const meta = db.prepare(`SELECT value FROM meta WHERE key='drift_detector_last_run'`).get() as any;
      lastRun = meta?.value ?? null;
    } catch {}

    if (lastRun) {
      const hoursSince = (Date.now() - new Date(lastRun).getTime()) / 3600000;
      if (hoursSince < 22) {
        process.stdout.write('[cortex-daemon] DriftDetector: skipping, last run < 22h ago\n');
        return;
      }
    }

    // Load recent decisions (architecture + convention)
    const decisions = db.prepare(`
      SELECT title, reasoning, category, created_at FROM decisions
      WHERE category IN ('architecture', 'convention') AND archived != 1
      ORDER BY created_at DESC LIMIT 15
    `).all() as any[];

    // Load diffs from last 2 hours
    const recentDiffs = db.prepare(`
      SELECT DISTINCT file_path FROM diffs
      WHERE created_at > datetime('now', '-2 hours')
      LIMIT 20
    `).all() as any[];

    if (decisions.length === 0 && recentDiffs.length === 0) {
      process.stdout.write('[cortex-daemon] DriftDetector: no data to analyze\n');
      return;
    }

    const decisionsStr = decisions.map(d => `[${d.category}] ${d.title}: ${d.reasoning?.slice(0, 100) ?? ''}`).join('\n');
    const filesStr = recentDiffs.map(d => d.file_path).join('\n');

    const prompt = `You are a code drift detector. Analyze if recent file changes might conflict with architectural decisions.

ARCHITECTURAL DECISIONS:
${decisionsStr || '(none)'}

RECENTLY MODIFIED FILES:
${filesStr || '(none)'}

If you detect potential drift (files modified in ways that might violate architectural decisions), respond with one line per issue starting with "DRIFT:".
Example: DRIFT: auth.ts modified but decision says JWT-only auth — verify alignment.

If no drift detected, respond with: NO_DRIFT

Be concise. Max 5 DRIFT lines.`;

    const result = await runClaudeAgent({
      prompt,
      projectPath,
      timeoutMs: 60000,
      agentName: 'drift-detector',
    });

    if (result.success && result.output) {
      const lines = result.output.split('\n').filter(l => l.startsWith('DRIFT:'));
      if (lines.length > 0) {
        const ts = new Date().toISOString();
        // Ensure session exists
        const sessionId = `drift-${ts.slice(0, 10)}`;
        db.prepare(`INSERT OR IGNORE INTO sessions (id, started_at, status) VALUES (?, ?, 'completed')`).run(sessionId, ts);

        const stmt = db.prepare(`INSERT INTO unfinished (session_id, created_at, description, context, priority) VALUES (?, ?, ?, ?, 'medium')`);
        for (const line of lines) {
          const description = line.replace(/^DRIFT:\s*/, '').trim();
          if (description) {
            stmt.run(sessionId, ts, `[DRIFT] ${description}`, 'Auto-detected by drift detector daemon');
          }
        }
        process.stdout.write(`[cortex-daemon] DriftDetector: saved ${lines.length} drift item(s)\n`);
      } else {
        process.stdout.write('[cortex-daemon] DriftDetector: no drift detected\n');
      }
    }

    // Update last run
    try {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('drift_detector_last_run', datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    } catch {}

  } finally {
    db.close();
  }
}
