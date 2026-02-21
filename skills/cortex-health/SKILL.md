---
name: cortex:cortex-health
description: Show project health score with metrics and trend
user_invocable: true
---

# Cortex Health

Display the current project health score with detailed metrics.

## Instructions

1. Use MCP tool `cortex_get_health`
2. Present:
   - Overall score (0-100) with trend arrow
   - Individual metrics breakdown
   - Recent trend (last 7 snapshots)
   - Actionable recommendations for improving the score
3. Use visual indicators for good/warning/bad ranges

## Metrics

- Open Errors (unfixed bugs)
- Unresolved Unfinished (open TODOs)
- Convention Violations
- Hot Zones (frequently changed files)
- Recent Bug Rate (last 7 days)
- Documentation Coverage

## Score Ranges

- 80-100: Healthy
- 60-79: Needs attention
- 40-59: Warning
- 0-39: Critical
