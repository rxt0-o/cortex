---
name: resume
description: Get re-entry brief — what was I working on?
---
Run IN PARALLEL:
1. cortex_list_sessions limit=3
2. cortex_get_unfinished
3. cortex_get_hot_zones limit=5

If last session shows "No significant activity" (häufig bei Read/Plan-Sessions):
- Rufe `git status` auf und zeige unstaged changes
- Zeige letzten Commit und "Was könnte als nächstes geplant sein?"

Present brief:
LAST SESSION: [summary] ([X days ago])
OPEN ITEMS: [list]
RECENTLY CHANGED: [files]
Continue where you left off?
