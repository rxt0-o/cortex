import { spawn } from 'child_process';

export interface RunnerOptions {
  prompt: string;
  projectPath: string;
  timeoutMs?: number;
}

export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
}

// Serial Queue — verhindert parallele claude-Prozesse
let running = false;
const pendingQueue: Array<() => void> = [];

function processNext(): void {
  const next = pendingQueue.shift();
  if (!next) { running = false; return; }
  running = true;
  next();
}

export async function runClaudeAgent(opts: RunnerOptions): Promise<RunnerResult> {
  return new Promise((resolve) => {
    pendingQueue.push(() => {
      const timeout = opts.timeoutMs ?? 90_000;
      let output = '';
      let errOutput = '';

      const proc = spawn('claude', [
        '-p', opts.prompt,
        '--output-format', 'text',
        '--dangerously-skip-permissions',
      ], {
        cwd: opts.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { errOutput += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve({ success: false, output, error: `Timeout after ${timeout}ms` });
        processNext();
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ success: code === 0, output, error: errOutput || undefined });
        processNext();
      });
    });

    if (!running) processNext();
  });
}
