---
name: cortex:cortex-decisions
description: Show architectural decisions with reasoning
user_invocable: true
argument: category_or_count
---

# Cortex Decisions

Show recent architectural and design decisions with full reasoning.

## Instructions

1. Parse the argument: if numeric, use as limit. If text, use as category filter.
2. Use MCP tool `cortex_list_decisions` with parsed parameters
3. Present decisions in chronological order with:
   - Title and category
   - Reasoning (WHY it was decided)
   - Alternatives considered and why they were rejected
   - Files affected
4. Mark superseded decisions clearly

## Categories

architecture, convention, bugfix, feature, config, security

## Usage

```
/cortex-decisions              — Last 10 decisions
/cortex-decisions 20           — Last 20 decisions
/cortex-decisions architecture — Only architecture decisions
```
