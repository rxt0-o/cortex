import { z } from 'zod';
import { getDb } from '../db.js';
import { parseDiff } from '../analyzer/diff-extractor.js';
import { summarizeFunctionChanges } from '../analyzer/chunk-analyzer.js';
export function registerIntelligenceTools(server) {
    server.tool('cortex_blame', 'Show full history for a file: diffs, errors, decisions', { file_path: z.string() }, async ({ file_path }) => {
        const db = getDb();
        const lines = [`=== History for ${file_path} ===`];
        try {
            const fileDiffs = db.prepare(`SELECT d.created_at, d.change_type, s.summary FROM diffs d LEFT JOIN sessions s ON s.id=d.session_id WHERE d.file_path LIKE ? ORDER BY d.created_at DESC LIMIT 10`).all(`%${file_path}%`);
            if (fileDiffs.length > 0) {
                lines.push('DIFFS:');
                for (const d of fileDiffs)
                    lines.push(`  [${d.created_at?.slice(0, 10)}] ${d.change_type ?? 'modified'} — ${d.summary ?? ''}`);
            }
        }
        catch { }
        try {
            const fileErrors = db.prepare(`SELECT error_message, fix_description, severity FROM errors WHERE files_involved LIKE ? ORDER BY last_seen DESC LIMIT 5`).all(`%${file_path}%`);
            if (fileErrors.length > 0) {
                lines.push('ERRORS:');
                for (const e of fileErrors)
                    lines.push(`  [${e.severity}] ${e.error_message}${e.fix_description ? ' → ' + e.fix_description : ''}`);
            }
        }
        catch { }
        try {
            const fileDecisions = db.prepare(`SELECT title, category, created_at FROM decisions WHERE files_affected LIKE ? ORDER BY created_at DESC LIMIT 5`).all(`%${file_path}%`);
            if (fileDecisions.length > 0) {
                lines.push('DECISIONS:');
                for (const d of fileDecisions)
                    lines.push(`  [${d.category}] ${d.title}`);
            }
        }
        catch { }
        // Function-Level Breakdown via chunk-analyzer
        try {
            const rawDiffs = db.prepare('SELECT diff_content FROM diffs WHERE file_path LIKE ? ORDER BY created_at DESC LIMIT 5').all('%' + file_path + '%');
            const fnChanges = [];
            for (const d of rawDiffs) {
                if (!d.diff_content)
                    continue;
                for (const fileDiff of parseDiff(d.diff_content)) {
                    const s = summarizeFunctionChanges(fileDiff);
                    if (!s.includes('no changes'))
                        fnChanges.push('  ' + s);
                }
            }
            if (fnChanges.length > 0) {
                lines.push('FUNCTION CHANGES:');
                lines.push(...fnChanges);
            }
        }
        catch { }
        return { content: [{ type: 'text', text: lines.join('\n') || 'No history found.' }] };
    });
    server.tool('cortex_snapshot', 'Get a concise brain snapshot — top state, intents, mood, drift, anchors', {}, async () => {
        const db = getDb();
        const md = [`# Brain Snapshot — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, ''];
        // Mood
        try {
            const moodSessions = db.prepare(`SELECT mood_score FROM sessions WHERE mood_score IS NOT NULL ORDER BY started_at DESC LIMIT 7`).all();
            if (moodSessions.length > 0) {
                const avg = moodSessions.reduce((s, r) => s + r.mood_score, 0) / moodSessions.length;
                md.push(`**Mood:** ${avg >= 4 ? 'positive' : avg >= 3 ? 'neutral' : 'negative'} (${avg.toFixed(1)}/5)`);
            }
        }
        catch { }
        // Open items
        try {
            const open = db.prepare(`SELECT description, priority FROM unfinished WHERE resolved_at IS NULL ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 5`).all();
            if (open.length > 0) {
                md.push('');
                md.push(`## Open Items (${open.length})`);
                for (const u of open)
                    md.push(`- [${u.priority}] ${u.description}`);
            }
        }
        catch { }
        // Active intents
        try {
            const intents = db.prepare(`SELECT description FROM unfinished WHERE context='intent' AND resolved_at IS NULL LIMIT 3`).all();
            if (intents.length > 0) {
                md.push('');
                md.push('## Intents');
                for (const i of intents)
                    md.push(`- ${i.description.replace('[INTENT] ', '')}`);
            }
        }
        catch { }
        // Attention anchors
        try {
            const anchors = db.prepare(`SELECT topic, priority FROM attention_anchors ORDER BY priority DESC LIMIT 5`).all();
            if (anchors.length > 0) {
                md.push('');
                md.push('## Attention Anchors');
                for (const a of anchors)
                    md.push(`- ${a.topic} (p${a.priority})`);
            }
        }
        catch { }
        // Drift items
        try {
            const drift = db.prepare(`SELECT description FROM unfinished WHERE description LIKE '[DRIFT]%' AND resolved_at IS NULL LIMIT 3`).all();
            if (drift.length > 0) {
                md.push('');
                md.push('## Drift Warnings');
                for (const d of drift)
                    md.push(`- ${d.description}`);
            }
        }
        catch { }
        // Stale decisions
        try {
            const stale = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE stale=1`).get();
            if (stale?.c > 0) {
                md.push('');
                md.push(`## Stale Decisions: ${stale.c} (>90 days old — review needed)`);
            }
        }
        catch { }
        // Recency-Gradient: letzte 3 Sessions vollstaendig, aeltere komprimiert
        try {
            const recent = db.prepare(`
          SELECT id, started_at, summary, key_changes FROM sessions
          WHERE status='completed' AND summary IS NOT NULL
          ORDER BY started_at DESC LIMIT 10
        `).all();
            if (recent.length > 0) {
                md.push('');
                md.push('## Recent Sessions');
                for (let i = 0; i < recent.length; i++) {
                    const s = recent[i];
                    const date = s.started_at?.slice(0, 10) ?? '?';
                    if (i < 3) {
                        md.push(`- [${date}] ${s.summary}`);
                        if (s.key_changes) {
                            try {
                                const changes = JSON.parse(s.key_changes);
                                for (const c of changes.slice(0, 3)) {
                                    md.push(`  - ${c.action}: ${c.file} -- ${c.description}`);
                                }
                            }
                            catch { }
                        }
                    }
                    else {
                        const summary = s.summary ?? '';
                        md.push(`- [${date}] ${summary.slice(0, 80)}${summary.length > 80 ? '...' : ''}`);
                    }
                }
            }
        }
        catch { }
        // Recency-Gradient: Decisions letzte 7 Tage vollstaendig, aeltere nur Anzahl
        try {
            const recentDecisions = db.prepare(`
          SELECT id, title, category, reasoning FROM decisions
          WHERE archived_at IS NULL AND superseded_by IS NULL
            AND created_at > datetime('now', '-7 days')
          ORDER BY created_at DESC LIMIT 5
        `).all();
            const olderDecisionsCount = db.prepare(`
          SELECT COUNT(*) as c FROM decisions
          WHERE archived_at IS NULL AND superseded_by IS NULL
            AND created_at <= datetime('now', '-7 days')
        `).get()?.c ?? 0;
            if (recentDecisions.length > 0 || olderDecisionsCount > 0) {
                md.push('');
                md.push('## Decisions');
                for (const d of recentDecisions) {
                    const r = d.reasoning ?? '';
                    md.push(`- [${d.category}] **${d.title}** -- ${r.slice(0, 100)}${r.length > 100 ? '...' : ''}`);
                }
                if (olderDecisionsCount > 0) {
                    md.push(`- _(+ ${olderDecisionsCount} older -- use cortex_list_decisions to view)_`);
                }
            }
        }
        catch { }
        // Recency-Gradient: Learnings letzte 7 Tage + auto_block immer
        try {
            const autoBlocks = db.prepare(`
          SELECT anti_pattern, correct_pattern FROM learnings
          WHERE auto_block = 1 AND archived_at IS NULL
        `).all();
            const recentLearnings = db.prepare(`
          SELECT anti_pattern, correct_pattern, severity FROM learnings
          WHERE auto_block = 0 AND archived_at IS NULL
            AND created_at > datetime('now', '-7 days')
          ORDER BY created_at DESC LIMIT 5
        `).all();
            const olderLearningsCount = db.prepare(`
          SELECT COUNT(*) as c FROM learnings
          WHERE auto_block = 0 AND archived_at IS NULL
            AND created_at <= datetime('now', '-7 days')
        `).get()?.c ?? 0;
            if (autoBlocks.length > 0 || recentLearnings.length > 0 || olderLearningsCount > 0) {
                md.push('');
                md.push('## Learnings');
                if (autoBlocks.length > 0) {
                    md.push('**Auto-Block Rules:**');
                    for (const l of autoBlocks) {
                        md.push(`- NEVER: ${l.anti_pattern} -- DO: ${l.correct_pattern}`);
                    }
                }
                for (const l of recentLearnings) {
                    md.push(`- [${l.severity}] ${l.anti_pattern} -- ${l.correct_pattern}`);
                }
                if (olderLearningsCount > 0) {
                    md.push(`- _(+ ${olderLearningsCount} older -- use cortex_list_learnings to view)_`);
                }
            }
        }
        catch { }
        return { content: [{ type: 'text', text: md.join('\n') }] };
    });
    server.tool('cortex_dejavu', 'Check if a task looks similar to past sessions (deja-vu detection)', { task_description: z.string() }, async ({ task_description }) => {
        const db = getDb();
        // Extract keywords (words > 4 chars)
        const keywords = task_description.split(/\s+/).filter(w => w.length > 4).slice(0, 8);
        if (keywords.length === 0)
            return { content: [{ type: 'text', text: 'No keywords to match.' }] };
        const lines = [];
        for (const kw of keywords) {
            try {
                const matches = db.prepare(`SELECT started_at, summary FROM sessions WHERE summary LIKE ? AND status='completed' ORDER BY started_at DESC LIMIT 2`).all(`%${kw}%`);
                for (const m of matches)
                    lines.push(`[${m.started_at?.slice(0, 10)}] ${m.summary}`);
            }
            catch { }
        }
        const unique = [...new Set(lines)].slice(0, 10);
        return { content: [{ type: 'text', text: unique.length > 0 ? `Deja-vu matches:\n${unique.join('\n')}` : 'No similar sessions found.' }] };
    });
    server.tool('cortex_check_blind_spots', 'Find project files not touched in recent sessions — potential blind spots', { days: z.number().optional().default(14), limit: z.number().optional().default(10) }, async ({ days, limit }) => {
        const db = getDb();
        try {
            const untouched = db.prepare(`
          SELECT path, change_count, last_changed FROM project_files
          WHERE (last_changed IS NULL OR last_changed < datetime('now', ? || ' days'))
            AND change_count > 0
          ORDER BY change_count DESC LIMIT ?
        `).all(`-${days}`, limit);
            if (untouched.length === 0) {
                return { content: [{ type: 'text', text: 'No blind spots detected — all active files touched recently.' }] };
            }
            const lines = [`Blind spots (not touched in ${days}d):`];
            for (const f of untouched) {
                lines.push(`  ${f.path} (${f.change_count} total changes, last: ${f.last_changed?.slice(0, 10) ?? 'never'})`);
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        catch (e) {
            return { content: [{ type: 'text', text: `Error: ${e}` }] };
        }
    });
    server.tool('cortex_forget', 'Archive (soft-delete) decisions, errors, and learnings matching a topic', { topic: z.string().describe('Keyword or phrase to match against') }, async ({ topic }) => {
        const db = getDb();
        const pat = `%${topic}%`;
        let archived = 0;
        try {
            const r = db.prepare(`UPDATE decisions SET archived=1 WHERE (title LIKE ? OR reasoning LIKE ?) AND archived!=1`).run(pat, pat);
            archived += Number(r.changes);
        }
        catch { }
        try {
            const r = db.prepare(`UPDATE errors SET archived=1 WHERE (error_message LIKE ? OR root_cause LIKE ?) AND archived!=1`).run(pat, pat);
            archived += Number(r.changes);
        }
        catch { }
        try {
            const r = db.prepare(`UPDATE learnings SET archived=1 WHERE (anti_pattern LIKE ? OR context LIKE ?) AND archived!=1`).run(pat, pat);
            archived += Number(r.changes);
        }
        catch { }
        return { content: [{ type: 'text', text: `Archived ${archived} item(s) matching "${topic}".` }] };
    });
    server.tool('cortex_get_mood', 'Get current system mood based on rolling average of last 7 sessions', {}, async () => {
        const db = getDb();
        try {
            const sessions = db.prepare(`
          SELECT emotional_tone, mood_score, started_at FROM sessions
          WHERE mood_score IS NOT NULL AND status='completed'
          ORDER BY started_at DESC LIMIT 7
        `).all();
            if (sessions.length === 0) {
                return { content: [{ type: 'text', text: 'No mood data yet. Mood scoring runs after sessions complete.' }] };
            }
            const avg = sessions.reduce((s, r) => s + (r.mood_score ?? 3), 0) / sessions.length;
            const mood = avg >= 4 ? 'positive' : avg >= 3 ? 'neutral' : 'negative';
            const lines = [
                `System Mood: ${mood} (avg ${avg.toFixed(1)}/5 over last ${sessions.length} sessions)`,
                '',
                'Recent sessions:',
                ...sessions.map(s => `  [${s.started_at?.slice(0, 10)}] ${s.emotional_tone ?? 'unknown'} (${s.mood_score}/5)`),
            ];
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        catch (e) {
            return { content: [{ type: 'text', text: `Error: ${e}` }] };
        }
    });
    server.tool('cortex_cross_project_search', 'Search across all projects in this Cortex DB', { query: z.string(), limit: z.number().optional().default(10) }, async ({ query, limit }) => {
        const db = getDb();
        const pat = `%${query}%`;
        const lines = [];
        try {
            const sessions = db.prepare(`SELECT started_at, summary FROM sessions WHERE summary LIKE ? ORDER BY started_at DESC LIMIT ?`).all(pat, limit);
            for (const s of sessions)
                lines.push(`[SESSION] ${s.started_at?.slice(0, 10)}: ${s.summary}`);
        }
        catch { }
        try {
            const decisions = db.prepare(`SELECT title, category FROM decisions WHERE (title LIKE ? OR reasoning LIKE ?) AND archived!=1 LIMIT ?`).all(pat, pat, limit);
            for (const d of decisions)
                lines.push(`[DECISION/${d.category}] ${d.title}`);
        }
        catch { }
        try {
            const learnings = db.prepare(`SELECT anti_pattern, correct_pattern FROM learnings WHERE (anti_pattern LIKE ? OR context LIKE ?) AND archived!=1 LIMIT ?`).all(pat, pat, limit);
            for (const l of learnings)
                lines.push(`[LEARNING] ${l.anti_pattern} → ${l.correct_pattern}`);
        }
        catch { }
        try {
            const notes = db.prepare(`SELECT text, project, created_at FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(pat, limit);
            for (const n of notes)
                lines.push(`[NOTE${n.project ? '/' + n.project : ''}] ${n.text.slice(0, 100)}`);
        }
        catch { }
        return { content: [{ type: 'text', text: lines.join('\n') || 'No cross-project results found.' }] };
    });
}
//# sourceMappingURL=intelligence.js.map