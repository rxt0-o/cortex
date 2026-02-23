import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb, closeDb } from "./db.js";
import { registerCoreTools } from "./tools/core.js";

const CORTEX_INSTRUCTIONS = `Cortex — persistent memory for Claude Code.

TOOLS:
- cortex_store(type, ...fields)   — save decision/error/learning/todo/intent/note
- cortex_search(query)            — search all memory (FTS5)
- cortex_context(files?)          — session context + file-specific info
- cortex_list(type, filter?)      — list decisions/errors/learnings/todos/notes
- cortex_resolve(type, id)        — close todo / mark decision reviewed / update error
- cortex_snooze(description, until) — set future reminder

WHEN TO USE:
- Architecture decision made → cortex_store(type:"decision", ...)
- Bug fixed → cortex_store(type:"error", ...) with prevention_rule
- Anti-pattern found → cortex_store(type:"learning", ...) with auto_block:true
- Something to do later → cortex_store(type:"todo", ...)
- Need context → cortex_context() or cortex_search(query)`;

const server = new McpServer(
  { name: "project-cortex", version: "0.7.0" },
  { instructions: CORTEX_INSTRUCTIONS },
);

registerCoreTools(server);

async function main() {
  getDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("SIGINT", () => { closeDb(); process.exit(0); });
  process.on("SIGTERM", () => { closeDb(); process.exit(0); });
}

main().catch((err) => {
  console.error("Cortex MCP Server failed to start:", err);
  process.exit(1);
});
