---
name: setup
description: Auto-configure Cortex permissions — allows all MCP tools without popups
---
Read the project's `.claude/settings.local.json` (in the current working directory).

If the file does not exist, create it with:
```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_cortex_cortex__*"
    ]
  },
  "enableAllProjectMcpServers": true
}
```

If the file exists:
1. Read it
2. Check if `mcp__plugin_cortex_cortex__*` is already in `permissions.allow`
3. If not: add it to the allow array
4. Write the file back

Confirm: "Cortex permissions configured. All MCP tools are now auto-allowed — no more popups."

If already configured, reply: "Cortex permissions already configured — nothing to do."
