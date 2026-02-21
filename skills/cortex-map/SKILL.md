---
name: cortex-map
description: Show project architecture map — modules, layers, files
user_invocable: true
argument: module
---

# Cortex Map

Display the living architecture map of the project.

## Instructions

1. If no argument: use `cortex_get_map` without module parameter for overview
2. If argument given: use `cortex_get_map` with module path for detail view
3. Present as a structured overview:
   - Group by layer (frontend-ui, frontend-logic, backend, database, config)
   - Show module names, file counts, entry points
   - Highlight recently changed modules
4. For detail view: show all files in the module with types and descriptions

## Usage

```
/cortex-map                           — Full architecture overview
/cortex-map frontend/src/services     — Detail view of service layer
/cortex-map backend/app               — Detail view of backend
```
