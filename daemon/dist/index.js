import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { EventQueue } from './queue.js';
import { runArchitectAgent } from './agents/architect.js';
import { runContextAgent } from './agents/context.js';
import { runLearnerAgent } from './agents/learner.js';
import { runDriftDetectorAgent } from './agents/drift-detector.js';
// Args: node daemon/dist/index.js --project <path>
const args = process.argv.slice(2);
const projectIdx = args.indexOf('--project');
if (projectIdx === -1 || !args[projectIdx + 1]) {
    process.stderr.write('[cortex-daemon] Missing --project argument\n');
    process.exit(1);
}
const projectPath = args[projectIdx + 1];
const pidPath = join(projectPath, '.claude', 'cortex-daemon.pid');
// PID-File schreiben
try {
    writeFileSync(pidPath, String(process.pid), 'utf-8');
    process.stdout.write(`[cortex-daemon] Started (PID ${process.pid}) for ${projectPath}\n`);
}
catch (err) {
    process.stderr.write(`[cortex-daemon] Could not write PID file: ${err}\n`);
    process.exit(1);
}
function cleanup() {
    try {
        unlinkSync(pidPath);
    }
    catch { /* bereits geloescht */ }
    process.stdout.write('[cortex-daemon] Stopped\n');
}
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', () => { try {
    unlinkSync(pidPath);
}
catch { /* ignore */ } });
// Beim Start: Architekt-Analyse (async, nicht blockierend)
runArchitectAgent(projectPath).catch(err => {
    process.stderr.write(`[cortex-daemon] Architect error: ${err}\n`);
});
// Queue-Polling alle 500ms
const queue = new EventQueue(projectPath);
setInterval(() => {
    const events = queue.read();
    if (events.length === 0)
        return;
    const processed = [];
    for (const event of events) {
        if (event.type === 'file_access' && event.file) {
            runContextAgent(projectPath, event.file).catch(err => {
                process.stderr.write(`[cortex-daemon] Context error: ${err}\n`);
            });
            processed.push(event);
        }
        else if (event.type === 'session_end') {
            runLearnerAgent(projectPath, event.transcript_path).catch(err => {
                process.stderr.write(`[cortex-daemon] Learner error: ${err}\n`);
            });
            runDriftDetectorAgent(projectPath).catch(err => {
                process.stderr.write(`[cortex-daemon] DriftDetector error: ${err}\n`);
            });
            processed.push(event);
        }
    }
    if (processed.length > 0) {
        queue.markProcessed(processed);
    }
}, 500);
process.stdout.write('[cortex-daemon] Polling queue...\n');
