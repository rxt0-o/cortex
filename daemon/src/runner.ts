import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

export interface AgentContext {
  recentDiffs: Array<{ file_path: string; created_at: string; diff_preview: string }>;
  hotZones: Array<{ path: string; access_count: number }>;
  sessionDelta: {
    newErrors: number;
    newLearnings: number;
    newDecisions: number;
  };
  lastAgentRun: { agent_name: string; started_at: string; success: boolean } | null;
}

export function buildAgentContext(projectPath: string, agentName?: string): AgentContext {
  const dbPath = join(projectPath, '.claude', 'cortex.db');
  if (!existsSync(dbPath)) {
    return { recentDiffs: [], hotZones: [], sessionDelta: { newErrors: 0, newLearnings: 0, newDecisions: 0 }, lastAgentRun: null };
  }
  try {
    const db = new DatabaseSync(dbPath);

    const recentDiffs = db.prepare(`
      SELECT file_path, created_at, SUBSTR(diff_text, 1, 200) as diff_preview
      FROM diffs
      WHERE created_at > datetime('now', '-2 hours')
      ORDER BY created_at DESC
      LIMIT 10
    `).all() as Array<{ file_path: string; created_at: string; diff_preview: string }>;

    const hotZones = db.prepare(`
      SELECT path, access_count FROM project_files
      WHERE access_count > 0
      ORDER BY access_count DESC
      LIMIT 5
    `).all() as Array<{ path: string; access_count: number }>;

    const newErrors = (db.prepare(`SELECT COUNT(*) as n FROM errors WHERE first_seen > datetime('now', '-2 hours')`).get() as any)?.n ?? 0;
    const newLearnings = (db.prepare(`SELECT COUNT(*) as n FROM learnings WHERE created_at > datetime('now', '-2 hours') AND archived = 0`).get() as any)?.n ?? 0;
    const newDecisions = (db.prepare(`SELECT COUNT(*) as n FROM decisions WHERE created_at > datetime('now', '-2 hours') AND archived != 1`).get() as any)?.n ?? 0;

    const lastAgentRun = agentName
      ? db.prepare(`SELECT agent_name, started_at, success FROM agent_runs WHERE agent_name = ? ORDER BY started_at DESC LIMIT 1`).get(agentName) as any
      : null;

    db.close();
    return {
      recentDiffs,
      hotZones,
      sessionDelta: { newErrors, newLearnings, newDecisions },
      lastAgentRun,
    };
  } catch {
    return { recentDiffs: [], hotZones: [], sessionDelta: { newErrors: 0, newLearnings: 0, newDecisions: 0 }, lastAgentRun: null };
  }
}

export function formatAgentContext(ctx: AgentContext): string {
  const parts: string[] = [];

  if (ctx.recentDiffs.length > 0) {
    parts.push(`<recent_diffs>\n${ctx.recentDiffs.map(d =>
      `${d.file_path} [${d.created_at.slice(11, 16)}]: ${d.diff_preview?.replace(/\n/g, ' ').slice(0, 100) ?? ''}`
    ).join('\n')}\n</recent_diffs>`);
  }

  if (ctx.hotZones.length > 0) {
    parts.push(`<hot_zones>\n${ctx.hotZones.map(h => `${h.path} (${h.access_count}x)`).join('\n')}\n</hot_zones>`);
  }

  const { newErrors, newLearnings, newDecisions } = ctx.sessionDelta;
  if (newErrors + newLearnings + newDecisions > 0) {
    parts.push(`<session_delta>Letzte 2h: ${newErrors} neue Errors, ${newLearnings} neue Learnings, ${newDecisions} neue Decisions</session_delta>`);
  }

  return parts.length > 0 ? `\n<agent_context>\n${parts.join('\n')}\n</agent_context>\n` : '';
}

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
