import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

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
  jsonSchema?: object;
  model?: string;
  agentName?: string;
  sessionId?: string;
}

function logAgentStart(projectPath: string, agentName: string, sessionId?: string): number | null {
  try {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath);
    const result = db.prepare(`
      INSERT INTO agent_runs (agent_name, session_id, started_at, success)
      VALUES (?, ?, ?, 0)
    `).run(agentName, sessionId ?? null, new Date().toISOString());
    db.close();
    return result.lastInsertRowid as number;
  } catch { return null; }
}

function logAgentEnd(projectPath: string, runId: number, success: boolean, errorMessage?: string, itemsSaved?: number): void {
  try {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath)) return;
    const db = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE agent_runs
      SET finished_at = ?, success = ?, error_message = ?, items_saved = ?,
          duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
      WHERE id = ?
    `).run(now, success ? 1 : 0, errorMessage ?? null, itemsSaved ?? 0, now, runId);
    db.close();
  } catch { /* ignore */ }
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
      const runId = opts.agentName
        ? logAgentStart(opts.projectPath, opts.agentName, opts.sessionId)
        : null;

      const claudeBin = findClaudeBin();
      // CLAUDECODE muss ungesetzt sein, sonst verweigert Claude Code den Start
      const env = { ...process.env };
      delete env['CLAUDECODE'];

      const args = ['-p', opts.prompt, '--dangerously-skip-permissions'];
      if (opts.model) args.push('--model', opts.model);
      if (opts.jsonSchema) {
        args.push('--output-format', 'json');
        args.push('--json-schema', JSON.stringify(opts.jsonSchema));
      } else {
        args.push('--output-format', 'text');
      }

      const proc = spawn(claudeBin, args, {
        cwd: opts.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        // Windows: .cmd Dateien brauchen shell: true
        shell: claudeBin.endsWith('.cmd'),
        // Windows: verhindert dass cmd.exe-Fenster aufpoppt
        windowsHide: true,
      });

      proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { errOutput += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        if (runId !== null) logAgentEnd(opts.projectPath, runId, false, `Timeout after ${timeout}ms`);
        resolve({ success: false, output, error: `Timeout after ${timeout}ms` });
        processNext();
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const success = code === 0;
        if (runId !== null) logAgentEnd(opts.projectPath, runId, success, success ? undefined : errOutput.slice(0, 500));
        resolve({ success, output, error: errOutput || undefined });
        processNext();
      });
    });

    if (!running) processNext();
  });
}
