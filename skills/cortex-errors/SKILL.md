---
name: cortex:cortex-errors
description: Show known errors with fixes and prevention rules
user_invocable: true
argument: file_or_severity
---

# Cortex Errors

Show known errors from the project's error memory.

## Instructions

1. Parse argument: if it looks like a file path, filter by file. Otherwise treat as severity filter.
2. Use MCP tool `cortex_list_errors` with parsed parameters
3. Present each error with:
   - Error message and signature
   - Occurrence count and last seen
   - Root cause (if known)
   - Fix description and diff
   - Prevention rule (if set)
   - Severity indicator

## Usage

```
/cortex-errors                                    — All known errors
/cortex-errors high                               — Only high/critical severity
/cortex-errors frontend/src/services/teamService  — Errors in specific file
```
