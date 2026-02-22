---
name: recap
description: "Weekly recap: sessions, decisions, errors, trends. Sprint-review style summary of the past 7 days."
---
Run these calls IN PARALLEL:
1. cortex_list_sessions limit=10
2. cortex_list_decisions limit=10
3. cortex_list_errors limit=5
4. cortex_get_health
5. cortex_get_hot_zones limit=5

Present as a structured weekly recap:

## Week Recap

**Period:** [date range based on sessions]

### Sessions ([count])
- List each session with date + 1-line summary

### Decisions ([count])
- List decisions made this week with category tag

### Errors ([count fixed] / [count open])
- Fixed errors with fix summary
- Open errors flagged

### Hot Files
- Top 5 most-changed files

### Health Trend
- Current score + trend arrow

### Highlights
- 2-3 bullet points: biggest achievements, patterns, risks

Keep it concise. No filler. Sprint-review style.
