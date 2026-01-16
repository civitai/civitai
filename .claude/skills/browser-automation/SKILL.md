---
name: browser-automation
description: Run saved browser automation flows or explore pages interactively. Use for UI testing, navigation discovery, or automating browser tasks. Flows are reusable Playwright scripts that you build through exploration.
---

# Browser Automation Skill

Explore pages interactively and save successful paths as reusable flows.

## Quick Start

### Explore a Page (Interactive REPL)
```bash
node .claude/skills/browser-automation/runner.mjs --explore https://civitai.com
```
Browser opens. Send JSON commands via stdin to interact:
```json
{"cmd": "inspect"}
{"cmd": "chunk", "label": "Click models", "code": "await page.click('a[href=\"/models\"]');"}
{"cmd": "review"}
{"cmd": "save", "name": "my-flow", "keep": [1, 2]}
{"cmd": "exit"}
```

### Run a Saved Flow
```bash
node .claude/skills/browser-automation/runner.mjs --run-flow my-flow
```

### List Saved Flows
```bash
node .claude/skills/browser-automation/runner.mjs --list-flows
```

## Exploration Workflow

The core workflow is: **Explore → Record → Curate → Save → Replay**

### 1. Start Exploration
```bash
node runner.mjs --explore https://example.com
```
- Browser opens at the URL
- Returns `session_started` with page inspection (buttons, links, inputs, screenshot)

### 2. Execute Code Chunks
```json
{"cmd": "chunk", "label": "Click login button", "code": "await page.click('button.login');"}
```
- Executes the Playwright code against the page
- Records the chunk with its label
- Returns `chunk_executed` with new page inspection

### 3. Run Existing Flows (Chaining)
```json
{"cmd": "list-flows"}
{"cmd": "flow", "name": "browse-to-model"}
```
- Runs a saved flow as a chunk
- Flow's code gets inlined into the recording
- Enables building on top of existing flows

### 4. Review & Curate
```json
{"cmd": "review"}
```
Returns all recorded chunks:
```json
{
  "type": "review",
  "chunks": [
    {"index": 1, "label": "[flow: browse-to-model]", "code": "await page.click(...)..."},
    {"index": 2, "label": "Click download", "code": "await page.click('button.download');"}
  ]
}
```

### 5. Save Selected Chunks
```json
{"cmd": "save", "name": "download-model", "keep": [1, 2]}
```
- Concatenates selected chunks into a `.js` file
- Saves to `.browser/flows/download-model.js`
- The saved flow is self-contained (no dependencies)

### 6. Exit
```json
{"cmd": "exit"}
```

## REPL Commands Reference

| Command | Description |
|---------|-------------|
| `{"cmd": "inspect"}` | Get current page state (buttons, links, inputs, screenshot) |
| `{"cmd": "chunk", "label": "...", "code": "..."}` | Execute Playwright code and record it |
| `{"cmd": "list-flows"}` | List available saved flows |
| `{"cmd": "flow", "name": "..."}` | Run a saved flow as a chunk |
| `{"cmd": "review"}` | Show all recorded chunks |
| `{"cmd": "save", "name": "...", "keep": [1,2,3]}` | Save selected chunks as a flow |
| `{"cmd": "exit"}` | Close browser and end session |

## Writing Playwright Code

Chunks execute in an async context with `page` available:

```javascript
// Click elements
await page.click('button.submit');
await page.click('a[href="/models"]');

// Type text
await page.fill('input[name="email"]', 'test@example.com');

// Wait for elements
await page.waitForSelector('h1');
await page.waitForSelector('.loading', { state: 'hidden' });

// Extract data
const title = await page.textContent('h1');
console.log('Title:', title);

// Take screenshots
await page.screenshot({ path: '/tmp/screenshot.png' });

// Navigate
await page.goto('https://example.com');
```

## Flow Chaining Example

Build complex flows by composing simpler ones:

```bash
# Session 1: Create browse-to-model flow
node runner.mjs --explore https://civitai.com
```
```json
{"cmd": "chunk", "label": "Click models", "code": "await page.click('a[href=\"/models\"]'); await page.waitForSelector('a[href^=\"/models/\"]');"}
{"cmd": "chunk", "label": "Click first model", "code": "await page.click('a[href^=\"/models/\"]'); await page.waitForSelector('h1');"}
{"cmd": "save", "name": "browse-to-model", "keep": [1, 2]}
{"cmd": "exit"}
```

```bash
# Session 2: Build on browse-to-model to create download-model flow
node runner.mjs --explore https://civitai.com
```
```json
{"cmd": "flow", "name": "browse-to-model"}
{"cmd": "chunk", "label": "Click download", "code": "await page.click('button:has-text(\"Download\")');"}
{"cmd": "save", "name": "download-model", "keep": [1, 2]}
{"cmd": "exit"}
```

Now `download-model` is self-contained with all the code inlined.

## When Flows Fail

If a chunk or flow fails during exploration, you get:
- Error message
- Current page inspection (screenshot, buttons, links, inputs)

This lets you see what's actually on the page and adjust your code.

## One-Shot Inspection (No Session)

For quick page inspection without a full session:
```bash
node runner.mjs --inspect https://example.com
```

## CLI Reference

```bash
# Exploration (interactive REPL)
node runner.mjs --explore <url>

# Run saved flow
node runner.mjs --run-flow <name>

# List flows
node runner.mjs --list-flows

# One-shot inspect
node runner.mjs --inspect <url>

# Options
--headless        Run browser without visible window
--timeout <ms>    Default timeout (default: 30000)
```

## File Locations

- **Saved flows**: `.browser/flows/*.js`
- **Session folders**: `.browser/sessions/{session-id}/`
  - `session.json` - Session metadata
  - `screenshots/` - All screenshots from the session
    - `001-session-start.png`
    - `002-chunk-click-models.png`
    - `003-flow-browse-to-model.png`
    - etc.

## Advanced Playwright Code

Since chunks execute arbitrary Playwright code, you can do anything Playwright supports:

```javascript
// Resize viewport
await page.setViewportSize({ width: 1920, height: 1080 });

// Listen to console
page.on('console', msg => console.log('CONSOLE:', msg.text()));

// Get page HTML
const html = await page.content();

// Execute JavaScript in the page
const result = await page.evaluate(() => document.title);

// Wait for network idle
await page.waitForLoadState('networkidle');

// Handle dialogs
page.on('dialog', dialog => dialog.accept());
```
