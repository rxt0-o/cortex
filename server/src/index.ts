import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb, closeDb } from "./db.js";
import { registerCoreTools } from "./tools/core.js";
import { registerProjectMapTools } from "./tools/project-map.js";

const CORTEX_INSTRUCTIONS = `Cortex - persistent memory via MCP for coding agents.

TOOLS:
- cortex_store(type, ...fields)   â€” save decision/error/learning/todo/intent/note
- cortex_search(query)            â€” search all memory (FTS5)
- cortex_context(files?)          â€” session context + file-specific info
- cortex_list(type, filter?)      â€” list decisions/errors/learnings/todos/notes
- cortex_resolve(type, id)        â€” close todo / mark decision reviewed / update error
- cortex_snooze(description, until) â€” set future reminder
- cortex_reindex_embeddings(...)  â€” build semantic vector index for existing memory

WHEN TO USE:
- Architecture decision made â†’ cortex_store(type:"decision", ...)
- Bug fixed â†’ cortex_store(type:"error", ...) with prevention_rule
- Anti-pattern found â†’ cortex_store(type:"learning", ...) with auto_block:true
- Something to do later â†’ cortex_store(type:"todo", ...)
- Need context â†’ cortex_context() or cortex_search(query)
- Want semantic search on old data â†’ cortex_reindex_embeddings() once`;

const server = new McpServer(
  { name: "project-cortex", version: "0.7.0" },
  { instructions: CORTEX_INSTRUCTIONS },
);

registerCoreTools(server);
registerProjectMapTools(server);

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

