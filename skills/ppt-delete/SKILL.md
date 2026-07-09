---
name: ppt-delete
description: Delete an ai-ppt HTML deck project directory from projects/. Asks for confirmation before removing the deck and its files.
metadata: { "tags": "ppt, delete, remove, deck, project, ai-ppt" }
---

# /ppt-delete

Use this skill when the user types `/ppt-delete` and wants to remove an existing HTML PPT deck project.

## Syntax

```
/ppt-delete <deck-name>  # delete a specific deck
/ppt-delete              # list available decks and ask which to delete
```

## What it does

1. Locates the deck in `projects/<deck-name>/`.
2. Lists the deck directory contents for the user to review.
3. Asks for explicit confirmation before deleting.
4. Removes the entire `projects/<deck-name>/` directory.
5. Reports the deletion result.

## Steps

1. **Determine deck name**
   - Use the first argument after `/ppt-delete` (e.g. `/ppt-delete old-deck` → `projects/old-deck/`).
   - If no name is provided:
     - List all directories under `projects/`.
     - Present them to the user and ask which one to delete.
   - If `projects/<deck-name>` does not exist, warn the user and stop.

2. **Confirm deletion**
   - This is a destructive action. Always ask the user to confirm.
   - Show the deck path and a summary of what will be removed (e.g., file count or top-level listing).
   - Example prompt: "确定删除项目 `old-deck` 吗？该操作会移除 projects/old-deck/ 及其下所有文件，不可恢复。"

3. **Delete the deck**
   - Stop any running preview server for this deck if possible (optional).
   - Remove the directory recursively: `rm -rf projects/<deck-name>` or equivalent.

4. **Report to user**
   - Confirm the deck was deleted.
   - Suggest next steps:
     - Run `/ppt-structure <name>` to create a new deck.
     - Run `/ppt-preview` to preview another deck.

## Do not

- Do not delete `ai-ppt-base/` — that is the shared engine template.
- Do not delete a deck without explicit user confirmation.
- Do not delete the current working directory or any files outside `projects/<deck-name>/`.
