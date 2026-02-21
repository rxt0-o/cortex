---
name: cortex:cortex-deps
description: Show dependency tree and impact analysis for a file
user_invocable: true
argument: file_path
---

# Cortex Dependencies

Show what a file imports, what imports it, and full impact analysis.

## Instructions

1. Use MCP tool `cortex_get_deps` with the file path
2. Present three sections:
   - **Imports**: What this file depends on
   - **Importers**: What files use this file
   - **Impact Tree**: Full recursive list of files affected by changes
3. Highlight critical paths and high-impact files
4. If no data available, suggest running `/cortex-update-map`

## Usage

```
/cortex-deps frontend/src/services/buildService.ts
/cortex-deps backend/app/api/routes/tierlist.py
```
