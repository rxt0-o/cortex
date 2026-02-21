import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

export interface CortexEvent {
  type: 'file_access' | 'session_end';
  file?: string;
  tool?: string;
  session_id: string;
  transcript_path?: string;
  ts: string;
  processed?: boolean;
}

export class EventQueue {
  private queuePath: string;
  private lastSize = 0;

  constructor(projectPath: string) {
    this.queuePath = join(projectPath, '.claude', 'cortex-events.jsonl');
  }

  read(): CortexEvent[] {
    if (!existsSync(this.queuePath)) return [];
    try {
      const content = readFileSync(this.queuePath, 'utf-8');
      if (content.length === this.lastSize) return [];
      this.lastSize = content.length;
      return content
        .split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l) as CortexEvent; } catch { return null; } })
        .filter((e): e is CortexEvent => e !== null && !e.processed);
    } catch { return []; }
  }

  markProcessed(events: CortexEvent[]): void {
    if (!existsSync(this.queuePath)) return;
    try {
      const processedTs = new Set(events.map(e => e.ts));
      const updated = readFileSync(this.queuePath, 'utf-8')
        .split('\n')
        .filter(l => l.trim())
        .map(line => {
          try {
            const e = JSON.parse(line) as CortexEvent;
            return processedTs.has(e.ts) ? JSON.stringify({ ...e, processed: true }) : line;
          } catch { return line; }
        })
        .join('\n');
      writeFileSync(this.queuePath, updated, 'utf-8');
    } catch { /* nicht kritisch */ }
  }

  clear(): void {
    if (existsSync(this.queuePath)) {
      writeFileSync(this.queuePath, '', 'utf-8');
      this.lastSize = 0;
    }
  }
}

export function appendEvent(projectPath: string, event: Omit<CortexEvent, 'processed'>): void {
  const p = join(projectPath, '.claude', 'cortex-events.jsonl');
  try { appendFileSync(p, JSON.stringify(event) + '\n', 'utf-8'); } catch { /* nicht kritisch */ }
}
