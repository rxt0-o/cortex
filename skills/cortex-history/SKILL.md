---
name: cortex-history
description: Show complete history for a file — sessions, diffs, errors
user_invocable: true
argument: file_path
---

# Cortex File History

Show the complete timeline of a file: when it was changed, why, and what went wrong.

## Instructions

1. Use MCP tool `cortex_get_file_history` with the file path
2. Present a chronological timeline:
   - Each change with session context
   - Diffs (summarized)
   - Errors that occurred in this file
   - Decisions that affected this file
3. Show change frequency (hot zone indicator)

## Usage

```
/cortex-history frontend/src/services/teamService.ts
/cortex-history backend/app/api/routes/sitemap.py
```
