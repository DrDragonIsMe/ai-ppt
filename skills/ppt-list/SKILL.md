---
name: ppt-list
description: List all ai-ppt HTML deck projects under projects/, showing name, title, status, and last generated time.
metadata: { "tags": "ppt, list, projects, deck, ai-ppt" }
---

# /ppt-list

Use this skill when the user types `/ppt-list` and wants to see all available HTML PPT deck projects.

## Syntax

```
/ppt-list  # list all decks
```

## What it does

1. Discovers all directories under `projects/`.
2. Reads each deck's `ai-ppt.json` to obtain title, status, and last generated time.
3. Prints a formatted list to the user.
4. Suggests next actions (preview, edit, export, delete).

## Steps

1. **Locate projects directory**
   - Use `projects/` in the current working directory.
   - If it does not exist, warn the user and stop.

2. **Enumerate decks**
   - List all immediate subdirectories of `projects/`.
   - For each subdirectory, read `projects/<name>/ai-ppt.json` if it exists.
   - Extract:
     - `name` — directory name
     - `title` — `params.title` or `name`
     - `status` — `status` field (`draft`, `ready`, `generating`, `error`)
     - `lastGeneratedAt` — ISO timestamp or `-`

3. **Format output**
   - Show a markdown or aligned table:
     ```
     项目标识        标题               状态      最后生成
     q3-sales-preview  Q3 销售复盘        ready     2026-07-09 10:23
     test-new-css     test-new-css       draft     -
     ```
   - If `ai-ppt.json` is missing, show `status: draft` and `title: <name>`.

4. **Suggest next steps**
   - `/ppt-preview <name>` — preview a deck
   - `/ppt-edit <name>` — edit a deck
   - `/ppt-export <name> pdf|pptx` — export a deck
   - `/ppt-delete <name>` — delete a deck
   - `/ppt-structure <name>` — create a new deck

## Do not

- Do not modify any files.
- Do not fail if a project lacks `ai-ppt.json`; treat it as a draft deck.
