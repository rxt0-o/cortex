import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { runClaudeAgent } from '../runner.js';
export async function runMoodScorerAgent(projectPath, sessionId, transcriptPath) {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath))
        return;
    const db = new DatabaseSync(dbPath);
    try {
        // Get session summary
        const session = db.prepare(`SELECT summary FROM sessions WHERE id=?`).get(sessionId);
        if (!session?.summary)
            return;
        // Optional: transcript sample
        let transcriptSample = '';
        if (transcriptPath && existsSync(transcriptPath)) {
            try {
                const content = readFileSync(transcriptPath, 'utf-8');
                transcriptSample = content.slice(-3000);
            }
            catch { }
        }
        const prompt = `Classify the emotional tone of this coding session. Respond with exactly two lines:
TONE: <one of: frustrated, focused, exploratory, stuck, productive, confused>
SCORE: <integer 1-5 where 1=very negative/stuck, 3=neutral, 5=very positive/productive>

SESSION SUMMARY: ${session.summary}
${transcriptSample ? `\nSESSION EXCERPT:\n${transcriptSample.slice(0, 1000)}` : ''}

Reply with ONLY the two lines above, nothing else.`;
        const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 30000, agentName: 'mood-scorer' });
        if (result.success && result.output) {
            const toneMatch = result.output.match(/TONE:\s*(\w+)/i);
            const scoreMatch = result.output.match(/SCORE:\s*(\d)/i);
            const tone = toneMatch?.[1]?.toLowerCase() ?? null;
            const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
            if (tone || score) {
                db.prepare(`UPDATE sessions SET emotional_tone=?, mood_score=? WHERE id=?`).run(tone, score, sessionId);
                process.stdout.write(`[cortex-daemon] MoodScorer: session ${sessionId} → tone=${tone}, score=${score}\n`);
            }
        }
    }
    finally {
        db.close();
    }
}
