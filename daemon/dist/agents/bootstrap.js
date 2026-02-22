import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { existsSync } from 'fs';
import { runClaudeAgent } from '../runner.js';
export async function runBootstrapAgent(projectPath) {
    const dbPath = join(projectPath, '.claude', 'cortex.db');
    if (!existsSync(dbPath))
        return;
    const db = new DatabaseSync(dbPath);
    try {
        const flag = db.prepare(`SELECT value FROM meta WHERE key='needs_bootstrap'`).get();
        if (!flag || flag.value !== 'true')
            return;
        process.stdout.write('[cortex-daemon] Bootstrap: DB quasi leer, starte Erstindexierung...\n');
    }
    finally {
        db.close();
    }
    const prompt = `Du bist ein Setup-Agent fuer Cortex. Fuehre diese 3 MCP-Tools nacheinander aus:

1. cortex_import_git_history mit max_commits: 200
2. cortex_scan_project
3. cortex_index_docs

Fuehre alle 3 aus und berichte kurz was importiert wurde. Keine weiteren Aktionen.`;
    const result = await runClaudeAgent({
        prompt,
        projectPath,
        timeoutMs: 120_000,
        agentName: 'bootstrap',
    });
    if (result.success) {
        const db2 = new DatabaseSync(dbPath);
        try {
            db2.prepare(`UPDATE meta SET value='done' WHERE key='needs_bootstrap'`).run();
            process.stdout.write('[cortex-daemon] Bootstrap: Erfolgreich abgeschlossen\n');
        }
        finally {
            db2.close();
        }
    }
    else {
        process.stderr.write(`[cortex-daemon] Bootstrap: Fehlgeschlagen — ${result.error?.slice(0, 200) ?? 'unknown'}\n`);
    }
}
