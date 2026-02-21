---
name: cortex:cortex-search
description: Search across all Cortex data — sessions, decisions, errors, learnings
user_invocable: true
argument: query
---

# Cortex Search

Search across all Project Cortex data using full-text search.

## Instructions

1. Use the MCP tool `cortex_search` with the user's query
2. Present results grouped by type (sessions, decisions, errors, learnings)
3. Show the most relevant results first
4. Include context: when it happened, which files were involved
5. If no results found, suggest alternative search terms

## Usage

```
/cortex-search <query>
```

## Examples

- `/cortex-search authentication` — Find all data related to authentication
- `/cortex-search teamService bug` — Find errors/fixes related to teamService
- `/cortex-search migration` — Find decisions about database migrations
