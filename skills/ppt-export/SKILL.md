---
name: ppt-export
description: Export an ai-ppt HTML deck to PDF or PPTX. In the Web UI, this skill is bound to Ctrl+P / Cmd+P.
metadata: { "tags": "ppt, export, pdf, pptx, ai-ppt" }
---

# /ppt-export

Use this skill when the user wants to export an ai-ppt deck as PDF or PPTX.

## Syntax

```
/ppt-export <deck> pdf          # Export the deck as PDF
/ppt-export <deck> pptx         # Export the deck as editable PPTX
/ppt-export <deck> pptx-image   # Export the deck as high-res image PPTX
/ppt-export pdf                 # Export the current directory deck as PDF
/ppt-export pptx                # Export the current directory deck as PPTX
/ppt-export pptx-image          # Export the current directory deck as image PPTX
```

## What it does

1. Locates the deck in `projects/<deck>/` or the current working directory.
2. For **PDF**:
   - Uses `puppeteer-core` and auto-detected system Chrome to print `projects/<deck>/export/deck.pdf`.
   - Falls back to opening the deck preview in the browser and instructing the user to press `Ctrl+P` / `Cmd+P` (or the `↓` key) and choose "Save as PDF".
3. For **PPTX**:
   - Runs `npm run export-pptx -- <deck>` to produce `projects/<deck>/export/deck.pptx` (editable text, approximate layout).
4. For **PPTX (image)**:
   - Runs `npm run export-pptx-image -- <deck>` to produce `projects/<deck>/export/deck-image.pptx` (high-res screenshots of the final slide state, highest fidelity).
5. Reports the exported file path or download URL.

## Steps

1. **Locate the deck**
   - If a deck name is provided, use `projects/<deck>/index.html`.
   - Otherwise, use `./index.html` in the current directory.
2. **Export PDF**
   - Run `npm run export-pdf -- <deck>`.
   - If the command succeeds, report `projects/<deck>/export/deck.pdf`.
   - If Chrome is missing or `puppeteer-core` is not installed, fall back to browser print.
3. **Export PPTX / PPTX image**
   - Ensure dependencies are installed (`npm install`).
   - Run `npm run export-pptx -- <deck>` or `npm run export-pptx-image -- <deck>`.
   - Confirm the output file exists under `projects/<deck>/export/`.
4. **Report**
   - Show the file path and a download link if the web server is running.

## Web UI shortcut

In the ai-ppt Web UI (`npm run web`), pressing `Ctrl+P` / `Cmd+P` opens an export panel with:
- **PDF**: downloads `deck.pdf` when server-side export is available; otherwise opens the preview for browser print.
- **PPTX (editable)**: downloads `deck.pptx`.
- **PPTX (high-res image)**: downloads `deck-image.pptx`.

## Do not

- Do not install Puppeteer automatically without confirming with the user (it is heavy). `puppeteer-core` is already declared as a dependency in this repo.
- Do not overwrite existing export files without warning.
