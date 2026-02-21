---
name: cortex-file
description: File-Historie, Dependencies und Impact-Analyse für eine Datei
user_invocable: true
argument: file_path
---

# Cortex File

Vollständige Analyse einer Datei: Änderungshistorie, Abhängigkeiten, Impact.

## Instructions

1. Argument = Dateipfad (relativ oder absolut)
2. Parallel aufrufen:
   - `cortex_get_file_history` mit file_path
   - `cortex_get_deps` mit file_path
3. Darstellen:
   - **Timeline:** Wann geändert, in welcher Session, welche Diffs
   - **Imports:** Was diese Datei importiert
   - **Importers:** Was diese Datei verwendet
   - **Impact:** Welche Dateien betroffen wenn diese geändert wird
   - **Errors:** Bekannte Fehler in dieser Datei
   - **Decisions:** Entscheidungen die diese Datei betreffen

## Usage

```
/cortex-file frontend/src/lib/supabase.ts
/cortex-file backend/app/api/routes/tierlist.py
```
