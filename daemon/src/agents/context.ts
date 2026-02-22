import { DatabaseSync } from 'node:sqlite';
import { join, basename } from 'path';
import { existsSync, appendFileSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

// Debounce: gleiche Datei nicht öfter als 1x/60s analysieren
const recentlyAnalyzed = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

export async function runContextAgent(projectPath: string, filePath: string): Promise<void> {
  const now = Date.now();
  const last = recentlyAnalyzed.get(filePath);
  if (last && now - last < DEBOUNCE_MS) return;
  recentlyAnalyzed.set(filePath, now);

  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    const fileName = basename(filePath);

    // Datei-Info aus DB
    const fileInfo = db.prepare(`
      SELECT path, file_type, description FROM project_files
      WHERE path LIKE ? OR path LIKE ?
      LIMIT 1
    `).get(`%${fileName}`, `%${fileName.replace(/\\/g, '/')}`) as {
      path: string; file_type: string | null; description: string | null;
    } | undefined;

    // Imports der Datei
    const imports = db.prepare(`
      SELECT target_file FROM dependencies WHERE source_file LIKE ?
    `).all(`%${fileName}`) as Array<{ target_file: string }>;

    // Wer importiert diese Datei?
    const importedBy = db.prepare(`
      SELECT source_file FROM dependencies WHERE target_file LIKE ?
    `).all(`%${fileName}`) as Array<{ source_file: string }>;

    // Relevante Architektur-Decisions
    const relDecisions = db.prepare(`
      SELECT title FROM decisions
      WHERE category = 'architecture' AND (title LIKE ? OR reasoning LIKE ?)
      LIMIT 3
    `).all(`%${fileName}%`, `%${fileName}%`) as Array<{ title: string }>;

    const prompt = `Du bist ein Code-Kontext-Assistent fuer das AriseTools-Projekt (React/FastAPI/Supabase Web-App).

Datei gerade geoeffnet: ${filePath}

Bekannte Infos:
- Typ: ${fileInfo?.file_type ?? 'unbekannt'}
- Importiert: ${imports.slice(0, 5).map(i => i.target_file).join(', ') || 'keine bekannt'}
- Wird genutzt von: ${importedBy.slice(0, 5).map(i => i.source_file).join(', ') || 'keine bekannt'}
- Architektur-Kontext: ${relDecisions.map(d => d.title).join(', ') || 'keine'}

Gib eine KOMPAKTE Zusammenfassung (max. 4 Zeilen):
Zeile 1: [Dateiname]: [Was sie macht]
Zeile 2: Haengt zusammen mit: [2-3 wichtigste Verbindungen]
Zeile 3: Achtung: [1 wichtiger Gotcha wenn relevant, sonst weglassen]

Antworte NUR mit diesen 3-4 Zeilen, kein Markdown, keine Erklaerungen.`;

    const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 30_000, agentName: 'context' });

    if (!result.success || !result.output.trim()) return;

    const message = result.output.trim();

    // Feedback in cortex-feedback.jsonl schreiben (Hook liest diese Datei)
    const feedbackPath = join(projectPath, '.claude', 'cortex-feedback.jsonl');
    const feedback = {
      ts: new Date().toISOString(),
      file: filePath,
      message,
    };
    appendFileSync(feedbackPath, JSON.stringify(feedback) + '\n', 'utf-8');

    // Beschreibung in project_files aktualisieren wenn noch keine vorhanden
    if (fileInfo && !fileInfo.description) {
      db.prepare('UPDATE project_files SET description = ? WHERE path LIKE ?')
        .run(message.slice(0, 300), `%${fileName}`);
    }

    process.stdout.write(`[cortex-daemon] Context: feedback written for ${fileName}\n`);

  } finally {
    db.close();
  }
}
