import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import * as conventions from '../modules/conventions.js';
export function registerProfileTools(server: McpServer): void {

  server.tool(
    'cortex_update_profile',
    'Update user profile (name, role, working style, expertise, communication preference)',
    {
      name: z.string().optional(),
      role: z.string().optional(),
      working_style: z.string().optional(),
      expertise_areas: z.string().optional(),
      communication_preference: z.string().optional(),
    },
    async (input) => {
      const db = getDb();
      // Upsert with id=1
      db.prepare(`INSERT INTO user_profile (id, name, role, working_style, expertise_areas, communication_preference, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          name=COALESCE(excluded.name, name),
          role=COALESCE(excluded.role, role),
          working_style=COALESCE(excluded.working_style, working_style),
          expertise_areas=COALESCE(excluded.expertise_areas, expertise_areas),
          communication_preference=COALESCE(excluded.communication_preference, communication_preference),
          updated_at=datetime('now')`
      ).run(input.name ?? null, input.role ?? null, input.working_style ?? null, input.expertise_areas ?? null, input.communication_preference ?? null);
      return { content: [{ type: 'text' as const, text: 'Profile updated.' }] };
    }
  );

  server.tool(
    'cortex_get_profile',
    'Get the user profile',
    {},
    async () => {
      const db = getDb();
      try {
        const profile = db.prepare(`SELECT * FROM user_profile WHERE id=1`).get() as any;
        if (!profile) return { content: [{ type: 'text' as const, text: 'No profile set. Use cortex_update_profile to create one.' }] };
        const lines = [
          `Name: ${profile.name ?? '(not set)'}`,
          `Role: ${profile.role ?? '(not set)'}`,
          `Working Style: ${profile.working_style ?? '(not set)'}`,
          `Expertise: ${profile.expertise_areas ?? '(not set)'}`,
          `Communication: ${profile.communication_preference ?? '(not set)'}`,
          `Updated: ${profile.updated_at?.slice(0,10) ?? 'never'}`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
      }
    }
  );

  server.tool(
    'cortex_onboard',
    'Run first-time onboarding: set up user profile and attention anchors',
    {
      name: z.string().describe('Your name'),
      role: z.string().describe('Your role (e.g. solo developer, lead engineer)'),
      working_style: z.string().describe('How you prefer to work (e.g. test-driven, prototype-first)'),
      expertise_areas: z.string().describe('Your main areas of expertise (comma-separated)'),
      anchors: z.array(z.string()).describe('3-5 topics you always want Cortex to track').optional(),
    },
    async ({ name, role, working_style, expertise_areas, anchors }) => {
      const db = getDb();
      const ts = new Date().toISOString();
  
      // Upsert profile
      db.prepare(`INSERT INTO user_profile (id, name, role, working_style, expertise_areas, updated_at)
        VALUES (1, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,
          working_style=excluded.working_style, expertise_areas=excluded.expertise_areas,
          updated_at=datetime('now')`
      ).run(name, role, working_style, expertise_areas);
  
      // Add anchors
      const addedAnchors: string[] = [];
      if (anchors && anchors.length > 0) {
        for (const topic of anchors.slice(0, 5)) {
          try {
            db.prepare(`INSERT INTO attention_anchors (topic, priority) VALUES (?, 8)`).run(topic);
            addedAnchors.push(topic);
          } catch { /* already exists */ }
        }
      }
  
      // Mark onboarding complete in meta
      db.prepare(`INSERT INTO meta (key, value) VALUES ('onboarding_complete', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(ts);
  
      const lines = [
        `Welcome, ${name}! Cortex is now configured.`,
        `Role: ${role}`,
        `Working style: ${working_style}`,
        `Expertise: ${expertise_areas}`,
        addedAnchors.length > 0 ? `Anchors: ${addedAnchors.join(', ')}` : '',
        '',
        'Cortex will now track your sessions, decisions, errors, and learnings.',
        'Use /resume to get a re-entry brief at any time.',
      ].filter(l => l !== '');
  
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cortex_export',
    'Export brain data as JSON or Markdown',
    { format: z.enum(['json', 'markdown']).optional().default('markdown') },
    async ({ format }) => {
      const db = getDb();
      try {
        const data = {
          exported_at: new Date().toISOString(),
          profile: db.prepare(`SELECT * FROM user_profile WHERE id=1`).get() ?? {},
          sessions: db.prepare(`SELECT id, started_at, summary, tags, emotional_tone, mood_score FROM sessions WHERE status='completed' ORDER BY started_at DESC LIMIT 50`).all(),
          decisions: db.prepare(`SELECT title, category, reasoning, created_at FROM decisions WHERE archived!=1 ORDER BY created_at DESC LIMIT 30`).all(),
          learnings: db.prepare(`SELECT anti_pattern, correct_pattern, severity, occurrences FROM learnings WHERE archived!=1 ORDER BY occurrences DESC LIMIT 50`).all(),
          errors: db.prepare(`SELECT error_message, fix_description, severity FROM errors WHERE archived!=1 ORDER BY occurrences DESC LIMIT 30`).all(),
          unfinished: db.prepare(`SELECT description, priority, created_at FROM unfinished WHERE resolved_at IS NULL ORDER BY created_at DESC`).all(),
          notes: ((): any[] => { try { return db.prepare(`SELECT text, tags, created_at FROM notes ORDER BY created_at DESC LIMIT 30`).all() as any[]; } catch { return []; } })(),
        };
  
        if (format === 'json') {
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        }
  
        // Markdown format
        const md: string[] = [`# Brain Export — ${data.exported_at.slice(0,10)}`, ''];
        md.push(`## Profile`);
        const p = data.profile as any;
        if (p?.name) md.push(`**${p.name}** · ${p.role ?? ''} · ${p.working_style ?? ''}`);
        md.push('');
        md.push(`## Open Items (${(data.unfinished as any[]).length})`);
        for (const u of data.unfinished as any[]) md.push(`- [${u.priority}] ${u.description}`);
        md.push('');
        md.push(`## Key Learnings (${(data.learnings as any[]).length})`);
        for (const l of data.learnings as any[]) md.push(`- **${l.anti_pattern}** → ${l.correct_pattern} (${l.occurrences}x)`);
        md.push('');
        md.push(`## Recent Sessions (${(data.sessions as any[]).length})`);
        for (const s of data.sessions as any[]) md.push(`- [${s.started_at?.slice(0,10)}] ${s.summary ?? ''}`);
  
        return { content: [{ type: 'text' as const, text: md.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Export error: ${e}` }] };
      }
    }
  );

  server.tool('cortex_add_note', 'Add scratch pad note', {
    text: z.string(),
    tags: z.array(z.string()).optional(),
    session_id: z.string().optional(),
    entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional().describe('Link this note to an entity. Example: "decision"'),
    entity_id: z.number().optional().describe('ID of the linked entity. Example: 42'),
  }, async ({ text, tags, session_id, entity_type, entity_id }) => {
    const r = getDb().prepare(`INSERT INTO notes (text,tags,session_id,entity_type,entity_id) VALUES (?,?,?,?,?)`).run(
      text,
      tags ? JSON.stringify(tags) : null,
      session_id ?? null,
      entity_type ?? null,
      entity_id ?? null,
    );
    return { content: [{ type: 'text' as const, text: `Note saved (id: ${r.lastInsertRowid})` }] };
  });

  server.tool('cortex_list_notes', 'List notes, optionally filtered by search term', {
    limit: z.number().optional().default(20),
    search: z.string().optional(),
    entity_type: z.enum(['decision', 'error', 'learning', 'note', 'unfinished', 'session']).optional().describe('Filter by linked entity type'),
    entity_id: z.number().optional().describe('Filter by linked entity ID'),
  }, async ({ limit, search, entity_type, entity_id }) => {
    const db = getDb();
    if (entity_id && !entity_type) {
      return { content: [{ type: 'text' as const, text: 'Error: entity_id requires entity_type' }] };
    }
    let notes: any[];
    if (entity_type && entity_id && search) {
      notes = db.prepare(`SELECT * FROM notes WHERE entity_type=? AND entity_id=? AND text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(entity_type, entity_id, `%${search}%`, limit) as any[];
    } else if (entity_type && entity_id) {
      notes = db.prepare(`SELECT * FROM notes WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT ?`).all(entity_type, entity_id, limit) as any[];
    } else if (search) {
      notes = db.prepare(`SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${search}%`, limit) as any[];
    } else {
      notes = db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
    }
    return { content: [{ type: 'text' as const, text: (notes as any[]).map(n => {
      const link = n.entity_type ? ` [${n.entity_type}:${n.entity_id}]` : '';
      return `[${n.id}] ${n.created_at.slice(0,10)}${link}: ${n.text}`;
    }).join('\n') || 'No notes.' }] };
  });

  server.tool('cortex_delete_note', 'Delete note by id', {
    id: z.number(),
  }, async ({ id }) => {
    getDb().prepare(`DELETE FROM notes WHERE id=?`).run(id);
    return { content: [{ type: 'text' as const, text: `Deleted note ${id}` }] };
  });

  server.tool(
    'cortex_add_anchor',
    'Add an attention anchor — a topic that always gets priority context',
    { topic: z.string(), priority: z.number().optional().default(5) },
    async ({ topic, priority }) => {
      const db = getDb();
      try {
        db.prepare(`INSERT INTO attention_anchors (topic, priority) VALUES (?, ?)`).run(topic, priority);
        return { content: [{ type: 'text' as const, text: `Anchor added: "${topic}" (priority ${priority})` }] };
      } catch {
        return { content: [{ type: 'text' as const, text: `Anchor "${topic}" already exists or could not be added.` }] };
      }
    }
  );

  server.tool(
    'cortex_remove_anchor',
    'Remove an attention anchor by topic',
    { topic: z.string() },
    async ({ topic }) => {
      const db = getDb();
      const r = db.prepare(`DELETE FROM attention_anchors WHERE topic LIKE ?`).run(`%${topic}%`);
      return { content: [{ type: 'text' as const, text: `Removed ${r.changes} anchor(s) matching "${topic}".` }] };
    }
  );

  server.tool(
    'cortex_list_anchors',
    'List all attention anchors',
    {},
    async () => {
      const db = getDb();
      try {
        const anchors = db.prepare(`SELECT id, topic, priority, last_touched FROM attention_anchors ORDER BY priority DESC, created_at ASC`).all() as any[];
        if (anchors.length === 0) return { content: [{ type: 'text' as const, text: 'No attention anchors set.' }] };
        const lines = anchors.map(a => `[${a.id}] ${a.topic} (priority ${a.priority}, last touched: ${a.last_touched?.slice(0,10) ?? 'never'})`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
      }
    }
  );

  server.tool(
    'cortex_set_project',
    'Set the active project name for context tagging',
    { project: z.string() },
    async ({ project }) => {
      const db = getDb();
      db.prepare(`INSERT INTO meta (key, value) VALUES ('active_project', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(project);
      return { content: [{ type: 'text' as const, text: `Active project set to: "${project}"` }] };
    }
  );

  server.tool(
    'cortex_get_conventions',
    'List active conventions with violation counts',
    {
      scope: z.string().optional(),
    },
    async ({ scope }) => {
      getDb();
      const convs = conventions.listConventions(scope);
      return { content: [{ type: 'text' as const, text: JSON.stringify(convs, null, 2) }] };
    }
  );

  server.tool(
    'cortex_add_convention',
    'Add or update a coding convention with detection/violation patterns',
    {
      name: z.string().describe('Short convention name. Example: "No raw SQL in route handlers" or "Always use prepared statements"'),
      description: z.string().describe('What the convention requires. Example: "All DB queries must go through module functions in server/src/modules/, never inline SQL in index.ts"'),
      detection_pattern: z.string().optional().describe('Regex to detect correct usage. Example: "import.*modules/"'),
      violation_pattern: z.string().optional().describe('Regex to detect violations. Example: "db\\.prepare\\(.*SELECT.*\\).*index\\.ts"'),
      examples_good: z.array(z.string()).optional().describe('Examples of correct code. Example: ["sessions.createSession({ id })", "decisions.addDecision(input)"]'),
      examples_bad: z.array(z.string()).optional().describe('Examples of incorrect code. Example: ["db.prepare(\'SELECT * FROM sessions\').all()"]'),
      scope: z.enum(['global', 'frontend', 'backend', 'database']).optional(),
      source: z.string().optional().describe('Where this convention comes from. Example: "CLAUDE.md" or "code review 2026-02-22"'),
    },
    async (input) => {
      getDb();
      const conv = conventions.addConvention(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(conv, null, 2) }] };
    }
  );

}
