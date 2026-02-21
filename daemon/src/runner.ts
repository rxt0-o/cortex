import { spawn } from 'child_process';
import { existsSync } from 'fs';

// Windows: claude.cmd im npm-Verzeichnis finden
function findClaudeBin(): string {
  const candidates = [
    process.env.CLAUDE_BIN,
    // npm global bin (Windows)
    `${process.env.APPDATA}\\npm\\claude.cmd`,
    `${process.env.APPDATA}\\npm\\claude`,
    // Unix
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'claude'; // Fallback: PATH
}

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

      const claudeBin = findClaudeBin();
      // CLAUDECODE muss ungesetzt sein, sonst verweigert Claude Code den Start
      const env = { ...process.env };
      delete env['CLAUDECODE'];

      const proc = spawn(claudeBin, [
        '-p', opts.prompt,
        '--output-format', 'text',
        '--dangerously-skip-permissions',
      ], {
        cwd: opts.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        // Windows: .cmd Dateien brauchen shell: true
        shell: claudeBin.endsWith('.cmd'),
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
