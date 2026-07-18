---
name: ppt-structure
description: Scaffold a new HTML PPT deck by copying the reusable engine from ai-ppt-base. Creates a new directory with css/ppt.css, js/ppt.js, and a fresh starter index.html.
metadata: { "tags": "ppt, scaffold, html, structure, template, ai-ppt-base" }
---

# /ppt-structure

Use this skill when the user types `/ppt-structure [name]` and wants a new reusable HTML PPT deck scaffolded from the base template.

## What it does

Creates a new directory under `projects/` containing:

```
projects/<deck-name>/
├── README.md               # copied from ai-ppt-base
├── index.html              # fresh starter deck
├── ai-ppt.json             # project config for Web UI / generation
├── css/
│   └── ppt.css             # copied from ai-ppt-base
├── js/
│   └── ppt.js              # copied from ai-ppt-base
└── export/                 # generated exports (PPTX/PDF)
```

Projects can also be created from the ai-ppt Web UI (`npm run web`).

## Steps

1. **Determine deck name**
   - Use the first argument after `/ppt-structure` (e.g. `/ppt-structure q3-report` → `projects/q3-report/`).
   - If no name is provided, default to `ppt-deck`.
   - If `projects/<deck-name>` already exists, warn the user and stop (or ask to overwrite).

2. **Locate the base template**
   - Look for `ai-ppt-base/` in the current working directory.
   - Confirm it contains:
     - `css/ppt.css`
     - `js/ppt.js`
     - `README.md`
   - If `ai-ppt-base/` is missing, search one level up (`../ai-ppt-base`) or one level deep (`*/ai-ppt-base`).
   - If still missing, warn the user and stop.

3. **Create deck directory structure**
   - `mkdir -p projects/<deck-name>/css projects/<deck-name>/js`

4. **Copy reusable engine files from ai-ppt-base**
   - `cp ai-ppt-base/css/ppt.css projects/<deck-name>/css/ppt.css`
   - `cp ai-ppt-base/js/ppt.js projects/<deck-name>/js/ppt.js`
   - `cp ai-ppt-base/README.md projects/<deck-name>/README.md`

5. **Generate fresh `index.html`**
   - Create a starter deck with a cover slide, a content slide, and a thank-you slide.
   - Use placeholders like `{{TITLE}}`, `{{SUBTITLE}}`, `{{AUTHOR}}`, `{{DATE}}`, OR prompt the user for these values and substitute them immediately.
   - Link to `css/ppt.css` and `js/ppt.js` with relative paths.

6. **Create `ai-ppt.json` project config**
   - Use the `scripts/config.mjs` helper or write a JSON file with `sourceType`, `sourceUrl`, `articleText`, `params`, and `status`.
   - This config is used by the Web UI and the `scripts/generate-deck.mjs` pipeline.

7. **Report to user**
   - List created files and the path to the new deck.
   - Suggest next steps:
     - `cd projects/<deck-name>` then `/ppt-preview` to preview
     - Edit `projects/<deck-name>/index.html` to add content
     - After content is ready, run `npm run export-pptx -- <deck-name>` or `npm run export-pdf -- <deck-name>` from the repo root

## Starter index.html template

Use this structure for the new deck:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{TITLE}}</title>
  <link rel="stylesheet" href="css/ppt.css">
</head>
<body>
  <div id="app">
    <main id="stage" class="stage">
      <section class="slide active">
        <div class="slide-content" style="text-align: center;">
          <div class="kicker">{{AUTHOR}}</div>
          <h1>{{TITLE}}</h1>
          <p class="lead">{{SUBTITLE}}</p>
          <p style="font-size: 16px; opacity: 0.55; margin-top: 40px;">{{DATE}}</p>
        </div>
      </section>
      <section class="slide">
        <div class="slide-content">
          <h2>内容页标题</h2>
          <p class="lead">在这里添加核心观点。</p>
          <div class="tile">
            <h3>要点一</h3>
            <p>详细说明文字。</p>
          </div>
        </div>
      </section>
      <section class="slide">
        <div class="slide-content" style="text-align: center;">
          <div class="kicker">Thank You</div>
          <h1>谢谢</h1>
        </div>
      </section>
    </main>
    <!-- overview / help / toast / progress / hud -->
    <div id="overview" class="overview hidden">...</div>
    <div id="help" class="help">...</div>
    <div id="toast" class="toast"></div>
    <div id="progress" class="progress"></div>
    <div id="hud" class="hud"></div>
  </div>
  <script src="js/ppt.js"></script>
</body>
</html>
```

Include the full `#overview`, `#help`, `#toast`, `#progress`, and `#hud` markup copied from the base `ai-ppt-base/index.html` so the JS engine works correctly.
