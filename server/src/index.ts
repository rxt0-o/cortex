import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb, closeDb } from './db.js';

import { registerSessionTools } from './tools/sessions.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerErrorTools } from './tools/errors.js';
import { registerLearningTools } from './tools/learnings.js';
import { registerProjectMapTools } from './tools/project-map.js';
import { registerTrackingTools } from './tools/tracking.js';
import { registerIntelligenceTools } from './tools/intelligence.js';
import { registerStatsTools } from './tools/stats.js';
import { registerProfileTools } from './tools/profile.js';
import { registerMetaTools } from './tools/meta.js';
import { registerActivityTools } from './tools/activity.js';

const CORTEX_INSTRUCTIONS = `Cortex is a persistent memory and intelligence system for Claude Code.

TOOL CATEGORIES (call cortex_load_tools to get detailed guidance):
- memory: snapshot, get_context, list_sessions, search
- decisions: add_decision, list_decisions, mark_decision_reviewed
- errors: add_error, add_learning, check_regression, list_errors, list_learnings
- map: scan_project, get_map, get_deps, get_hot_zones, file_history, blame
- tracking: add_unfinished, get_unfinished, resolve_unfinished, add_intent, snooze
- notes: add_note, list_notes, onboard, update_profile, get_profile
- intelligence: dejavu, check_blind_spots, get_mood, forget, cross_project_search
- stats: get_health, get_stats, get_access_stats, run_pruning, get_timeline

RULES: Always call cortex_check_regression before writing/editing files.
Use cortex_load_tools(['category']) to get detailed usage guidance for any category.`;

const server = new McpServer(
  { name: 'project-cortex', version: '0.1.0' },
  { instructions: CORTEX_INSTRUCTIONS },
);

registerSessionTools(server);
registerDecisionTools(server);
registerErrorTools(server);
registerLearningTools(server);
registerProjectMapTools(server);
registerTrackingTools(server);
registerIntelligenceTools(server);
registerStatsTools(server);
registerProfileTools(server);
registerMetaTools(server);
registerActivityTools(server);

async function main() {
  getDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGINT', () => { closeDb(); process.exit(0); });
  process.on('SIGTERM', () => { closeDb(); process.exit(0); });
}

main().catch((err) => {
  console.error('Cortex MCP Server failed to start:', err);
  process.exit(1);
});
