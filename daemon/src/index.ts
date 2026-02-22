import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { EventQueue } from './queue.js';
import { runArchitectAgent } from './agents/architect.js';
import { runContextAgent } from './agents/context.js';
import { runLearnerAgent } from './agents/learner.js';
import { runSynthesizerAgent } from './agents/synthesizerAgent.js';
import { runSerendipityAgent } from './agents/serendipityAgent.js';
import { runDriftDetectorAgent } from './agents/drift-detector.js';
import { runMoodScorerAgent } from './agents/moodScorer.js';
import { runSkillAdvisorAgent } from './agents/skillAdvisor.js';
import { runPatternAgent } from './agents/patternAgent.js';
import { runBootstrapAgent } from './agents/bootstrap.js';

// Args: node daemon/dist/index.js --project <path>
const args = process.argv.slice(2);
const projectIdx = args.indexOf('--project');
if (projectIdx === -1 || !args[projectIdx + 1]) {
  process.stderr.write('[cortex-daemon] Missing --project argument\n');
  process.exit(1);
}
const projectPath = args[projectIdx + 1];
const pidPath = join(projectPath, '.claude', 'cortex-daemon.pid');
const heartbeatPath = join(projectPath, '.claude', 'cortex-daemon.heartbeat');

// PID-File schreiben
try {
  writeFileSync(pidPath, String(process.pid), 'utf-8');
  process.stdout.write(`[cortex-daemon] Started (PID ${process.pid}) for ${projectPath}\n`);
} catch (err) {
  process.stderr.write(`[cortex-daemon] Could not write PID file: ${err}\n`);
  process.exit(1);
}

// Heartbeat sofort + alle 30s schreiben
try { writeFileSync(heartbeatPath, String(Date.now()), 'utf-8'); } catch { /* ignore */ }
setInterval(() => {
  try { writeFileSync(heartbeatPath, String(Date.now()), 'utf-8'); } catch { /* ignore */ }
}, 30_000);

function cleanup(): void {
  try { unlinkSync(pidPath); } catch { /* bereits geloescht */ }
  try { unlinkSync(heartbeatPath); } catch { /* ignore */ }
  process.stdout.write('[cortex-daemon] Stopped\n');
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('exit',    () => { try { unlinkSync(pidPath); } catch { /* ignore */ } });

// Beim Start: Architekt-Analyse (async, nicht blockierend)
runArchitectAgent(projectPath).catch(err => {
  process.stderr.write(`[cortex-daemon] Architect error: ${err}\n`);
});

// Auto-Bootstrap: DB fuellen wenn quasi leer
runBootstrapAgent(projectPath).catch(err => {
  process.stderr.write(`[cortex-daemon] Bootstrap error: ${err}\n`);
});

// Queue-Polling alle 500ms
const queue = new EventQueue(projectPath);

setInterval(() => {
  const events = queue.read();
  if (events.length === 0) return;

  const processed: typeof events = [];

  for (const event of events) {
    if (event.type === 'file_access' && event.file) {
      runContextAgent(projectPath, event.file).catch(err => {
        process.stderr.write(`[cortex-daemon] Context error: ${err}\n`);
      });
      processed.push(event);
    } else if (event.type === 'session_end') {
      runLearnerAgent(projectPath, event.transcript_path).catch(err => {
        process.stderr.write(`[cortex-daemon] Learner error: ${err}\n`);
      });
      runDriftDetectorAgent(projectPath).catch(err => {
        process.stderr.write(`[cortex-daemon] DriftDetector error: ${err}\n`);
      });
      runSynthesizerAgent(projectPath).catch(err => {
        process.stderr.write(`[cortex-daemon] Synthesizer error: ${err}\n`);
      });
      runSerendipityAgent(projectPath).catch(err => {
        process.stderr.write(`[cortex-daemon] Serendipity error: ${err}\n`);
      });
      runMoodScorerAgent(projectPath, event.session_id, event.transcript_path).catch(err => {
        process.stderr.write(`[cortex-daemon] MoodScorer error: ${err}\n`);
      });
      runSkillAdvisorAgent(projectPath, event.transcript_path).catch(err => {
        process.stderr.write(`[cortex-daemon] SkillAdvisor error: ${err}\n`);
      });
      runPatternAgent(projectPath, event.session_id).catch(err => {
        process.stderr.write(`[cortex-daemon] PatternAgent error: ${err}\n`);
      });
      runArchitectAgent(projectPath, 'post_session').catch(err => {
        process.stderr.write(`[cortex-daemon] Architect (post-session) error: ${err}\n`);
      });
      processed.push(event);
    }
  }

  if (processed.length > 0) {
    queue.markProcessed(processed);
  }
}, 500);

process.stdout.write('[cortex-daemon] Polling queue...\n');
