# Cortex v04 — The Brain: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan phase-by-phase.

**Goal:** Transform Cortex from a passive memory tool into an active, self-aware brain — 45 features across 5 phases.

**Cortex root:** C:/Users/toasted/Desktop/data/cortex/
**Tech Stack:** Node.js ESM (hooks), TypeScript (daemon + server), SQLite via node:sqlite, @modelcontextprotocol/sdk
**Windows note:** All claude CLI calls: `process.platform === 'win32' ? 'claude.cmd' : 'claude'`

---

# PHASE 1: Instant UX Wins
Features: #1 Resume, #5 Snooze, #10 Pin, #15 Scratch Pad, #17 Fuzzy Search
Target: 1 session

## Task 1: DB Schema Extensions
File: scripts/ensure-db.js

Add at the end of openDb() before return db:

```js
const v04migrations = [
  `ALTER TABLE unfinished ADD COLUMN snooze_until TEXT`,
  `ALTER TABLE unfinished ADD COLUMN priority_score INTEGER DEFAULT 50`,
  `ALTER TABLE learnings ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN core_memory INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN example_code TEXT`,
  `ALTER TABLE learnings ADD COLUMN theoretical_hits INTEGER DEFAULT 0`,
  `ALTER TABLE learnings ADD COLUMN practical_violations INTEGER DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN stale INTEGER DEFAULT 0`,
  `ALTER TABLE decisions ADD COLUMN reviewed_at TEXT`,
  `ALTER TABLE decisions ADD COLUMN counter_arguments TEXT`,
  `ALTER TABLE errors ADD COLUMN archived INTEGER DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN sentiment TEXT`,
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT, created_at TEXT DEFAULT (datetime('now')), session_id TEXT)`,
];
for (const sql of v04migrations) { try { db.exec(sql); } catch {} }
```

Commit: git add scripts/ensure-db.js && git commit -m "feat(db): v04 schema migrations"

---

## Task 2: Snooze and Remind (#5)
Files: scripts/on-session-start.js, server/src/index.ts, skills/snooze/SKILL.md

### on-session-start.js after unfinished query:
```js
let snoozeDue = [];
try { snoozeDue = db.prepare(`SELECT id, description FROM unfinished WHERE snooze_until IS NOT NULL AND snooze_until <= datetime('now') AND resolved_at IS NULL ORDER BY snooze_until ASC LIMIT 5`).all(); } catch {}
if (snoozeDue.length > 0) { lines.push(''); lines.push('REMINDERS DUE:'); snoozeDue.forEach(s => lines.push(`  [REMIND] ${s.description}`)); }
```

### server/src/index.ts new tool cortex_snooze:
```typescript
server.tool('cortex_snooze', 'Schedule a future session reminder', {
  description: z.string(),
  until: z.string().describe('Relative 3d/1w or ISO date 2026-03-01'),
  session_id: z.string().optional(),
}, async ({ description, until, session_id }) => {
  let d = new Date();
  if (/^\d+d$/i.test(until)) d.setDate(d.getDate() + parseInt(until));
  else if (/^\d+w$/i.test(until)) d.setDate(d.getDate() + parseInt(until) * 7);
  else d = new Date(until);
  db.prepare(`INSERT INTO unfinished (description,context,priority,session_id,snooze_until) VALUES (?,?,?,?,?)`).run(description, 'snoozed', 'medium', session_id||null, d.toISOString());
  return { content: [{ type: 'text', text: `Reminder set for ${d.toISOString().slice(0,10)}` }] };
});
```

### skills/snooze/SKILL.md:
```
---
name: snooze
description: Set a reminder for a future session
---
Extract reminder text and time from user message.
Call cortex_snooze with description and until (3d, 1w, or date).
Confirm: Reminder set for [date]: [text]
```

Build: cd server && npm run build
Commit: feat(snooze): snooze and remind

---

## Task 3: /pin Skill (#10)
File: skills/pin/SKILL.md

```
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
```

Commit: feat(pin): /pin skill

---

## Task 4: /resume Skill (#1)
File: skills/resume/SKILL.md

```
---
name: resume
description: Get re-entry brief — what was I working on?
---
Run IN PARALLEL:
1. cortex_list_sessions limit=3
2. cortex_get_unfinished
3. cortex_get_hot_zones limit=5

Present brief:
LAST SESSION: [summary] ([X days ago])
OPEN ITEMS: [list]
RECENTLY CHANGED: [files]
Continue where you left off?
```

Commit: feat(resume): /resume skill

---

## Task 5: Scratch Pad (#15) + Fuzzy Search (#17)
Files: server/src/index.ts, skills/note/SKILL.md

### Add note tools to server/src/index.ts:
```typescript
server.tool('cortex_add_note', 'Add scratch pad note', { text: z.string(), tags: z.array(z.string()).optional(), session_id: z.string().optional() }, async ({ text, tags, session_id }) => {
  const r = getDb().prepare(`INSERT INTO notes (text,tags,session_id) VALUES (?,?,?)`).run(text, tags?JSON.stringify(tags):null, session_id||null);
  return { content: [{ type: 'text', text: `Note saved (id: ${r.lastInsertRowid})` }] };
});
server.tool('cortex_list_notes', 'List notes', { limit: z.number().optional().default(20), search: z.string().optional() }, async ({ limit, search }) => {
  const db = getDb();
  const notes = search ? db.prepare(`SELECT * FROM notes WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`).all(`%${search}%`, limit) : db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT ?`).all(limit);
  return { content: [{ type: 'text', text: (notes as any[]).map(n=>`[${n.id}] ${n.created_at.slice(0,10)}: ${n.text}`).join('\n') || 'No notes.' }] };
});
server.tool('cortex_delete_note', 'Delete note by id', { id: z.number() }, async ({ id }) => {
  getDb().prepare(`DELETE FROM notes WHERE id=?`).run(id);
  return { content: [{ type: 'text', text: `Deleted note ${id}` }] };
});
```

### Upgrade cortex_search handler in server/src/index.ts:
Replace handler body with unified search across sessions, decisions, errors, learnings, conventions, unfinished, notes.
Each result prefixed with [SESSION], [DECISION], [ERROR], [LEARNING], [CONVENTION], [TODO], [NOTE].
Use LIKE queries with %query% on relevant text columns.

### skills/note/SKILL.md:
```
---
name: note
description: Save a quick scratch pad note
---
Call cortex_add_note with the text. For listing: cortex_list_notes. For search: cortex_list_notes with search param.
```

Build and commit.

---

# PHASE 2: Time and Memory Intelligence
Features: #2 Deja-vu, #6 Blame, #11 Decay, #13 Impact, #14 Digest, #16 Time Machine, #30 Temporal, #37 Consolidation, #43 Timeline, #44 Forget
Target: 1-2 sessions

## Task 6: Decision Decay (#11) + Temporal Awareness (#30)
Files: scripts/on-session-end.js, scripts/on-session-start.js, server/src/db.ts, server/src/modules/*.ts, server/src/index.ts

### on-session-end.js add stale flagging in main():
```js
try { db.prepare(`UPDATE decisions SET stale=1 WHERE stale\!=1 AND created_at < datetime('now','-90 days') AND (reviewed_at IS NULL OR reviewed_at < datetime('now','-90 days'))`).run(); } catch {}
```

### on-session-start.js show stale count:
```js
let staleCount = 0;
try { staleCount = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE stale=1`).get()?.c || 0; } catch {}
if (staleCount > 0) lines.push(`  STALE: ${staleCount} decisions >90 days — still current? (/cortex decisions)`);
```

### server/src/db.ts add ageLabel():
```typescript
export function ageLabel(dateStr: string|null|undefined): string {
  if (\!dateStr) return 'unknown';
  const d = (Date.now()-new Date(dateStr).getTime())/86400000;
  if (d<3) return 'fresh'; if (d<14) return 'recent'; if (d<90) return 'established';
  if (d<365) return 'legacy'; return 'ancient';
}
```
Import and use in modules/errors.ts, decisions.ts, learnings.ts — add age field to return objects.

### server/src/index.ts add cortex_mark_decision_reviewed:
```typescript
server.tool('cortex_mark_decision_reviewed', 'Mark decision as reviewed/still current', { id: z.number() }, async ({ id }) => {
  getDb().prepare(`UPDATE decisions SET stale=0, reviewed_at=datetime('now') WHERE id=?`).run(id);
  return { content: [{ type: 'text', text: `Decision ${id} marked as reviewed.` }] };
});
```

Build and commit.

---

## Task 7: Impact Tracking (#13) + Weekly Digest (#14)
Files: scripts/on-post-tool-use.js, scripts/on-session-start.js

### on-post-tool-use.js after diff save in Write/Edit block:
```js
try {
  const recentFix = db.prepare(`SELECT e.fix_description, s.started_at FROM errors e LEFT JOIN sessions s ON s.id=e.session_id WHERE e.files_involved LIKE ? AND e.fix_description IS NOT NULL AND s.started_at > datetime('now','-7 days') ORDER BY s.started_at DESC LIMIT 1`).get(`%${filePath}%`);
  if (recentFix) {
    const daysAgo = Math.round((Date.now()-new Date(recentFix.started_at).getTime())/86400000);
    const feedbackPath = join(cwd, '.claude', 'cortex-feedback.jsonl');
    appendFileSync(feedbackPath, JSON.stringify({ file: filePath, message: `IMPACT: Fixed ${daysAgo}d ago: Is the fix holding?` })+'\n', 'utf-8');
  }
} catch {}
```

### on-session-start.js weekly digest:
```js
try {
  const lastDigest = db.prepare(`SELECT value FROM meta WHERE key='last_weekly_digest'`).get()?.value;
  const daysSince = lastDigest ? (Date.now()-new Date(lastDigest).getTime())/86400000 : 999;
  if (new Date().getDay()===1 || daysSince>=7) {
    const s7 = db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE started_at > datetime('now','-7 days') AND status='completed'`).get()?.c||0;
    const f7 = db.prepare(`SELECT COUNT(DISTINCT file_path) as c FROM diffs WHERE created_at > datetime('now','-7 days')`).get()?.c||0;
    const fix7 = db.prepare(`SELECT COUNT(*) as c FROM errors WHERE fix_description IS NOT NULL AND session_id IN (SELECT id FROM sessions WHERE started_at > datetime('now','-7 days'))`).get()?.c||0;
    const crit = db.prepare(`SELECT COUNT(*) as c FROM errors WHERE fix_description IS NULL AND severity='critical' AND archived\!=1`).get()?.c||0;
    lines.push(''); lines.push('WEEKLY DIGEST:');
    lines.push(`  ${s7} sessions | ${f7} files | ${fix7} bugs fixed${crit>0?' | '+crit+' critical open':''}`);
    db.prepare(`INSERT INTO meta (key,value) VALUES ('last_weekly_digest',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  }
} catch {}
```

Commit.

---

## Task 8: Blame (#6) + Time Machine (#16) + Timeline (#43) + Forget (#44) + Deja-vu (#2)
File: server/src/index.ts

Add tools: cortex_blame, cortex_compare_periods, cortex_get_timeline, cortex_forget, cortex_dejavu.

### cortex_blame:
Query project_files, diffs JOIN sessions, errors for a file_path LIKE pattern. Return formatted history.

### cortex_compare_periods:
Compare sessions/errors/fixes between two date ranges using datetime queries.

### cortex_get_timeline:
GROUP BY strftime('%Y-%m', started_at) with COUNT and GROUP_CONCAT of summaries.

### cortex_forget:
UPDATE decisions/errors/learnings SET archived=1 WHERE relevant LIKE fields match topic.

### cortex_dejavu:
Extract keywords from task_description (words >4 chars), query sessions WHERE summary LIKE any keyword, return matches.

Also create skills/timeline/SKILL.md (name: timeline, calls cortex_get_timeline).

Build and commit.

---

## Task 9: Memory Consolidation (#37)
Files: scripts/on-session-end.js, scripts/on-pre-tool-use.js

### on-session-end.js:
```js
try {
  db.prepare(`UPDATE learnings SET archived=1 WHERE auto_block=1 AND theoretical_hits=0 AND created_at < datetime('now','-30 days') AND core_memory\!=1`).run();
  db.prepare(`UPDATE learnings SET core_memory=1 WHERE theoretical_hits>=10`).run();
} catch {}
```

### on-pre-tool-use.js update learnings WHERE clause:
Change to: WHERE (auto_block=1 OR core_memory=1) AND archived\!=1 AND detection_regex IS NOT NULL

Commit.

---

# PHASE 3: Automation and Daemon Agents
Features: #3 Anomalie, #4 Drift, #12 Predict, #21 Blind Spot, #22 Intent, #26 Redundancy, #28 Loop, #29 Silent, #35 Synthesis, #39 Gut Feeling, #40 Pattern Absorption
Target: 1-2 sessions

## Task 10: Loop Detector (#28) + Passive Anomalie (#3) + Predictive Warnings (#12)
Files: scripts/on-post-tool-use.js, scripts/on-pre-tool-use.js

### on-post-tool-use.js module-level loop tracker:
Add const _editTracker = new Map() at module level.
In Write/Edit block after filePath is known:
Track count+firstAt per file. If same file edited 3+ times in 5min, append LOOP DETECTED warning to output.additionalContext.

### on-pre-tool-use.js passive warnings after existing checks:
For the target file, check:
- project_files.change_count > 10 => HOT ZONE warning
- errors WHERE files_involved LIKE file AND last 7 days => RECENT ERROR warning
- decisions WHERE files_affected LIKE file => DECISION warning
Add all as output.additionalContext (non-blocking).

Commit.

---

## Task 11: Drift Detection Daemon Agent (#4)
Files: daemon/src/agents/drift-detector.ts (new), daemon/src/index.ts

### drift-detector.ts:
- Check meta for last run, skip if <22h
- Read recent decisions (architecture/convention category)
- Read diffs from last 2 hours
- Call runClaudeAgent with haiku model: list decisions + recent files, ask for DRIFT: lines
- Parse DRIFT: lines, save as unfinished items
- Update meta last run

### daemon/src/index.ts:
Import and call runDriftDetectorAgent in session_end handler (non-blocking catch).

Build daemon (cd daemon && npm run build). Commit.

---

## Task 12: Synthesizer + Serendipity Daemon Agents

**Goal:** Two new daemon agents: synthesizer condenses memory every N sessions; serendipity surfaces random old observations to spark new thinking.

### 12.1 Synthesizer Agent

File: `daemon/src/agents/synthesizerAgent.ts`

Runs every 10 sessions. Reads last 50 observations. Calls LLM to produce a synthesis paragraph. Stores result as a special observation with tag `synthesis`.

```typescript
export async function runSynthesizerAgent(db: DB): Promise<void> {
  const sessionCount = await getSessionCount(db);
  if (sessionCount % 10 \!== 0) return;
  const obs = await getRecentObservations(db, 50);
  const synthesis = await callLLM(buildSynthesisPrompt(obs));
  await storeObservation(db, { text: synthesis, tags: ["synthesis"], source: "synthesizer" });
}
```

### 12.2 Serendipity Agent

File: `daemon/src/agents/serendipityAgent.ts`

Runs at session start. Picks 1-3 random old observations (>30 days old). Returns them as a "memory flash" prepended to context.

```typescript
export async function runSerendipityAgent(db: DB): Promise<string[]> {
  const old = await getOldObservations(db, { minAgeDays: 30, limit: 3 });
  return old.map(o => o.text);
}

// In session_start: prepend serendipity flashes to context inject
```

Wire both agents into daemon/src/index.ts. Build. Commit.

---

## Task 13: Blind Spot + Intent Memory + Gut Feeling + Redundancy Detector

**Goal:** Four cognitive features that make Cortex feel like a second brain.

### 13.1 Blind Spot Detector

Compares topics discussed in last 5 sessions vs. known project areas. Flags areas not recently touched. Surfaced as nudge at session end.

### 13.2 Intent Memory

Extracts stated intentions from user messages ("I want to...", "I plan to...", "Next I will..."). Stores as intent observations. At session start, resurfaces unresolved intents.

```typescript
// Intent extraction regex patterns
const INTENT_PATTERNS = [
  /I(?:am going to| will| want to| plan to| intend to) (.+?)(?:\.|$)/gi,
  /Next(?:,| I will| step is to) (.+?)(?:\.|$)/gi,
];
```

### 13.3 Gut Feeling

LLM scores each session on a confidence scale (1-5). Stored in DB. Dashboard shows confidence trend over time. Low confidence sessions flagged for review.

### 13.4 Redundancy Detector

Before storing a new observation, compute cosine similarity against last 100 observations. If similarity > 0.92, skip or merge. Prevents memory bloat.

```typescript
async function isDuplicate(text: string, db: DB): Promise<boolean> {
  const embedding = await embed(text);
  const recent = await getRecentEmbeddings(db, 100);
  return recent.some(e => cosineSimilarity(embedding, e) > 0.92);
}
```

All four features in daemon/src/agents/. Build. Test. Commit.

---

## Phase 4: Context Intelligence (Tasks 14-18)

---

## Task 14: Emotional Tags + System Mood

**Goal:** Cortex tracks the emotional tone of sessions and maintains a system mood that influences its responses.

### 14.1 Emotional Tagging

After each session, LLM classifies emotional tone: frustrated, focused, exploratory, stuck, productive, confused.
Stored as metadata on session record.

```sql
ALTER TABLE sessions ADD COLUMN emotional_tone TEXT;
ALTER TABLE sessions ADD COLUMN mood_score INTEGER CHECK(mood_score BETWEEN 1 AND 5);
```

### 14.2 System Mood

Computed from rolling average of last 7 sessions mood_score.
Mood influences context injection tone:
- Low mood (1-2): Cortex adds encouragement and simplification
- High mood (4-5): Cortex goes deeper, adds complexity

```typescript
export async function getSystemMood(db: DB): Promise<number> {
  const sessions = await getRecentSessions(db, 7);
  const scores = sessions.map(s => s.mood_score).filter(Boolean);
  return scores.length ? scores.reduce((a,b) => a+b, 0) / scores.length : 3;
}
```

Mood exposed via MCP tool `cortex_get_mood`. Dashboard shows mood history chart.

Build. Commit.

---

## Task 15: Attention Anchors + Semantic Context Windows + Proactive Nudges

**Goal:** Cortex knows what to pay attention to and proactively surfaces relevant context.

### 15.1 Attention Anchors

User-defined topics that always get priority in context injection.
Stored in DB table `attention_anchors`. MCP tools: `cortex_add_anchor`, `cortex_remove_anchor`, `cortex_list_anchors`.

```sql
CREATE TABLE attention_anchors (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  topic TEXT NOT NULL,
  priority INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime("now"))
);
```

### 15.2 Semantic Context Windows

Instead of injecting the N most recent observations, inject based on semantic relevance to current conversation topic.
Topic is extracted from session start message or first user message.

```typescript
export async function getSemanticContext(
  db: DB, topic: string, limit = 10
): Promise<Observation[]> {
  const topicEmbedding = await embed(topic);
  const obs = await getAllObservations(db);
  return obs
    .map(o => ({ ...o, score: cosineSimilarity(topicEmbedding, o.embedding) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, limit);
}
```

### 15.3 Proactive Nudges

At session start, Cortex checks:
- Unresolved intents older than 3 days -> nudge
- Attention anchors not touched in 7 days -> nudge
- Drift detected topics -> nudge
- Low-confidence sessions -> suggest review

Nudges injected as system message prefix at session start.

Build. Test. Commit.

---

## Task 16: User Profile + Export Brain + Circadian Awareness

**Goal:** Cortex knows who you are, can export its memory, and is aware of time patterns.

### 16.1 User Profile

Persistent profile stored in DB. Populated at onboarding and updated over time.

```sql
CREATE TABLE user_profile (
  id INTEGER PRIMARY KEY,
  name TEXT,
  role TEXT,
  working_style TEXT,
  expertise_areas TEXT,
  communication_preference TEXT,
  updated_at TEXT DEFAULT (datetime("now"))
);
```

MCP tools: `cortex_update_profile`, `cortex_get_profile`.

### 16.2 Export Brain

MCP tool `cortex_export` exports all observations, sessions, profile, anchors to a single JSON or Markdown file.
Useful for backup, migration, or sharing brain state.

```typescript
export async function exportBrain(db: DB, format: "json" | "markdown"): Promise<string> {
  const data = await collectAllBrainData(db);
  return format === "json" ? JSON.stringify(data, null, 2) : toMarkdown(data);
}
```

### 16.3 Circadian Awareness

Cortex tracks session timestamps and learns user work patterns.
Morning sessions get focus-oriented context. Evening sessions get review-oriented context.
Simple rule-based (no ML needed): hour < 12 = morning mode, hour > 17 = evening mode.

Build. Commit.

---

## Task 17: Devils Advocate + Confidence Calibration + Show Code

**Goal:** Cortex actively challenges assumptions, tracks its own confidence, and can surface code snippets from memory.

### 17.1 Devils Advocate Mode

MCP tool `cortex_devils_advocate` takes a decision or plan as input.
Returns counter-arguments and failure modes based on stored project knowledge.

### 17.2 Confidence Calibration

When Cortex injects facts from memory, it attaches a confidence score (0.0-1.0).
Score based on: observation age, source reliability, contradiction count.

```typescript
function computeConfidence(obs: Observation): number {
  const ageFactor = Math.max(0, 1 - obs.ageDays / 90);
  const sourceFactor = obs.source === "user" ? 1.0 : 0.85;
  const contradictionPenalty = obs.contradictions * 0.1;
  return Math.max(0, ageFactor * sourceFactor - contradictionPenalty);
}
```

### 17.3 Show Code

MCP tool `cortex_show_code` retrieves code snippets stored in observations tagged `code`.
Supports filtering by language, project, and keyword.

```typescript
export async function showCode(db: DB, opts: {
  language?: string; project?: string; keyword?: string
}): Promise<Observation[]> {
  return queryObservations(db, { tag: "code", ...opts });
}
```

Build. Test. Commit.

---

## Task 18: Priority Scoring + Brain Snapshot

**Goal:** Every observation gets a dynamic priority score. Snapshots capture full brain state at a point in time.

### 18.1 Priority Scoring

Each observation has a computed priority score updated on every access:
- Recency: newer = higher
- Access frequency: more accessed = higher
- User-starred: +50 bonus
- Emotional weight: frustration/excitement +20
- Decay: -1 per day without access

```sql
ALTER TABLE observations ADD COLUMN priority_score REAL DEFAULT 50.0;
ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE observations ADD COLUMN starred INTEGER DEFAULT 0;
```

Context injection sorts by priority_score DESC. Top N injected.

### 18.2 Brain Snapshot

MCP tool `cortex_snapshot` captures current state: top 20 observations by priority, active intents, current mood, drift summary, attention anchors.
Returns a concise Markdown summary. Ideal for sharing with a new Claude session or for daily review.

```typescript
export async function takeBrainSnapshot(db: DB): Promise<string> {
  const [topObs, intents, mood, drift, anchors] = await Promise.all([
    getTopObservations(db, 20),
    getActiveIntents(db),
    getSystemMood(db),
    getDriftSummary(db),
    getAttentionAnchors(db)
  ]);
  return formatSnapshot({ topObs, intents, mood, drift, anchors });
}
```

Build. Commit.

---

## Phase 5: Polish + Productionize (Tasks 19-21)

---

## Task 19: Early Context Load + Onboarding Flow

**Goal:** First-run experience sets up the brain correctly. Every session loads context as early as possible.

### 19.1 Onboarding Flow

On first run (no DB exists), Cortex runs an interactive onboarding via MCP tool `cortex_onboard`:
1. Asks for name, role, and main project
2. Asks for top 3 working style preferences
3. Asks for 3-5 initial attention anchors
4. Generates initial system prompt based on answers
5. Stores in user_profile + attention_anchors

### 19.2 Early Context Load

The Claude Code ESM hook (`register()`) fires before any tool is called.
Cortex pre-loads top 10 priority observations and active intents into a module-level cache.
This cache is used by `cortex_inject` without waiting for DB query.

```typescript
// In hook: preloader fires immediately
let preloadedContext: string | null = null;
(async () => {
  try {
    preloadedContext = await loadEarlyContext();
  } catch { /* silent fail */ }
})();

export function getPreloadedContext(): string | null {
  return preloadedContext;
}
```

Build. Commit.

---

## Task 20: Cross-Project Brain

**Goal:** Cortex can maintain separate memory spaces per project, with optional cross-project knowledge sharing.

### 20.1 Project Namespacing

All observations, sessions, intents, and anchors have a `project` field.
Default project: inferred from CWD or explicitly set via `cortex_set_project`.

```typescript
export function inferProject(cwd: string): string {
  return path.basename(cwd);
}
```

### 20.2 Cross-Project Queries

MCP tool `cortex_cross_project_search` searches across all projects.
Useful when starting a new project that shares domain knowledge with an old one.

### 20.3 Global Observations

Observations tagged `global` are injected in every project context.
Used for facts that apply universally (coding principles, user preferences, etc.).

```sql
-- Global observations: project = "__global__"
INSERT INTO observations (project, text, tags)
VALUES ("__global__", "Always write tests.", "global,principle");
```

Build. Test. Commit.

---

## Task 21: Update /cortex Dashboard + Final Build

**Goal:** The /cortex dashboard reflects all v04 capabilities. Final production build verified.

### 21.1 Dashboard Updates

New dashboard sections:
- **Brain Snapshot** — one-click current state summary
- **Mood History** — chart of mood_score over last 30 sessions
- **Active Intents** — list with age and resolve button
- **Drift Report** — current drift topics highlighted
- **Attention Anchors** — manage anchors inline
- **Blind Spots** — areas not touched recently
- **Memory Stats** — total observations, by project, by tag
- **Export Brain** — download as JSON or Markdown

### 21.2 MCP Tool Registry Update

Full list of MCP tools in v04:
- `cortex_inject` — inject context at session start
- `cortex_store` — store an observation
- `cortex_search` — semantic search observations
- `cortex_status` — system health + stats
- `cortex_get_mood` — current system mood
- `cortex_snapshot` — full brain snapshot
- `cortex_export` — export brain as JSON/Markdown
- `cortex_add_anchor` — add attention anchor
- `cortex_remove_anchor` — remove attention anchor
- `cortex_list_anchors` — list all anchors
- `cortex_update_profile` — update user profile
- `cortex_get_profile` — retrieve user profile
- `cortex_onboard` — first-run onboarding
- `cortex_set_project` — set active project
- `cortex_cross_project_search` — search across projects
- `cortex_show_code` — retrieve stored code snippets
- `cortex_devils_advocate` — challenge decisions with counter-arguments

### 21.3 Final Build Checklist

- [ ] All TypeScript compiles without errors (daemon + server)
- [ ] All DB migrations applied cleanly on fresh DB
- [ ] All MCP tools respond correctly via MCP Inspector
- [ ] Dashboard loads with real data from local Cortex instance
- [ ] Hook fires and preloads context (verified via claude --debug)
- [ ] Daemon runs without crashes for 10+ sessions
- [ ] Export produces valid JSON and valid Markdown
- [ ] Cross-project search returns results from multiple projects
- [ ] Onboarding completes and populates DB correctly
- [ ] Version bumped to v04 in package.json files

Final commit: `feat: cortex v04 the brain — complete`

---

## Summary

### What Cortex v04 Delivers

| Category | Features |
|-|-|
| **Core Memory** | Persistent SQLite DB, structured observations, tags, embeddings |
| **Session Lifecycle** | session_start/session_end hooks, auto-inject, auto-store |
| **MCP Server** | 17 tools, TypeScript, @modelcontextprotocol/sdk |
| **Daemon Agents** | Drift Detector, Synthesizer, Serendipity, Blind Spot, Intent, Gut Feeling, Redundancy |
| **Context Intelligence** | Semantic windows, attention anchors, proactive nudges, circadian awareness |
| **Self-Awareness** | Emotional tags, system mood, confidence calibration, priority scoring |
| **User Tools** | Brain snapshot, export, onboarding, user profile, devils advocate |
| **Multi-Project** | Project namespacing, cross-project search, global observations |
| **Dashboard** | Full /cortex UI with mood chart, intents, drift, anchors, stats, export |

### Guiding Principles

1. **Cortex never forgets** — everything is persisted, nothing is lost
2. **Cortex is proactive** — it surfaces what you need before you ask
3. **Cortex is honest** — confidence scores prevent overconfident injection
4. **Cortex is yours** — full export, full control, no cloud dependency
5. **Cortex is silent** — zero latency impact, zero interruptions

### Architecture at a Glance

```
Claude Code Session
  |
  +-- ESM Hook (register) ---------> preload context cache
  |
  +-- session_start tool ----------> inject context + nudges + serendipity
  |
  |   [conversation happens]
  |
  +-- session_end tool ------------> store observations + run daemon agents
                                      (drift, synthesizer, mood, intents)
                                      (non-blocking, fire-and-forget)

MCP Server (stdio)
  +-- 17 tools via @modelcontextprotocol/sdk
  +-- SQLite via node:sqlite (no external deps)
  +-- TypeScript, ESM, strict mode

Daemon Process (optional)
  +-- Runs after session_end
  +-- Drift Detector
  +-- Synthesizer (every 10 sessions)
  +-- Serendipity (random old memory)
  +-- Intent Extractor
  +-- Redundancy Detector
  +-- Mood Scorer
```

---

*Plan generated: 2026-02-21 | Cortex v04 The Brain*
