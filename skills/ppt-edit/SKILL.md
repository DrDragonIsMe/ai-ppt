---
name: ppt-edit
description: Edit text, layout, and styling inside an HTML PPT deck's index.html. Reads the current deck, shows slide structure, and applies targeted changes while preserving the engine markup.
metadata: { "tags": "ppt, edit, html, layout, text, ai-ppt-base" }
---

# /ppt-edit

Use this skill when the user types `/ppt-edit` and wants to modify text, layout, or styling inside an HTML PPT deck.

## Syntax

```
/ppt-edit                              # list slides and ask what to edit
/ppt-edit slide <n> title "..."        # change slide n's main title
/ppt-edit slide <n> content "..."      # change slide n's lead/content text
/ppt-edit slide <n> layout two-col     # change slide n's layout class/style
/ppt-edit add slide after <n>          # add a new blank slide after slide n
/ppt-edit delete slide <n>             # remove slide n
```

The syntax above is a guide; the user may describe edits in natural language (e.g. "把第3页标题改成XX" / "第5页改成两栏布局"). Always confirm the exact change before mutating `index.html`.

## What it does

1. Locates the active deck (current directory or auto-detected sibling of `ai-ppt-base`).
2. Reads `index.html` and summarizes the slide structure.
3. Identifies the slide(s) and elements the user wants to change.
4. Applies the change with minimal, targeted edits.
5. Validates that the HTML still parses and the engine markup is intact.

## Steps

1. **Locate the deck**
   - If the user names a deck (e.g. "编辑 q3-report 的第3页"), look for `projects/<deck-name>/index.html` first.
   - If `index.html` exists in the current directory, use it.
   - Otherwise, search `projects/*/index.html`.
   - If `ai-ppt-base/index.html` is found and there are project deck directories, prefer the project deck; ask if more than one exists.

2. **Read and summarize**
   - Read `index.html`.
   - Extract each `<section class="slide">` block and list them with:
     - Slide number (1-based)
     - Slide title (`<h1>` or `<h2>` text)
     - Kicker / section-title if present
   - Show the summary to the user unless they already specified a target slide.

3. **Confirm the edit**
   - If the user's intent is ambiguous, ask for clarification.
   - If the change is large or destructive (e.g. deleting a slide), ask for explicit confirmation.
   - State exactly what will change before using `Edit` or `Write`.

4. **Apply the edit**
   - Use the `Edit` tool for targeted text/content changes.
   - Preserve all engine markup: `#overview`, `#help`, `#toast`, `#progress`, `#hud`, `<script src="js/ppt.js">`, and `<link rel="stylesheet" href="css/ppt.css">`.
   - When changing layout, prefer existing CSS classes (`.two-col`, `.tile-row`, `.tile`, `.ppt-table`, `.highlight-box`, `.cover-slide`, etc.) over inline styles.
   - When adding a slide, copy the `<section class="slide">` structure from an existing slide and set `class="slide active"` only on the new slide if it should be the first; otherwise use `class="slide"`.

5. **Validate**
   - Parse the modified `index.html` with Python's `html.parser` or similar.
   - Confirm the slide count matches expectations.
   - Report the result to the user.

## Common edit patterns

### Change a title

```html
<!-- before -->
<h1>旧标题</h1>

<!-- after -->
<h1>新标题</h1>
```

### Change lead text

```html
<!-- before -->
<p class="lead">旧段落</p>

<!-- after -->
<p class="lead">新段落</p>
```

### Switch to two-column layout

```html
<!-- before -->
<div class="slide-content">
  <h2>标题</h2>
  <p>...</p>
</div>

<!-- after -->
<div class="slide-content">
  <h2>标题</h2>
  <div class="two-col">
    <div class="tile"><h3>左栏</h3><p>...</p></div>
    <div class="tile"><h3>右栏</h3><p>...</p></div>
  </div>
</div>
```

### Use visual cards

```html
<div class="visual-row">
  <div class="visual-card">
    <div class="icon">1</div>
    <h3>要点一</h3>
    <p>简短说明</p>
  </div>
  <div class="visual-card">
    <div class="icon">2</div>
    <h3>要点二</h3>
    <p>简短说明</p>
  </div>
</div>
```

### Add a slide

Insert a new `<section class="slide">` at the desired position. Make sure only one slide has `class="slide active"` (typically the first). The JS engine toggles `.active` at runtime.

### Delete a slide

Remove the entire `<section class="slide">` block. If the deleted slide had `active`, move `active` to the first remaining slide.

## Do not

- Do not rewrite the entire `index.html` unless necessary (use targeted `Edit` calls).
- Do not remove or alter the `#overview`, `#help`, `#toast`, `#progress`, or `#hud` elements.
- Do not break the relative paths to `css/ppt.css` and `js/ppt.js`.
- Do not leave malformed HTML (unclosed tags, unmatched quotes).
