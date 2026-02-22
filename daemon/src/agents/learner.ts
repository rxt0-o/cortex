import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { runClaudeAgent } from '../runner.js';

const LEARNER_SCHEMA = {
  type: 'object',
  properties: {
    learnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          anti_pattern: { type: 'string' },
          correct_pattern: { type: 'string' },
          context: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          auto_block: { type: 'boolean' },
          detection_regex: { type: ['string', 'null'] },
          relevance: { type: 'string', enum: ['noise', 'maybe_relevant', 'important', 'critical'] },
          write_gate_reason: { type: 'string' },
        },
        required: ['anti_pattern', 'correct_pattern', 'context', 'relevance', 'write_gate_reason'],
      },
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          error_message: { type: 'string' },
          root_cause: { type: 'string' },
          fix_description: { type: 'string' },
          prevention_rule: { type: ['string', 'null'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        },
        required: ['error_message'],
      },
    },
    architecture_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['file', 'description'],
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          content: { type: 'string' },
          category: { type: 'string', enum: ['fact', 'preference', 'entity', 'context'] },
          valid_until: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] },
        },
        required: ['subject', 'content', 'category'],
      },
    },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          observation: { type: 'string' },
          implication: { type: 'string' },
          context: { type: ['string', 'null'] },
          relevance: { type: 'string', enum: ['noise', 'maybe_relevant', 'important', 'critical'] },
        },
        required: ['observation', 'implication', 'relevance'],
      },
    },
  },
  required: ['learnings', 'errors', 'architecture_updates', 'facts', 'insights'],
};

export async function runLearnerAgent(projectPath: string, transcriptPath?: string): Promise<void> {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) return;

  const db = new DatabaseSync(dbPath);

  try {
    // Geänderte Dateien aus letzter Session (letzte 2h)
    const recentFiles = db.prepare(`
      SELECT path, file_type FROM project_files
      WHERE last_changed > datetime('now', '-2 hours')
      ORDER BY last_changed DESC
      LIMIT 20
    `).all() as Array<{ path: string; file_type: string | null }>;

    // Transcript-Auszug (letzte 8000 Zeichen)
    let transcriptSample = '';
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        const content = readFileSync(transcriptPath, 'utf-8');
        transcriptSample = content.slice(-8000);
      } catch { /* nicht lesbar */ }
    }

    if (recentFiles.length === 0 && !transcriptSample) {
      process.stdout.write('[cortex-daemon] Learner: no recent activity, skipping\n');
      return;
    }

    const prompt = `<role>
Du bist ein Code-Qualitaets-Analyst. Analysiere die letzte Coding-Session und extrahiere strukturiertes Wissen.
</role>

<session_data>
<changed_files>
${recentFiles.map(f => `${f.path} [${f.file_type ?? 'unknown'}]`).join('\n') || '(keine)'}
</changed_files>
${transcriptSample ? `<transcript>
${transcriptSample}
</transcript>` : ''}
</session_data>

<write_gate>
Nur speichern wenn MINDESTENS EINE Bedingung erfuellt ist:
- Fehler der sich wiederholen wird (zukuenftiges Verhalten aendern)
- Stabile, wiederverwendbare Tatsache (kein Einmal-Hack)
- Entscheidungslogik die nachvollziehbar sein muss
- Explizit korrigierter Fehler (gemacht, dann behoben)
NICHT speichern: Triviales, Offensichtliches, Einmalfehler ohne Wiederholungsrisiko.
</write_gate>

<relevance_categories>
Vergib fuer jedes Learning eine relevance-Kategorie und begruende kurz (write_gate_reason):
- "noise": trivial, offensichtlich — wird archiviert, nie angezeigt
- "maybe_relevant": moeglicherweise nuetzlich, unklar ob wiederkehrend
- "important": klarer Mehrwert, sollte beachtet werden
- "critical": muss verhindert werden, auto_block Kandidat
Sei streng: lieber "noise" als falsch "important".
</relevance_categories>

<analysis_targets>
1. Fehler gemacht + korrigiert -> learnings (anti_pattern + correct_pattern)
2. Wiederkehrende Probleme -> learnings (prevention rule)
3. Stabile Projektfakten -> facts (z.B. "Projekt nutzt SQLite WAL-Mode")
4. Beobachtungen ohne Anti-Pattern -> insights (observation + implication)
5. Neue Architektur-Zusammenhaenge -> architecture_updates

Facts-Kategorien: "fact" (technische Tatsache) | "preference" (Nutzerpraeferenz) | "entity" (Person/System/Service) | "context" (Projektkontext)
</analysis_targets>

<instructions>
Antworte NUR mit diesem JSON. Leere Arrays sind OK — bevorzuge leere Arrays statt trivialer Eintraege.
</instructions>
{
  "learnings": [
    {
      "anti_pattern": "Was falsch gemacht wurde (konkret)",
      "correct_pattern": "Die korrekte Loesung",
      "context": "In welchem Kontext (welche Datei/Feature)",
      "severity": "low|medium|high",
      "auto_block": false,
      "detection_regex": null,
      "relevance": "important",
      "write_gate_reason": "Explizit korrigierter Fehler, wird sich wiederholen"
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
  ],
  "facts": [
    {
      "subject": "SQLite WAL-Mode",
      "content": "Projekt nutzt PRAGMA journal_mode=WAL fuer bessere Concurrency",
      "category": "fact",
      "valid_until": null,
      "source": "ensure-db.js"
    }
  ],
  "insights": [
    {
      "observation": "on-session-end.js wird haeufig angepasst",
      "implication": "Hook-Logik ist ein Hotspot — Aenderungen sorgfaeltig testen",
      "context": "scripts/",
      "relevance": "maybe_relevant"
    }
  ]
}`;

    const result = await runClaudeAgent({ prompt, projectPath, timeoutMs: 120_000, jsonSchema: LEARNER_SCHEMA, model: 'claude-sonnet-4-6' });

    if (!result.success || !result.output) {
      process.stderr.write(`[cortex-daemon] Learner: agent failed: ${result.error ?? 'no output'}\n`);
      return;
    }

    let analysis: {
      learnings?: Array<{
        anti_pattern: string;
        correct_pattern: string;
        context: string;
        severity?: string;
        auto_block?: boolean;
        detection_regex?: string | null;
        relevance?: string;
        write_gate_reason?: string;
      }>;
      errors?: Array<{
        error_message: string;
        root_cause?: string;
        fix_description?: string;
        prevention_rule?: string | null;
        severity?: string;
      }>;
      architecture_updates?: Array<{ file: string; description: string }>;
      facts?: Array<{
        subject: string;
        content: string;
        category?: string;
        valid_until?: string | null;
        source?: string | null;
      }>;
      insights?: Array<{
        observation: string;
        implication: string;
        context?: string | null;
        relevance?: string;
      }>;
    };

    try {
      const parsed = JSON.parse(result.output);
      // structured_output wenn JSON-Schema-Mode, sonst direktes Objekt oder Regex-Fallback
      analysis = parsed?.structured_output ?? parsed;
      if (!analysis || typeof analysis !== 'object') throw new Error('invalid');
    } catch {
      // Fallback: Regex-Match für Rückwärtskompatibilität
      try {
        const jsonMatch = result.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;
        analysis = JSON.parse(jsonMatch[0]);
      } catch { return; }
    }

    const ts = new Date().toISOString();
    let saved = 0;

    // Learnings speichern
    if (analysis.learnings) {
      for (const l of analysis.learnings) {
        if (!l.anti_pattern || !l.correct_pattern) continue;
        const relevance = l.relevance ?? 'maybe_relevant';
        process.stdout.write(`[cortex-daemon] Learner: [${relevance}] ${l.anti_pattern.slice(0, 60)}\n`);
        try {
          // Pruefen ob ein aelteres Learning zum selben anti_pattern existiert
          const existing = db.prepare(`
            SELECT id FROM learnings
            WHERE anti_pattern = ? AND superseded_by IS NULL AND archived = 0
            LIMIT 1
          `).get(l.anti_pattern) as { id: number } | undefined;

          const result = db.prepare(`
            INSERT INTO learnings (created_at, anti_pattern, correct_pattern, context, severity, auto_block, detection_regex, relevance, write_gate_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            ts, l.anti_pattern, l.correct_pattern, l.context,
            l.severity ?? 'medium',
            l.auto_block ? 1 : 0,
            l.detection_regex ?? null,
            relevance,
            l.write_gate_reason ?? null
          );

          // Altes Learning als superseded markieren
          if (existing) {
            db.prepare(`UPDATE learnings SET superseded_by = ?, superseded_at = ? WHERE id = ?`)
              .run(result.lastInsertRowid, ts, existing.id);
          }

          saved++;
        } catch { /* Duplikat */ }
      }
    }

    // Errors speichern
    if (analysis.errors) {
      for (const e of analysis.errors) {
        if (!e.error_message) continue;
        const sig = Buffer.from(e.error_message.slice(0, 100)).toString('base64').slice(0, 64);
        try {
          db.prepare(`
            INSERT INTO errors (first_seen, last_seen, error_signature, error_message, root_cause, fix_description, prevention_rule, severity)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(error_signature) DO UPDATE SET
              occurrences = occurrences + 1,
              last_seen = excluded.last_seen
          `).run(
            ts, ts, sig, e.error_message,
            e.root_cause ?? null,
            e.fix_description ?? null,
            e.prevention_rule ?? null,
            e.severity ?? 'medium'
          );
          saved++;
        } catch { /* ignorieren */ }
      }
    }

    // Architecture updates
    if (analysis.architecture_updates) {
      for (const u of analysis.architecture_updates) {
        if (!u.file || !u.description) continue;
        db.prepare('UPDATE project_files SET description = ? WHERE path LIKE ?')
          .run(u.description.slice(0, 500), `%${u.file}%`);
      }
    }

    // Facts speichern
    if (analysis.facts) {
      for (const f of analysis.facts) {
        if (!f.subject || !f.content) continue;
        try {
          // Alten Fact zum gleichen subject als superseded markieren
          const existing = db.prepare(`
            SELECT id FROM facts WHERE subject = ? AND superseded_by IS NULL LIMIT 1
          `).get(f.subject) as { id: number } | undefined;

          const fResult = db.prepare(`
            INSERT INTO facts (created_at, subject, content, category, valid_until, source)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(ts, f.subject, f.content, f.category ?? 'fact', f.valid_until ?? null, f.source ?? null);

          if (existing) {
            db.prepare(`UPDATE facts SET superseded_by = ?, superseded_at = ? WHERE id = ?`)
              .run(fResult.lastInsertRowid, ts, existing.id);
          }
          saved++;
        } catch { /* ignorieren */ }
      }
    }

    // Insights speichern
    if (analysis.insights) {
      for (const i of analysis.insights) {
        if (!i.observation || !i.implication) continue;
        try {
          db.prepare(`
            INSERT INTO insights (created_at, observation, implication, context, relevance)
            VALUES (?, ?, ?, ?, ?)
          `).run(ts, i.observation, i.implication, i.context ?? null, i.relevance ?? 'maybe_relevant');
          saved++;
        } catch { /* ignorieren */ }
      }
    }

    process.stdout.write(`[cortex-daemon] Learner: saved ${saved} items to DB\n`);

  } finally {
    db.close();
  }
}
