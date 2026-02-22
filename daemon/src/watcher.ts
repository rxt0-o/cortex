import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const args = process.argv.slice(2);
const projectIdx = args.indexOf('--project');
if (projectIdx === -1 || !args[projectIdx + 1]) {
  process.stderr.write('[cortex-watcher] Missing --project argument\n');
  process.exit(1);
}
const projectPath = args[projectIdx + 1];
const watcherPidPath = join(projectPath, '.claude', 'cortex-watcher.pid');
const daemonPidPath  = join(projectPath, '.claude', 'cortex-daemon.pid');
const heartbeatPath  = join(projectPath, '.claude', 'cortex-daemon.heartbeat');
const daemonScript   = join(__dirname, 'index.js');

// Eigene PID schreiben
try {
  writeFileSync(watcherPidPath, String(process.pid), 'utf-8');
  process.stdout.write(`[cortex-watcher] Started (PID ${process.pid})\n`);
} catch (err) {
  process.stderr.write(`[cortex-watcher] Could not write PID: ${err}\n`);
  process.exit(1);
}

function cleanup(): void {
  try { unlinkSync(watcherPidPath); } catch { /* ignore */ }
}
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('exit',    () => { try { unlinkSync(watcherPidPath); } catch { /* ignore */ } });

function isDaemonAlive(): boolean {
  if (!existsSync(daemonPidPath)) return false;
  try {
    const pid = parseInt(readFileSync(daemonPidPath, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDaemon(): void {
  try {
    const proc = spawn('node', [daemonScript, '--project', projectPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true,
    });
    proc.unref();
    process.stdout.write('[cortex-watcher] Daemon restarted\n');
  } catch (err) {
    process.stderr.write(`[cortex-watcher] Could not restart daemon: ${err}\n`);
  }
}

function check(): void {
  const heartbeatOk = (() => {
    if (!existsSync(heartbeatPath)) return false;
    try {
      const ts = parseInt(readFileSync(heartbeatPath, 'utf-8').trim(), 10);
      return (Date.now() - ts) < 90_000;
    } catch { return false; }
  })();

  if (!heartbeatOk && !isDaemonAlive()) {
    process.stdout.write('[cortex-watcher] Daemon unresponsive — restarting\n');
    startDaemon();
  }
}

// Sofort + alle 15s prüfen
check();
setInterval(check, 15_000);
process.stdout.write('[cortex-watcher] Watching daemon...\n');
