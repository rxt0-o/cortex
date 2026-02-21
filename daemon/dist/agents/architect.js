import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';
export async function runArchitectAgent(projectPath) {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath))
        return;
    const db = new DatabaseSync(dbPath);
    try {
        // Bekannte Dateien aus DB lesen (max 200)
        const files = db.prepare(`
      SELECT f.path, f.file_type, f.description, m.name as module_name
      FROM project_files f
      LEFT JOIN project_modules m ON f.module_id = m.id
      WHERE f.file_type IS NOT NULL
      ORDER BY f.path
      LIMIT 200
    `).all();
        if (files.length === 0) {
            process.stdout.write('[cortex-daemon] Architect: no files in DB yet, skipping\n');
            return;
        }
        const fileList = files
            .map(f => `${f.path} [${f.file_type}${f.module_name ? `, module: ${f.module_name}` : ''}]${f.description ? ': ' + f.description : ''}`)
            .join('\n');
        const prompt = `Du bist ein Software-Architekt und analysierst das AriseTools-Projekt (Solo Leveling: Arise Web-App).

Stack: React 18/Vite (Frontend) + FastAPI/Python (Backend) + Supabase (DB) + Directus CMS

Bekannte Projektdateien:
${fileList}

Deine Aufgabe:
1. Identifiziere die wichtigsten Feature-Gruppen (z.B. "Builds", "Calculator", "Teams", "TierList", "News")
2. Beschreibe fuer jedes Feature den Full-Stack-Trace: Frontend-Page -> Hook -> Service -> Backend-Route -> DB-Tabelle
3. Identifiziere kritische Shared-Files die viele andere abhaengen

Antworte NUR mit diesem JSON (kein Markdown, kein Text davor/danach):
{
  "features": [
    {
      "name": "Builds",
      "frontend": ["PublicBuilds.tsx"],
      "hooks": ["useBuildQueries.ts"],
      "services": ["buildService.ts"],
      "backend": ["routes/builds.py"],
      "db": ["builds", "build_votes"],
      "description": "Kurze Beschreibung"
    }
  ],
  "critical_files": [
    { "path": "frontend/src/lib/queryKeys.ts", "reason": "Zentraler Query-Key-Store" }
  ],
  "summary": "2-3 Saetze Gesamtueberblick"
}`;
        const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 120_000 });
        if (!result.success || !result.output) {
            process.stderr.write(`[cortex-daemon] Architect: agent failed: ${result.error ?? 'no output'}\n`);
            return;
        }
        // JSON aus Output extrahieren
        let analysis;
        try {
            const jsonMatch = result.output.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                process.stderr.write('[cortex-daemon] Architect: no JSON found in output\n');
                return;
            }
            analysis = JSON.parse(jsonMatch[0]);
        }
        catch (e) {
            process.stderr.write(`[cortex-daemon] Architect: JSON parse failed: ${e}\n`);
            return;
        }
        const ts = new Date().toISOString();
        // Features als Decisions in DB speichern
        if (analysis.features) {
            for (const feature of analysis.features) {
                const reasoning = [
                    feature.description ?? '',
                    feature.frontend?.length ? `Frontend: ${feature.frontend.join(', ')}` : '',
                    feature.hooks?.length ? `Hooks: ${feature.hooks.join(', ')}` : '',
                    feature.services?.length ? `Services: ${feature.services.join(', ')}` : '',
                    feature.backend?.length ? `Backend: ${feature.backend.join(', ')}` : '',
                    feature.db?.length ? `DB-Tabellen: ${feature.db.join(', ')}` : '',
                ].filter(Boolean).join('\n');
                try {
                    db.prepare(`
            INSERT OR IGNORE INTO decisions (created_at, category, title, reasoning, confidence)
            VALUES (?, 'architecture', ?, ?, 'high')
          `).run(ts, `[Architekt] Feature: ${feature.name}`, reasoning);
                }
                catch { /* Duplikat */ }
            }
        }
        // Gesamtübersicht als Decision
        if (analysis.summary) {
            try {
                db.prepare(`
          INSERT OR IGNORE INTO decisions (created_at, category, title, reasoning, confidence)
          VALUES (?, 'architecture', '[Architekt] Gesamt-Überblick', ?, 'high')
        `).run(ts, analysis.summary);
            }
            catch { /* Duplikat */ }
        }
        const featureCount = analysis.features?.length ?? 0;
        process.stdout.write(`[cortex-daemon] Architect: saved ${featureCount} features to DB\n`);
    }
    finally {
        db.close();
    }
}
