# Cortex v0.2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cortex um einen autonomen Daemon mit 3 claude-p Sub-Agents erweitern, der automatisch beim SessionStart startet, Full-Stack-Architekturfeedback gibt, aus Sessions lernt und sich selbst verbessert.

**Architecture:** Der Daemon startet automatisch via SessionStart-Hook als detached Node.js-Prozess, liest Events aus einer JSONL-Queue-Datei, und orchestriert drei spezialisierte `claude -p` Sub-Agents (Architekt, Kontext, Learner). Kommunikation Hook->Daemon ueber `.claude/cortex-events.jsonl`. Keine Extra-Kosten.

**Tech Stack:** Node.js 22+, TypeScript, node:sqlite, child_process.spawn fuer claude -p, JSONL fuer IPC.

**Cortex Pfad:** C:/Users/toasted/Desktop/data/cortex/
**Projekt Pfad:** C:/Users/toasted/Desktop/data/sla-tools-v2/

---

## WELLE 1 - Bug-Fixes + MCP-Tools

### Task 1: FTS-Bug-Fix (sessions.ts:98-112)
searchSessions() nutzt sessions_fts (existiert nicht) -> crash.
Fix: try/catch + LIKE-Fallback auf summary + key_changes.
Build: cd cortex/server && npm run build
Commit: fix: searchSessions FTS fallback to LIKE

### Task 2: inferModulePath Fix + cortex_scan_project
- inferModulePath: AriseTools-Grenzen (frontend/src, backend/app, supabase/migrations) pruefen
- scanProject(): collectFiles() rekursiv, upsertModule/upsertFile, extractImports()
- cortex_update_map Stub ersetzen + cortex_scan_project hinzufuegen in index.ts
Build + Commit: feat: implement cortex_scan_project and fix inferModulePath

### Task 3: cortex_index_docs
- CLAUDE.md: Gotchas (#NNN) -> learnings (auto_block: false)
- docs/*.md: H2-Sections -> decisions (category: architecture)
- Idempotent via INSERT OR IGNORE
Build + Commit: feat: cortex_index_docs - CLAUDE.md gotchas and docs sections

### Task 4: cortex_resolve_unfinished + cortex_list_learnings + cortex_get_stats
- unfinished.ts: resolveUnfinished(id, sessionId) - setzt resolved_at
- 3 neue Tools in index.ts
Build + Commit: feat: add resolve_unfinished, list_learnings, get_stats

---

## WELLE 2 - Daemon + Agents

### Task 5: Daemon-Projekt aufsetzen
- daemon/package.json: type module, no external deps, node >= 22
- daemon/tsconfig.json: NodeNext module resolution
- npm install
Commit: feat: scaffold daemon package

### Task 6: runner.ts + queue.ts
runner.ts:
  - spawn('claude', ['-p', prompt, '--output-format', 'text', '--dangerously-skip-permissions'])
  - Serial Queue (pendingQueue array) - verhindert parallele claude-Prozesse
  - Timeout: 90s default
  - runClaudeAgent(opts): Promise<RunnerResult>

queue.ts:
  - EventQueue class: liest cortex-events.jsonl via polling
  - read(): gibt unprocessed Events zurueck, prueft auf size-Aenderung
  - markProcessed(events): setzt processed:true in der Datei
  - appendEvent(projectPath, event): helper fuer Hooks
Build + Commit: feat: daemon runner and event queue

### Task 7: agents/architect.ts
Trigger: einmalig beim Daemon-Start
Input: project_files + project_modules aus DB (max 200 Files)
Prompt: "Identifiziere Feature-Gruppen, erstelle Full-Stack-Trace, JSON-Output"
Output: decisions in DB (INSERT OR IGNORE)
JSON-Format: { features: [{name, frontend[], hooks[], services[], backend[], db[], description}], critical_files[], summary }
Build + Commit: feat: architect agent - full-stack feature trace

### Task 8: agents/context.ts
Trigger: file_access Event
Debounce: 60s pro Datei (Map<string, timestamp>)
Input: file_type, imports, importedBy, relevante decisions aus DB
Prompt: "4 Zeilen: was macht Datei X, wichtigste Zusammenhaenge, 1 Gotcha"
Output: cortex-feedback.jsonl (wird von PostToolUse-Hook gelesen)
Nebeneffekt: project_files.description aktualisieren wenn leer
Build + Commit: feat: context agent - file access feedback

### Task 9: agents/learner.ts
Trigger: session_end Event
Input: geaenderte Dateien (last 2h aus DB) + Transcript (letzte 8000 Zeichen)
Prompt: "Erkenne korrigierte Fehler -> learnings, Bugs -> errors, neue Zusammenhaenge -> architecture_updates"
Output: INSERT in learnings, errors, UPDATE project_files
Build + Commit: feat: learner agent - self-improvement from transcripts

### Task 10: daemon/src/index.ts
- Args: --project <path>
- PID-File: .claude/cortex-daemon.pid schreiben
- SIGTERM/SIGINT: PID-File loeschen + exit
- Beim Start: runArchitectAgent() async
- setInterval(500ms): queue.read() -> events dispatchen
Build + Commit: feat: daemon entry point with PID management

### Task 11: Hooks aktualisieren

on-session-start.js (am Ende von main(), vor finally):
  1. pidFile = .claude/cortex-daemon.pid pruefen
  2. Falls PID: process.kill(pid, 0) - wirft wenn tot -> PID-File loeschen
  3. Falls nicht laeuft + daemonScript exists:
     spawn('node', [daemonScript, '--project', cwd], {detached:true, stdio:'ignore'})
     daemon.unref()

on-post-tool-use.js (am Ende von main() try-Block):
  1. appendFileSync(eventsPath, JSON.stringify({type:'file_access', file, tool, session_id, ts})+'\n')
  2. Feedback-File lesen (.claude/cortex-feedback.jsonl)
  3. Wenn letztes Feedback < 30s alt: systemMessage ausgeben + Datei leeren

on-session-end.js (am Ende von main() try-Block):
  1. appendFileSync(eventsPath, JSON.stringify({type:'session_end', session_id, transcript_path, ts})+'\n')
  2. setTimeout(2000) - Daemon kann Event noch lesen
  3. PID lesen + process.kill(pid, 'SIGTERM')

Commit: feat: hooks - auto-start daemon, event queue, context feedback

### Task 12: Hook-Matcher erweitern
.claude/settings.local.json im Projekt:
PostToolUse matcher: "Write|Edit" -> "Read|Write|Edit"
Commit: chore: extend PostToolUse matcher to Read events

### Task 13: End-to-End-Test
1. ls daemon/dist/agents/ -> architect.js context.js learner.js vorhanden
2. cortex_scan_project({root_path: "...sla-tools-v2"}) -> scanned >100
3. cortex_get_unfinished() -> Item #1 sehen
   cortex_resolve_unfinished({id:1}) -> success:true
   cortex_get_unfinished() -> leer
4. cortex_index_docs({docs_path: "...sla-tools-v2"}) -> gotchas >50
5. Neue Session -> .claude/cortex-daemon.pid existiert
Final Commit: feat: cortex v0.2 complete
