import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
export class EventQueue {
    queuePath;
    lastSize = 0;
    constructor(projectPath) {
        this.queuePath = join(projectPath, '.claude', 'cortex-events.jsonl');
    }
    read() {
        if (!existsSync(this.queuePath))
            return [];
        try {
            const content = readFileSync(this.queuePath, 'utf-8');
            if (content.length === this.lastSize)
                return [];
            this.lastSize = content.length;
            return content
                .split('\n')
                .filter(l => l.trim())
                .map(l => { try {
                return JSON.parse(l);
            }
            catch {
                return null;
            } })
                .filter((e) => e !== null && !e.processed);
        }
        catch {
            return [];
        }
    }
    markProcessed(events) {
        if (!existsSync(this.queuePath))
            return;
        try {
            const processedTs = new Set(events.map(e => e.ts));
            const updated = readFileSync(this.queuePath, 'utf-8')
                .split('\n')
                .filter(l => l.trim())
                .map(line => {
                try {
                    const e = JSON.parse(line);
                    return processedTs.has(e.ts) ? JSON.stringify({ ...e, processed: true }) : line;
                }
                catch {
                    return line;
                }
            })
                .join('\n');
            writeFileSync(this.queuePath, updated, 'utf-8');
        }
        catch { /* nicht kritisch */ }
    }
    clear() {
        if (existsSync(this.queuePath)) {
            writeFileSync(this.queuePath, '', 'utf-8');
            this.lastSize = 0;
        }
    }
}
export function appendEvent(projectPath, event) {
    const p = join(projectPath, '.claude', 'cortex-events.jsonl');
    try {
        appendFileSync(p, JSON.stringify(event) + '\n', 'utf-8');
    }
    catch { /* nicht kritisch */ }
}
