import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent, buildAgentContext, formatAgentContext } from '../runner.js';

interface WorkPattern {
  id?: number;
  pattern_type: string;
  pattern_data: string;
  confidence: number;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  decay_rate: number;
}

interface SessionDiffs {
  session_id: string;
  started_at: string;
  summary: string | null;
  files: string[];
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) { if (b.has(item)) intersection++; }
  return intersection / (a.size + b.size - intersection);
}

function applyDecay(db: DatabaseSync): void {
  db.prepare(`
    UPDATE work_patterns
    SET confidence = confidence * POWER(decay_rate, MAX(1, julianday('now') - julianday(last_seen)))
    WHERE confidence > 0.01
  `).run();
  db.prepare(`DELETE FROM work_patterns WHERE confidence < 0.05`).run();
}

function updateFileCluster(db: DatabaseSync, recentSessions: SessionDiffs[]): void {
  if (recentSessions.length < 2) return;
  const ts = new Date().toISOString();

  for (let i = 0; i < recentSessions.length; i++) {
    for (let j = i + 1; j < recentSessions.length; j++) {
      const setA = new Set(recentSessions[i].files);
      const setB = new Set(recentSessions[j].files);
      const similarity = jaccardSimilarity(setA, setB);

      if (similarity < 0.3) continue;

      const clusterFiles = [...new Set([...setA, ...setB])].sort();

      const existing = db.prepare(`
        SELECT id, confidence, occurrences, pattern_data FROM work_patterns
        WHERE pattern_type = 'file_cluster'
      `).all() as Array<{ id: number; confidence: number; occurrences: number; pattern_data: string }>;

      let matched = false;
      for (const p of existing) {
        try {
          const data = JSON.parse(p.pattern_data);
          const existingFiles = new Set(data.files as string[]);
          if (jaccardSimilarity(new Set(clusterFiles), existingFiles) > 0.6) {
            const mergedFiles = [...new Set([...existingFiles, ...clusterFiles])].sort();
            db.prepare(`
              UPDATE work_patterns
              SET confidence = MIN(1.0, confidence + 0.1),
                  occurrences = occurrences + 1,
                  last_seen = ?,
                  pattern_data = ?
              WHERE id = ?
            `).run(ts, JSON.stringify({ files: mergedFiles, similarity }), p.id);
            matched = true;
            break;
          }
        } catch { continue; }
      }

      if (!matched && clusterFiles.length >= 2 && clusterFiles.length <= 15) {
        db.prepare(`
          INSERT INTO work_patterns (pattern_type, pattern_data, confidence, first_seen, last_seen)
          VALUES ('file_cluster', ?, ?, ?, ?)
        `).run(JSON.stringify({ files: clusterFiles, similarity }), similarity, ts, ts);
      }
    }
  }
}

export async function runPatternAgent(projectPath: string, sessionId?: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    const sessions = db.prepare(`
      SELECT s.id, s.started_at, s.summary,
        GROUP_CONCAT(DISTINCT d.file_path) as files
      FROM sessions s
      LEFT JOIN diffs d ON d.session_id = s.id
      WHERE s.status != 'active' AND s.summary IS NOT NULL
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 5
    `).all() as Array<{ id: string; started_at: string; summary: string | null; files: string | null }>;

    const recentSessions: SessionDiffs[] = sessions.map(s => ({
      session_id: s.id,
      started_at: s.started_at,
      summary: s.summary,
      files: s.files ? s.files.split(',').filter(Boolean) : [],
    }));

    if (recentSessions.length < 2) {
      process.stdout.write('[cortex-daemon] PatternAgent: not enough sessions yet, skipping\n');
      return;
    }

    applyDecay(db);
    updateFileCluster(db, recentSessions);
    await predictIntent(db, projectPath, recentSessions);

    const patternCount = (db.prepare('SELECT COUNT(*) as c FROM work_patterns').get() as any)?.c ?? 0;
    process.stdout.write(`[cortex-daemon] PatternAgent: ${patternCount} patterns in DB\n`);

  } finally {
    db.close();
  }
}

async function predictIntent(
  db: DatabaseSync,
  projectPath: string,
  recentSessions: SessionDiffs[]
): Promise<void> {
  let branch = 'unknown';
  try {
    const { execFileSync } = await import('child_process');
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath, encoding: 'utf-8'
    }).trim();
  } catch { /* not git */ }

  const unfinished = db.prepare(`
    SELECT description, priority FROM unfinished
    WHERE resolved_at IS NULL
    ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 5
  `).all() as Array<{ description: string; priority: string }>;

  const topPatterns = db.prepare(`
    SELECT pattern_type, pattern_data, confidence FROM work_patterns
    WHERE confidence > 0.2
    ORDER BY confidence DESC
    LIMIT 5
  `).all() as Array<{ pattern_type: string; pattern_data: string; confidence: number }>;

  const decisions = db.prepare(`
    SELECT id, title, reasoning FROM decisions
    WHERE archived != 1
    ORDER BY created_at DESC
    LIMIT 5
  `).all() as Array<{ id: number; title: string; reasoning: string }>;

  const errors = db.prepare(`
    SELECT id, error_message, fix_description FROM errors
    WHERE archived != 1
    ORDER BY last_seen DESC
    LIMIT 3
  `).all() as Array<{ id: number; error_message: string; fix_description: string | null }>;

  const lastSession = recentSessions[0];
  const daysSinceLastSession = lastSession
    ? (Date.now() - new Date(lastSession.started_at).getTime()) / 86400000
    : 999;
  const useSonnet = daysSinceLastSession > 3;
  const model = useSonnet ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';

  const INTENT_SCHEMA = {
    type: 'object',
    properties: {
      predicted_task: { type: 'string' },
      confidence: { type: 'number' },
      reasoning: { type: 'string' },
      relevant_decision_ids: { type: 'array', items: { type: 'number' } },
      relevant_error_ids: { type: 'array', items: { type: 'number' } },
      relevant_files: { type: 'array', items: { type: 'string' } },
      suggested_next_step: { type: 'string' },
    },
    required: ['predicted_task', 'confidence', 'reasoning', 'relevant_files', 'suggested_next_step'],
  };

  const prompt = `<role>
Du bist ein Arbeits-Muster-Analyst. Sage voraus, was der Entwickler in der NAECHSTEN Session wahrscheinlich tun wird.
</role>

<signals>
<branch>${branch}</branch>
<hour>${new Date().getHours()}</hour>
<days_since_last_session>${daysSinceLastSession.toFixed(1)}</days_since_last_session>

<recent_sessions>
${recentSessions.map(s => `[${s.started_at.slice(0, 16)}] ${s.summary ?? '(keine Summary)'}\n  Files: ${s.files.slice(0, 8).join(', ')}`).join('\n')}
</recent_sessions>

<unfinished_items>
${unfinished.map(u => `[${u.priority}] ${u.description}`).join('\n') || '(keine)'}
</unfinished_items>

<work_patterns>
${topPatterns.map(p => `[${p.pattern_type}] confidence=${p.confidence.toFixed(2)}: ${p.pattern_data.slice(0, 200)}`).join('\n') || '(noch keine Patterns)'}
</work_patterns>

<recent_decisions>
${decisions.map(d => `[#${d.id}] ${d.title}`).join('\n') || '(keine)'}
</recent_decisions>

<recent_errors>
${errors.map(e => `[#${e.id}] ${e.error_message}${e.fix_description ? ' (fixed: ' + e.fix_description + ')' : ''}`).join('\n') || '(keine)'}
</recent_errors>
</signals>

<instructions>
Analysiere die Signale und sage voraus:
1. Was wird der Entwickler wahrscheinlich als naechstes tun?
2. Welche Dateien sind relevant?
3. Was waere ein guter erster Schritt?

Beruecksichtige:
- Unfinished-Items mit hoher Prioritaet
- Muster in den letzten Sessions (Fortfuehrung vs. neues Thema)
- Branch-Name als Hinweis auf aktuelle Arbeit
- Tageszeit (morgens: frische Features, abends: Reviews/Fixes)

Sei spezifisch. Keine generischen Antworten wie "Code schreiben".
Antworte NUR mit dem JSON.
</instructions>`;

  const result = await runClaudeAgent({
    prompt,
    projectPath,
    timeoutMs: 60_000,
    jsonSchema: INTENT_SCHEMA,
    model,
    agentName: 'patternAgent',
  });

  if (!result.success || !result.output) {
    process.stderr.write(`[cortex-daemon] PatternAgent: intent prediction failed: ${result.error ?? 'no output'}\n`);
    return;
  }

  try {
    const parsed = JSON.parse(result.output);
    const prediction = parsed?.structured_output ?? parsed;
    if (!prediction?.predicted_task) return;

    prediction.model_used = model;
    prediction.predicted_at = new Date().toISOString();

    db.prepare(`
      INSERT INTO meta (key, value) VALUES ('last_intent_prediction', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(prediction));

    process.stdout.write(`[cortex-daemon] PatternAgent: intent prediction saved (${prediction.confidence?.toFixed(2) ?? '?'} confidence, ${model})\n`);
  } catch (e) {
    try {
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const prediction = JSON.parse(jsonMatch[0]);
        prediction.model_used = model;
        prediction.predicted_at = new Date().toISOString();
        db.prepare(`
          INSERT INTO meta (key, value) VALUES ('last_intent_prediction', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(JSON.stringify(prediction));
      }
    } catch { /* aufgeben */ }
  }
}
