#!/usr/bin/env node
// UserPromptSubmit Hook — Kontext-Frühwarnung via Transcript-Größe

import { readFileSync, existsSync, statSync } from 'fs';

// Schwellwerte in MB (Transcript-Größe als Proxy für Kontext-Auslastung)
// Kalibriert: 559KB ≈ 50% → Vollauslastung ≈ 1.1MB
// 70% ≈ 0.77MB, 85% ≈ 0.94MB, 95% ≈ 1.05MB
const THRESHOLDS = [
  {
    mb: 0.75,
    level: 'warn',
    message: 'CORTEX: Kontext ~70% voll — jetzt offene Punkte mit cortex_add_unfinished sichern.',
  },
  {
    mb: 0.92,
    level: 'urgent',
    message: 'CORTEX WARNUNG: Kontext ~85% voll — cortex_save_session jetzt aufrufen, Compaction steht bevor.',
  },
  {
    mb: 1.03,
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
