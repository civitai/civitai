# Civitai Markdown Importer

Loads a `.md` file into the Civitai article editor from the browser toolbar.

## Install (Chrome / Edge, unpacked)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select this directory
4. Pin the extension so the toolbar button is visible

## Use

Open an article **Create** or **Edit** page, click the toolbar button, pick a `.md` file.

## How it works

The extension dispatches a synthetic `paste` event carrying the **raw markdown** as
`text/plain`. The page's own paste handler (`RichTextEditorComponent.tsx`) detects markdown
source and converts it via `src/utils/markdown-to-editor-html.ts`.

That means no markdown parser ships here, and the extension cannot disagree with the
conversion the site applies on save. It also means the extension only works where the editor
enables the `markdown` control — currently the article editor.

If the synthetic paste is rejected, the markdown is copied to the clipboard instead and the
popup tells you to press Cmd/Ctrl+V.

## Limits

Conversion is bounded by `DEFAULT_ALLOWED_TAGS` in `src/utils/html-sanitize-helpers.ts`, which
the server applies on save. An extension cannot widen it. Today that means tables become code
blocks and blockquotes become italic text — see the converter for the full list.
