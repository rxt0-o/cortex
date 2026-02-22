---
name: pin
description: Pin a rule as permanent high-severity auto-blocking learning
---
Extract the rule from the user message.

Step 1 — DB Learning:
Call cortex_add_learning with:
- anti_pattern: negative form of rule
- correct_pattern: correct alternative or "Avoid: [rule]"
- context: Pinned by user
- severity: high
- auto_block: true
- detection_regex: derive a regex if possible, else null

Step 2 — Hookify File:
Append to `.claude/cortex-pins.local.md` (create if not exists) a new block:

```yaml
---
name: pin-[slugified-rule-name]
enabled: true
event: all
action: block
pattern: [detection_regex or key term from rule]
---

🚫 **Pinned Rule Violation**
Rule: [anti_pattern]
Correct: [correct_pattern]
```

Step 3 — Confirm:
Reply: "Pinned permanently in DB + hookify file. Auto-blocks future violations."
