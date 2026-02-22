// server/src/modules/tool-registry.ts
export const TOOL_CATEGORIES = {
    memory: `## Memory & Context Tools

Use these at session start or when resuming work.

- **cortex_snapshot** → Full brain state: open items, recent sessions, decisions, learnings. Call this first in complex sessions.
- **cortex_get_context** → Relevant context for specific files. Pass file paths to get related decisions/errors/sessions.
- **cortex_list_sessions** → Recent work history with summaries.
- **cortex_search** → BM25/FTS5 full-text search across all stored data (sessions, decisions, errors, learnings).`,
    decisions: `## Decisions Tools

Use when making architectural or design choices.

- **cortex_add_decision** → Log WHY a decision was made. Required fields: title, reasoning, category (architecture/convention/bugfix/feature/config/security).
- **cortex_list_decisions** → Review existing decisions before making new ones. Check for duplicates.
- **cortex_mark_decision_reviewed** → Confirm a decision is still current (resets stale flag).`,
    errors: `## Errors & Learnings Tools

Use when bugs occur or anti-patterns are identified.

- **cortex_add_error** → Record a bug with root cause, fix description, and prevention rule.
- **cortex_update_error** → Add fix description or prevention rule to existing error.
- **cortex_list_errors** → List known errors, filter by severity or file.
- **cortex_add_learning** → Record an anti-pattern with correct alternative. Set detection_regex for auto-blocking.
- **cortex_update_learning** → Update existing learning (add regex, change severity, toggle auto_block).
- **cortex_delete_learning** → Remove a learning entry.
- **cortex_list_learnings** → Review known anti-patterns.
- **cortex_check_regression** → Check code against known anti-patterns BEFORE writing/editing. ALWAYS call this first.`,
    map: `## Project Map & Files Tools

Use when exploring or navigating the codebase.

- **cortex_scan_project** → Scan filesystem and populate architecture map. Run once to index project.
- **cortex_get_map** → Architecture overview: modules, layers, files.
- **cortex_update_map** → Re-scan and update map after structural changes.
- **cortex_get_deps** → Dependency tree and impact analysis for a specific file.
- **cortex_get_hot_zones** → Most frequently changed files — refactoring candidates.
- **cortex_get_file_history** → Full history for a file: sessions, diffs, errors.
- **cortex_blame** → Same as get_file_history with diff details.
- **cortex_import_git_history** → Import git log to populate hot zones.
- **cortex_index_docs** → Read CLAUDE.md and docs/ and store as searchable learnings.`,
    tracking: `## Tracking & TODOs Tools

Use when noting unfinished work or setting reminders.

- **cortex_add_unfinished** → Track something that needs to be done later. Fields: description, priority (low/medium/high), context.
- **cortex_get_unfinished** → List open/unresolved items.
- **cortex_resolve_unfinished** → Mark an unfinished item as done.
- **cortex_add_intent** → Store what you plan to do next session (shown at next SessionStart).
- **cortex_snooze** → Schedule a future session reminder. Use relative (3d/1w) or ISO date.`,
    notes: `## Notes & Profile Tools

- **cortex_add_note** → Save scratch pad note with optional tags.
- **cortex_list_notes** → List notes, filter by search term.
- **cortex_delete_note** → Delete note by id.
- **cortex_onboard** → First-time setup: name, role, working style, expertise, anchors.
- **cortex_update_profile** → Update user profile fields.
- **cortex_get_profile** → Get current user profile.
- **cortex_export** → Export brain data as JSON or Markdown.`,
    intelligence: `## Intelligence Tools

Advanced analysis and pattern detection.

- **cortex_dejavu** → Check if a task looks similar to past sessions (deja-vu detection). Pass task description.
- **cortex_check_blind_spots** → Find project files not touched in recent sessions.
- **cortex_get_mood** → Current system mood based on rolling average of last 7 sessions.
- **cortex_forget** → Archive decisions/errors/learnings matching a topic keyword.
- **cortex_cross_project_search** → Search across all projects in this Cortex DB.
- **cortex_add_anchor** → Add attention anchor — topic that always gets priority context.
- **cortex_remove_anchor** → Remove an attention anchor.
- **cortex_list_anchors** → List all attention anchors.`,
    stats: `## Health & Stats Tools

- **cortex_get_health** → Project health score with metrics and trend.
- **cortex_get_stats** → Overall counts: sessions, decisions, errors, files, learnings.
- **cortex_get_access_stats** → Top accessed decisions/learnings/errors.
- **cortex_run_pruning** → Manually run Ebbinghaus pruning — archives unused items.
- **cortex_get_timeline** → Monthly activity timeline.
- **cortex_compare_periods** → Compare activity between two date ranges.
- **cortex_suggest_claude_md** → Suggest CLAUDE.md updates based on new learnings.
- **cortex_set_project** → Set active project name for context tagging.
- **cortex_get_conventions** → List active coding conventions with violation counts.
- **cortex_add_convention** → Add or update a coding convention.`,
    activity: `## Activity Log Tools

Use to audit and track what happened across sessions.

- **cortex_activity_log** → List activity log entries. Filter by entity_type, entity_id, action, since date.
- **cortex_log_activity** → Manually log an activity entry after important operations.`,
};
export const VALID_CATEGORIES = Object.keys(TOOL_CATEGORIES);
export function getToolGuidance(categories) {
    const results = [];
    for (const cat of categories) {
        if (!TOOL_CATEGORIES[cat]) {
            throw new Error(`Unknown tool category: "${cat}". Valid: ${VALID_CATEGORIES.join(', ')}`);
        }
        results.push(TOOL_CATEGORIES[cat]);
    }
    return results.join('\n\n---\n\n');
}
export const PRELOAD_GUIDANCE = getToolGuidance(['memory', 'tracking']);
//# sourceMappingURL=tool-registry.js.map