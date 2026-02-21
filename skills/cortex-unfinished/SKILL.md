---
name: cortex-unfinished
description: Show open/unresolved items — things started but not completed
user_invocable: true
---

# Cortex Unfinished

Show items that were deferred, left incomplete, or marked as "do later".

## Instructions

1. Use MCP tool `cortex_get_unfinished`
2. Present items grouped by priority (high → medium → low)
3. Show:
   - Description
   - Original context (what was being done when it was deferred)
   - When it was created
   - Which session it came from
4. Offer to mark items as resolved

## Usage

```
/cortex-unfinished
```
