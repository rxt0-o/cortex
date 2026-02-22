#!/usr/bin/env node
// UserPromptSubmit Hook — Kontext-Frühwarnung via Transcript-Größe

import { readFileSync, existsSync, statSync } from 'fs';

// Schwellwerte in MB (Transcript-Größe als Proxy für Kontext-Auslastung)
// Kalibriert nach User-Feedback: erste Warnung bei 1.2MB
// 70% ≈ 1.2MB, 85% ≈ 1.5MB, 95% ≈ 1.7MB
const THRESHOLDS = [
  {
    mb: 1.2,
    level: 'warn',
    message: 'CORTEX: Kontext ~70% voll — jetzt offene Punkte mit cortex_add_unfinished sichern.',
  },
  {
    mb: 1.5,
    level: 'urgent',
    message: 'CORTEX WARNUNG: Kontext ~85% voll — cortex_save_session jetzt aufrufen, Compaction steht bevor.',
  },
  {
    mb: 1.7,
    level: 'critical',
    message: 'CORTEX KRITISCH: Kontext fast voll — sofort cortex_save_session aufrufen, dann /compact.',
  },
];

function main() {
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const { transcript_path } = input;

  if (!transcript_path || !existsSync(transcript_path)) {
    process.exit(0);
  }

  const bytes = statSync(transcript_path).size;
  const mb = bytes / (1024 * 1024);

  // Höchsten zutreffenden Schwellwert finden
  let triggered = null;
  for (const t of THRESHOLDS) {
    if (mb >= t.mb) triggered = t;
  }

  if (!triggered) {
    process.exit(0);
  }

  const context = `${triggered.message} (Transcript: ${mb.toFixed(1)}MB)`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }));
}

try { main(); } catch { process.exit(0); }
