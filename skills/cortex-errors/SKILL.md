---
name: cortex-errors
description: Show known errors and prevention rules
---
Run IN PARALLEL:
1. cortex_list_errors limit=10
2. cortex_list_learnings limit=5

Present: known errors with fix descriptions, then auto-blocking patterns.
End with: "Use cortex_add_error to record a new bug fix."
