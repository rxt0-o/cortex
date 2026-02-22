import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

export async function runCleanupAgent(projectPath: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Only run every 5 completed sessions
    const total = (db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE status='completed'`).get() as any)?.c ?? 0;
    if (total === 0 || total % 5 !== 0) return;

    // Check if we already cleaned up at this count
    let lastCount = 0;
    try {
      const meta = db.prepare(`SELECT value FROM meta WHERE key='cleanup_last_count'`).get() as any;
      lastCount = parseInt(meta?.value ?? '0', 10);
    } catch {}
    if (lastCount === total) return;

    // Gather active learnings
    const learnings = db.prepare(`
      SELECT id, anti_pattern, correct_pattern, context, severity, occurrences
      FROM learnings
      WHERE archived_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC
    `).all() as any[];

    // Find stale decision candidates (>30 days, never reviewed, not already stale)
    const staleDecisions = db.prepare(`
      SELECT id, title, reasoning, category
      FROM decisions
      WHERE stale != 1
        AND reviewed_at IS NULL
        AND created_at < datetime('now', '-30 days')
        AND archived_at IS NULL
      ORDER BY created_at ASC
    `).all() as any[];

    if (learnings.length < 2 && staleDecisions.length === 0) return;

    const learningStr = learnings.map(l =>
      `[ID:${l.id}] (${l.severity || 'medium'}, occ:${l.occurrences || 0}) ${l.anti_pattern} → ${l.correct_pattern}${l.context ? ' | ctx: ' + l.context : ''}`
    ).join('\n');

    const decisionStr = staleDecisions.map(d =>
      `[ID:${d.id}] (${d.category}) ${d.title}: ${d.reasoning}`
    ).join('\n');

    const prompt = `You are a memory cleanup agent. Analyze these learnings and decisions for a software project.

TASK 1 — DUPLICATE LEARNINGS:
Find learnings that are duplicates or near-duplicates (same concept, different wording). For each pair, pick the one with higher occurrences or better wording as the "keep" ID, and the other as "remove" ID.

ACTIVE LEARNINGS (${learnings.length}):
${learningStr || '(none)'}

TASK 2 — STALE DECISIONS:
These decisions are >30 days old and were never reviewed. Mark any that are likely outdated or no longer relevant. Be conservative — only mark truly stale ones.

CANDIDATE STALE DECISIONS (${staleDecisions.length}):
${decisionStr || '(none)'}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "duplicate_pairs": [{"keep_id": 1, "remove_id": 2}],
  "stale_decision_ids": [3, 4]
}

If no duplicates or stale decisions found, return empty arrays.`;

    const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 60000, agentName: 'cleanup' });

    if (!result.success || !result.output?.trim()) return;

    // Extract JSON from response
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    let parsed: { duplicate_pairs?: { keep_id: number; remove_id: number }[]; stale_decision_ids?: number[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      process.stderr.write(`[cortex-daemon] Cleanup: failed to parse JSON response\n`);
      return;
    }

    let dupCount = 0;
    let staleCount = 0;

    // Process duplicate learnings
    if (Array.isArray(parsed.duplicate_pairs)) {
      for (const pair of parsed.duplicate_pairs) {
        if (typeof pair.keep_id !== 'number' || typeof pair.remove_id !== 'number') continue;
        if (pair.keep_id === pair.remove_id) continue;
        try {
          db.prepare(`UPDATE learnings SET superseded_by=?, superseded_at=datetime('now') WHERE id=? AND superseded_by IS NULL`).run(
            pair.keep_id, pair.remove_id
          );
          dupCount++;
        } catch (e) {
          process.stderr.write(`[cortex-daemon] Cleanup: failed to supersede learning ${pair.remove_id}: ${e}\n`);
        }
      }
    }

    // Process stale decisions
    if (Array.isArray(parsed.stale_decision_ids)) {
      for (const id of parsed.stale_decision_ids) {
        if (typeof id !== 'number') continue;
        try {
          db.prepare(`UPDATE decisions SET stale=1 WHERE id=? AND stale != 1`).run(id);
          staleCount++;
        } catch (e) {
          process.stderr.write(`[cortex-daemon] Cleanup: failed to mark decision ${id} stale: ${e}\n`);
        }
      }
    }

    // Update meta
    db.prepare(`INSERT INTO meta (key,value) VALUES ('cleanup_last_count',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(total));
    process.stdout.write(`[cortex-daemon] Cleanup: ${dupCount} duplicates superseded, ${staleCount} decisions marked stale (at session count ${total})\n`);

  } finally {
    db.close();
  }
}
