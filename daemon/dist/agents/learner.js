import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { runClaudeAgent } from '../runner.js';
export async function runLearnerAgent(projectPath, transcriptPath) {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath))
        return;
    const db = new DatabaseSync(dbPath);
    try {
        // Geänderte Dateien aus letzter Session (letzte 2h)
        const recentFiles = db.prepare(`
      SELECT path, file_type FROM project_files
      WHERE last_changed > datetime('now', '-2 hours')
      ORDER BY last_changed DESC
      LIMIT 20
    `).all();
        // Transcript-Auszug (letzte 8000 Zeichen)
        let transcriptSample = '';
        if (transcriptPath && existsSync(transcriptPath)) {
            try {
                const content = readFileSync(transcriptPath, 'utf-8');
                transcriptSample = content.slice(-8000);
            }
            catch { /* nicht lesbar */ }
        }
        if (recentFiles.length === 0 && !transcriptSample) {
            process.stdout.write('[cortex-daemon] Learner: no recent activity, skipping\n');
            return;
        }
        const prompt = `Du bist ein Code-Qualitaets-Analyst fuer das AriseTools-Projekt (React/FastAPI/Supabase).

In der letzten Session wurden folgende Dateien geaendert:
${recentFiles.map(f => `- ${f.path} [${f.file_type ?? 'unknown'}]`).join('\n') || '(keine)'}

${transcriptSample ? `Auszug aus dem Session-Transcript (letzte Aktivitaeten):
\`\`\`
${transcriptSample}
\`\`\`` : ''}

Analysiere ob:
1. Fehler gemacht und korrigiert wurden -> Anti-Pattern lernen
2. Wiederkehrende Probleme aufgetreten sind -> Prevention Rule
3. Neue Architektur-Zusammenhaenge sichtbar wurden

Antworte NUR mit diesem JSON (leere Arrays sind OK wenn nichts gefunden):
{
  "learnings": [
    {
      "anti_pattern": "Was falsch gemacht wurde (konkret)",
      "correct_pattern": "Die korrekte Loesung",
      "context": "In welchem Kontext (welche Datei/Feature)",
      "severity": "low|medium|high",
      "auto_block": false,
      "detection_regex": null
    }
  ],
  "errors": [
    {
      "error_message": "Fehlerbeschreibung",
      "root_cause": "Ursache",
      "fix_description": "Fix",
      "prevention_rule": null,
      "severity": "low|medium|high|critical"
    }
  ],
  "architecture_updates": [
    {
      "file": "relativer/pfad/zur/datei.ts",
      "description": "Neue Beschreibung der Datei"
    }
  ]
}`;
        const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 120_000 });
        if (!result.success || !result.output) {
            process.stderr.write(`[cortex-daemon] Learner: agent failed: ${result.error ?? 'no output'}\n`);
            return;
        }
        let analysis;
        try {
            const jsonMatch = result.output.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                return;
            analysis = JSON.parse(jsonMatch[0]);
        }
        catch {
            return;
        }
        const ts = new Date().toISOString();
        let saved = 0;
        // Learnings speichern
        if (analysis.learnings) {
            for (const l of analysis.learnings) {
                if (!l.anti_pattern || !l.correct_pattern)
                    continue;
                try {
                    db.prepare(`
            INSERT INTO learnings (created_at, anti_pattern, correct_pattern, context, severity, auto_block, detection_regex)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(ts, l.anti_pattern, l.correct_pattern, l.context, l.severity ?? 'medium', l.auto_block ? 1 : 0, l.detection_regex ?? null);
                    saved++;
                }
                catch { /* Duplikat */ }
            }
        }
        // Errors speichern
        if (analysis.errors) {
            for (const e of analysis.errors) {
                if (!e.error_message)
                    continue;
                const sig = Buffer.from(e.error_message.slice(0, 100)).toString('base64').slice(0, 64);
                try {
                    db.prepare(`
            INSERT INTO errors (first_seen, last_seen, error_signature, error_message, root_cause, fix_description, prevention_rule, severity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(error_signature) DO UPDATE SET
              occurrences = occurrences + 1,
              last_seen = excluded.last_seen
          `).run(ts, ts, sig, e.error_message, e.root_cause ?? null, e.fix_description ?? null, e.prevention_rule ?? null, e.severity ?? 'medium');
                    saved++;
                }
                catch { /* ignorieren */ }
            }
        }
        // Architecture updates
        if (analysis.architecture_updates) {
            for (const u of analysis.architecture_updates) {
                if (!u.file || !u.description)
                    continue;
                db.prepare('UPDATE project_files SET description = ? WHERE path LIKE ?')
                    .run(u.description.slice(0, 500), `%${u.file}%`);
            }
        }
        process.stdout.write(`[cortex-daemon] Learner: saved ${saved} items to DB\n`);
    }
    finally {
        db.close();
    }
}
