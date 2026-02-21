---
name: cortex:cortex-conventions
description: Show active coding conventions with violation counts
user_invocable: true
argument: scope
---

# Cortex Conventions

Show active coding conventions and their compliance status.

## Instructions

1. Use MCP tool `cortex_get_conventions` with optional scope filter
2. Present conventions sorted by violation count (most violated first)
3. Show for each:
   - Name and description
   - Scope (global/frontend/backend/database)
   - Violation count and last violated
   - Good/bad examples
   - Detection pattern (if available)
4. Highlight conventions with recent violations

## Usage

```
/cortex-conventions              — All conventions
/cortex-conventions frontend     — Frontend-only conventions
/cortex-conventions backend      — Backend-only conventions
```
