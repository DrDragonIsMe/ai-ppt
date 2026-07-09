---
name: ppt-preview
description: Preview the HTML-based PPT in the current project or a named deck. Starts a local static HTTP server and opens the default browser, or falls back to a headless screenshot / manual URL when no GUI browser is available.
metadata: { "tags": "ppt, preview, html, test, ai-ppt-base" }
---

# /ppt-preview

Use this skill when the user types `/ppt-preview` in Claude CLI / Kimi CLI and wants to see an HTML PPT deck rendered.

## Syntax

```
/ppt-preview              # preview current directory or auto-detected deck
/ppt-preview <deck-name>  # preview a specific deck directory
/ppt-preview ai-ppt-base  # preview the base template
```

## What it does

1. Detects the PPT project layout (`index.html`, `css/ppt.css`, `js/ppt.js`).
2. Starts a local static HTTP server in the selected deck directory.
3. Opens `http://localhost:<port>/index.html` in the default browser.
4. If opening a browser fails, falls back to a headless screenshot or prints the preview URL for the user to open manually.

When using the ai-ppt Web UI (`npm run web`), generating a deck automatically opens the preview in a new browser tab. Inside the preview, press `Ctrl+P` / `Cmd+P` (or `↓`) to open the export panel for PDF / PPTX downloads.

## Steps

1. **Locate the deck**
   - If the user provides a deck name (e.g. `/ppt-preview q3-report`), look for `projects/<deck-name>/index.html` first.
   - If not found, fall back to `<deck-name>/index.html` in the current working directory or as a sibling of `ai-ppt-base/` for backward compatibility.
   - If no name is provided:
     - Look for `index.html` in the current working directory.
     - If not found, search `projects/*/index.html`.
     - If `ai-ppt-base/index.html` is found, also check for project deck directories (`projects/<name>/index.html`) and prefer the project deck (ask if more than one exists).
   - Confirm the selected project has `css/ppt.css` and `js/ppt.js`; if not, warn the user that this may not be an HTML-PPT project.
   - `cd` into the selected deck directory before starting the server.

2. **Pick a free port**
   - Default port: `8765`.
   - If occupied, try `8766`, `8767`, etc.

3. **Start the server**
   - Prefer: `python3 -m http.server <port>`
   - Alternative if Python unavailable: `npx serve -l <port>`
   - Run it as a background task so the conversation can continue.

4. **Open the browser**
   - macOS: `open http://localhost:<port>/index.html`
   - Linux: `xdg-open http://localhost:<port>/index.html`
   - Windows (WSL/Cygwin): `start http://localhost:<port>/index.html`
   - If the `open`/`xdg-open` command fails or no GUI is detected, fall back to headless screenshot:
     - If `npx playwright` is available, capture a full-page screenshot of `http://localhost:<port>/index.html` to `/tmp/ppt-preview.png` and report the path.
     - Otherwise, print the URL and ask the user to open it manually.

5. **Report to user**
   - State the project directory, server port, and preview URL.
   - Mention keyboard shortcuts: `→` next, `←` prev, `F` fullscreen, `↑` overview, `↓` export PDF.
   - If running headless screenshot, show the screenshot file path.

## Cleanup

- Do NOT stop the background server automatically; leave it running so the user can refresh the browser.
- If the user later asks to stop the preview, use the background task ID or `pkill -f "http.server <port>"` to terminate it.
