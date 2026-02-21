---
name: pin
description: Pin a rule as permanent high-severity auto-blocking learning
---
Extract the rule from user message.
Call cortex_add_learning with:
- anti_pattern: negative form of rule
- correct_pattern: correct alternative or Avoid: [rule]
- context: Pinned by user
- severity: high
Confirm: Pinned permanently. Will block future violations.
