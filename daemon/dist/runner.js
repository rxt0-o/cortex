import { spawn } from 'child_process';
import { existsSync } from 'fs';
// Windows: claude.cmd im npm-Verzeichnis finden
function findClaudeBin() {
    const candidates = [
        process.env.CLAUDE_BIN,
        // npm global bin (Windows)
        `${process.env.APPDATA}\\npm\\claude.cmd`,
        `${process.env.APPDATA}\\npm\\claude`,
        // Unix
        '/usr/local/bin/claude',
        '/usr/bin/claude',
    ].filter(Boolean);
    for (const c of candidates) {
        if (existsSync(c))
            return c;
    }
    return 'claude'; // Fallback: PATH
}
// Serial Queue — verhindert parallele claude-Prozesse
let running = false;
const pendingQueue = [];
function processNext() {
    const next = pendingQueue.shift();
    if (!next) {
        running = false;
        return;
    }
    running = true;
    next();
}
export async function runClaudeAgent(opts) {
    return new Promise((resolve) => {
        pendingQueue.push(() => {
            const timeout = opts.timeoutMs ?? 90_000;
            let output = '';
            let errOutput = '';
            const claudeBin = findClaudeBin();
            // CLAUDECODE muss ungesetzt sein, sonst verweigert Claude Code den Start
            const env = { ...process.env };
            delete env['CLAUDECODE'];
            const args = ['-p', opts.prompt, '--dangerously-skip-permissions'];
            if (opts.model)
                args.push('--model', opts.model);
            if (opts.jsonSchema) {
                args.push('--output-format', 'json');
                args.push('--json-schema', JSON.stringify(opts.jsonSchema));
            }
            else {
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
            proc.stdout.on('data', (d) => { output += d.toString(); });
            proc.stderr.on('data', (d) => { errOutput += d.toString(); });
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
        if (!running)
            processNext();
    });
}
