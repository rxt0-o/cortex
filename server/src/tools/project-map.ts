import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as projectMap from '../modules/project-map.js';
import * as deps from '../modules/dependencies.js';
import * as diffs from '../modules/diffs.js';
import * as errors from '../modules/errors.js';
import * as decisions from '../modules/decisions.js';
import * as learnings from '../modules/learnings.js';

export function registerProjectMapTools(server: McpServer): void {

  server.tool(
    'cortex_get_deps',
    'Get dependency tree and impact analysis for a file',
    {
      file_path: z.string(),
    },
    async ({ file_path }) => {
      getDb();
      const imports = deps.getImports(file_path);
      const importers = deps.getImporters(file_path);
      const impact = deps.getImpactTree(file_path);
  
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ imports, importers, impactedFiles: impact }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'cortex_get_map',
    'Get project architecture map — modules, layers, files',
    {
      module: z.string().optional(),
    },
    async ({ module }) => {
      getDb();
      if (module) {
        const mod = projectMap.getModuleByPath(module);
        return { content: [{ type: 'text' as const, text: JSON.stringify(mod, null, 2) }] };
      }
      const summary = projectMap.getModuleSummary();
      return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    'cortex_update_map',
    'Re-scan the project and update the architecture map',
    { root_path: z.string().optional() },
    async ({ root_path }) => {
      getDb();
      const result = projectMap.scanProject(root_path ?? process.cwd());
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    }
  );

  server.tool(
    'cortex_scan_project',
    'Scan project filesystem and populate architecture map with all files, modules and dependencies',
    { root_path: z.string().optional() },
    async ({ root_path }) => {
      getDb();
      const result = projectMap.scanProject(root_path ?? process.cwd());
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    }
  );

  server.tool(
    'cortex_index_docs',
    'Read CLAUDE.md and docs/ markdown files and store as searchable learnings and decisions',
    { docs_path: z.string().optional() },
    async ({ docs_path }) => {
      getDb();
      const { readFileSync, readdirSync, existsSync } = await import('fs');
      const { join } = await import('path');
  
      const root = docs_path ?? process.cwd();
      const stats = { gotchas: 0, decisions: 0, docs_indexed: 0 };
  
      // CLAUDE.md Gotchas parsen: - **#NNN ...** — Beschreibung
      const claudeMdPath = join(root, 'CLAUDE.md');
      if (existsSync(claudeMdPath)) {
        const content = readFileSync(claudeMdPath, 'utf-8');
        const gotchaRe = /- \*\*#(\d+)[^*]*\*\*\s*[—-]\s*([^\n]+)/g;
        let m;
        while ((m = gotchaRe.exec(content))) {
          const num = m[1];
          const title = m[2].trim();
          try {
            learnings.addLearning({
              anti_pattern: `Gotcha #${num}: ${title}`,
              correct_pattern: title,
              context: `CLAUDE.md Gotcha #${num}`,
              severity: 'medium',
              auto_block: false,
            });
            stats.gotchas++;
          } catch { /* Duplikat — ignorieren */ }
        }
        stats.docs_indexed++;
      }
  
      // docs/*.md H2-Sections als Decisions
      const docsDir = join(root, 'docs');
      if (existsSync(docsDir)) {
        const mdFiles = readdirSync(docsDir).filter((f: string) => f.endsWith('.md'));
        for (const file of mdFiles) {
          try {
            const content = readFileSync(join(docsDir, file), 'utf-8');
            const sectionRe = /^## (.+)\n([\s\S]*?)(?=\n## |$)/gm;
            let sm;
            while ((sm = sectionRe.exec(content))) {
              const title = sm[1].trim();
              const body = sm[2].trim();
              if (body.length < 30) continue;
              try {
                decisions.addDecision({
                  title: `[${file}] ${title}`,
                  reasoning: body.slice(0, 1000),
                  category: 'architecture',
                  confidence: 'high',
                });
                stats.decisions++;
              } catch { /* Duplikat */ }
            }
            stats.docs_indexed++;
          } catch { /* nicht lesbar */ }
        }
      }
  
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...stats }, null, 2) }] };
    }
  );

  server.tool(
    'cortex_get_hot_zones',
    'Get most frequently changed files — refactoring candidates',
    {
      limit: z.number().optional(),
    },
    async ({ limit }) => {
      getDb();
      const zones = projectMap.getHotZones(limit ?? 20);
      return { content: [{ type: 'text' as const, text: JSON.stringify(zones, null, 2) }] };
    }
  );

  server.tool(
    'cortex_get_file_history',
    'Get complete history for a file: sessions, diffs, errors',
    {
      file_path: z.string(),
    },
    async ({ file_path }) => {
      getDb();
      const fileDiffs = diffs.getDiffsForFile(file_path);
      const fileErrors = errors.listErrors({ file: file_path });
      const fileDecisions = decisions.getDecisionsForFile(file_path);
      const fileInfo = projectMap.getFileByPath(file_path);
  
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ file: fileInfo, diffs: fileDiffs, errors: fileErrors, decisions: fileDecisions }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'cortex_import_git_history',
    'Import git log history to populate Hot Zones with historical file change frequency',
    {
      root_path: z.string().optional(),
      max_commits: z.number().optional(),
    },
    async ({ root_path, max_commits }) => {
      const { execFileSync } = await import('child_process');
      const cwd = root_path ?? process.cwd();
      const limit = max_commits ?? 500;
  
      let gitOutput: string;
      try {
        gitOutput = execFileSync(
          'git', ['log', `--max-count=${limit}`, '--name-only', '--pretty=format:'],
          { cwd, encoding: 'utf-8' }
        );
      } catch (e) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'git log failed', detail: String(e) }) }] };
      }
  
      const db = getDb();
      const fileCounts = new Map<string, number>();
      for (const line of gitOutput.split('\n')) {
        const normalized = line.trim().replace(/\\/g, '/');
        if (!normalized) continue;
        if (!/\.(ts|tsx|js|jsx|py|sql|json|md)$/.test(normalized)) continue;
        fileCounts.set(normalized, (fileCounts.get(normalized) ?? 0) + 1);
      }
  
      const stmt = db.prepare(`
        INSERT INTO project_files (path, change_count, last_changed)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(path) DO UPDATE SET
          change_count = MAX(project_files.change_count, excluded.change_count)
      `);
      let imported = 0;
      for (const [path, count] of fileCounts) { stmt.run(path, count); imported++; }
  
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, files_imported: imported, commits_analyzed: limit }, null, 2) }],
      };
    }
  );

}
