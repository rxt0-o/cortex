import { getDb } from '../db.js';
import { findSimilar } from './embeddings.js';

export interface Association {
  id: number;
  source_type: string;
  source_id: number;
  target_type: string;
  target_id: number;
  relation: string;
  strength: number;
  last_activated: string;
  created_at: string;
}

/**
 * Create an association between two memory items (INSERT OR IGNORE).
 */
export function createAssociation(params: {
  sourceType: string;
  sourceId: number;
  targetType: string;
  targetId: number;
  relation: string;
  strength?: number;
}): void {
  const db = getDb();
  const { sourceType, sourceId, targetType, targetId, relation, strength } = params;

  // Self-reference check is handled by CHECK constraint, but skip early
  if (sourceType === targetType && sourceId === targetId) return;

  try {
    db.prepare(`
      INSERT OR IGNORE INTO memory_associations
        (source_type, source_id, target_type, target_id, relation, strength)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sourceType, sourceId, targetType, targetId, relation, strength ?? 1.0);
  } catch {
    // UNIQUE constraint or CHECK constraint violation — safe to ignore.
  }
}

/**
 * Get all associations for a given entity (as source or target).
 */
export function getAssociations(entityType: string, entityId: number): Association[] {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT * FROM memory_associations
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
      ORDER BY strength DESC
    `).all(entityType, entityId, entityType, entityId) as unknown as Association[];
  } catch {
    return [];
  }
}

/**
 * Get outgoing associations from a specific entity.
 */
export function getOutgoing(entityType: string, entityId: number): Association[] {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT * FROM memory_associations
      WHERE source_type = ? AND source_id = ?
      ORDER BY strength DESC
    `).all(entityType, entityId) as unknown as Association[];
  } catch {
    return [];
  }
}

/**
 * Get all edges (both directions) for BFS traversal.
 */
export function getNeighbors(entityType: string, entityId: number): Array<{
  type: string;
  id: number;
  relation: string;
  strength: number;
}> {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT target_type as type, target_id as id, relation, strength
      FROM memory_associations
      WHERE source_type = ? AND source_id = ?
      UNION ALL
      SELECT source_type as type, source_id as id, relation, strength
      FROM memory_associations
      WHERE target_type = ? AND target_id = ?
    `).all(entityType, entityId, entityType, entityId) as unknown as Array<{
      type: string;
      id: number;
      relation: string;
      strength: number;
    }>;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Auto-create associations when a new item is stored via cortex_store.
 * Creates same-session and same-file associations.
 */
export function autoCreateAssociations(params: {
  entityType: string;
  entityId: number;
  sessionId?: string;
  files?: string[];
}): number {
  const db = getDb();
  const { entityType, entityId, sessionId, files } = params;
  let created = 0;

  // same-session: link to recent items from the same session
  if (sessionId) {
    const TABLE_MAP: Record<string, string> = {
      decision: 'decisions',
      error: 'errors',
      learning: 'learnings',
      note: 'notes',
      unfinished: 'unfinished',
    };

    for (const [type, table] of Object.entries(TABLE_MAP)) {
      if (type === entityType) continue; // Will handle intra-type separately
      try {
        const rows = db.prepare(`
          SELECT id FROM ${table}
          WHERE session_id = ? AND archived_at IS NULL
          ORDER BY id DESC LIMIT 5
        `).all(sessionId) as Array<{ id: number }>;

        for (const row of rows) {
          createAssociation({
            sourceType: entityType,
            sourceId: entityId,
            targetType: type,
            targetId: row.id,
            relation: 'same-session',
            strength: 0.6,
          });
          created++;
        }
      } catch {
        // Table might not have session_id or archived_at.
      }
    }

    // Intra-type same-session (e.g., error -> error in same session)
    const ownTable = TABLE_MAP[entityType];
    if (ownTable) {
      try {
        const rows = db.prepare(`
          SELECT id FROM ${ownTable}
          WHERE session_id = ? AND id != ? AND archived_at IS NULL
          ORDER BY id DESC LIMIT 3
        `).all(sessionId, entityId) as Array<{ id: number }>;

        for (const row of rows) {
          createAssociation({
            sourceType: entityType,
            sourceId: entityId,
            targetType: entityType,
            targetId: row.id,
            relation: 'same-session',
            strength: 0.5,
          });
          created++;
        }
      } catch { /* skip */ }
    }
  }

  // temporal: link to items created within 5 minutes of this item
  {
    const TABLE_MAP_TEMPORAL: Record<string, string> = {
      decision: 'decisions',
      error: 'errors',
      learning: 'learnings',
      note: 'notes',
      unfinished: 'unfinished',
    };
    const dateColMap: Record<string, string> = {
      decisions: 'created_at',
      errors: 'first_seen',
      learnings: 'created_at',
      notes: 'created_at',
      unfinished: 'created_at',
    };

    for (const [type, table] of Object.entries(TABLE_MAP_TEMPORAL)) {
      try {
        const dateCol = dateColMap[table];
        const idExclude = type === entityType ? entityId : -1;
        const rows = db.prepare(`
          SELECT id FROM ${table}
          WHERE archived_at IS NULL
            AND id != ?
            AND abs(strftime('%s', ${dateCol}) - strftime('%s', 'now')) < 300
          ORDER BY ${dateCol} DESC LIMIT 5
        `).all(idExclude) as Array<{ id: number }>;

        for (const row of rows) {
          if (type === entityType && row.id === entityId) continue;
          createAssociation({
            sourceType: entityType,
            sourceId: entityId,
            targetType: type,
            targetId: row.id,
            relation: 'temporal',
            strength: 1.0,
          });
          created++;
        }
      } catch { /* non-critical */ }
    }
  }

  // same-file: link to items that reference the same files
  if (files && files.length > 0) {
    for (const file of files.slice(0, 3)) {
      // Check errors with files_involved
      try {
        const rows = db.prepare(`
          SELECT id FROM errors
          WHERE files_involved LIKE ? AND archived_at IS NULL AND id != ?
          ORDER BY last_seen DESC LIMIT 3
        `).all(`%${file}%`, entityType === 'error' ? entityId : -1) as Array<{ id: number }>;

        for (const row of rows) {
          createAssociation({
            sourceType: entityType,
            sourceId: entityId,
            targetType: 'error',
            targetId: row.id,
            relation: 'same-file',
            strength: 0.7,
          });
          created++;
        }
      } catch { /* skip */ }

      // Check decisions with files_affected
      try {
        const rows = db.prepare(`
          SELECT id FROM decisions
          WHERE files_affected LIKE ? AND archived_at IS NULL AND id != ?
          ORDER BY created_at DESC LIMIT 3
        `).all(`%${file}%`, entityType === 'decision' ? entityId : -1) as Array<{ id: number }>;

        for (const row of rows) {
          createAssociation({
            sourceType: entityType,
            sourceId: entityId,
            targetType: 'decision',
            targetId: row.id,
            relation: 'same-file',
            strength: 0.7,
          });
          created++;
        }
      } catch { /* skip */ }
    }
  }

  return created;
}

/**
 * Auto-create semantic associations for a new item (async, fire-and-forget).
 * Links items with embedding cosine similarity >= 0.8.
 */
export async function autoCreateSemanticAssociations(params: {
  entityType: string;
  entityId: number;
  embeddingText: string;
}): Promise<number> {
  const { entityType, entityId, embeddingText } = params;
  if (!embeddingText || embeddingText.length < 10) return 0;

  let created = 0;
  try {
    const similar = await findSimilar(embeddingText, 10);
    for (const match of similar) {
      if (match.score < 0.8) continue;
      // Self-reference check
      if (match.entity_type === entityType && String(match.entity_id) === String(entityId)) continue;
      createAssociation({
        sourceType: entityType,
        sourceId: entityId,
        targetType: match.entity_type,
        targetId: Number(match.entity_id),
        relation: 'semantic',
        strength: match.score,
      });
      created++;
    }
  } catch { /* non-critical: embedding pipeline may not be available */ }
  return created;
}

/**
 * Get association count for monitoring.
 */
export function getAssociationCount(): number {
  const db = getDb();
  try {
    return (db.prepare('SELECT COUNT(*) as c FROM memory_associations').get() as { c: number }).c;
  } catch {
    return 0;
  }
}
