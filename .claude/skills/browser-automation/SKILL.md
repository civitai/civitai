---
name: browser-automation
description: Browser automation via HTTP server. Supports multiple concurrent sessions for multi-user testing, saved flows, and profile-based auth persistence.
---

# Browser Automation Skill

Explore pages interactively, build reusable flows, and test multi-user scenarios.

## Quick Start

```bash
# Start server
node .claude/skills/browser-automation/server.mjs &

# Check available profiles
curl http://localhost:9222/profiles

# Create a session
curl -X POST http://localhost:9222/sessions \
  -d '{"name": "test", "url": "http://localhost:3000", "profile": "member"}'

# Inspect the page
curl http://localhost:9222/inspect

# Execute code
curl -X POST http://localhost:9222/chunk \
  -d '{"label": "Click button", "code": "await page.click(\"button.submit\");"}'

# Shutdown
curl -X POST http://localhost:9222/exit
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/profiles` | GET | List auth profiles with descriptions |
| `/fixtures` | GET | List test fixtures (images for file uploads) |
| `/interactions` | GET | List complex component helpers |
| `/sessions` | GET | List active sessions |
| `/sessions` | POST | Create session `{ name, url, profile?, headless? }` |
| `/sessions/:name` | DELETE | Close session |
| `/flows` | GET | List saved flows (with params) |
| `/flows/:name/run` | POST | Run flow `{ profile?, startUrl?, headless?, params? }` |
| `/status` | GET | Session status |
| `/inspect` | GET | Page state + screenshot. Inputs include `label`, `role`, and `options` |
| `/chunk` | POST | Execute code `{ label, code }`. Returns `returnValue` if code returns data |
| `/fill-form` | POST | Fill form by labels `{ fields: { "Label": "value" }, fixture? }` |
| `/navigate` | POST | Navigate `{ url, fullPage? }` |
| `/console` | GET | Get console logs `?since=N&type=error` |
| `/network` | GET | Get network logs `?since=N&type=response&status=4xx` |
| `/clear-logs` | POST | Clear console and network logs |
| `/save-auth` | POST | Save auth `{ profile, description }` |
| `/review` | GET | Review recorded chunks |
| `/run-flow` | POST | Run flow in session `{ flow: "name", params? }` - debuggable |
| `/start-recording` | POST | Start recording chunks `{ id?: "my-flow" }` |
| `/stop-recording` | POST | Stop recording `{ id?: "my-flow" }` |
| `/recordings` | GET | List all recordings in session |
| `/save-flow` | POST | Save as flow `{ name, recording?: "id", chunks?: [1,2,3] }` |
| `/exit` | POST | Shutdown server |

Use `?session=name` when multiple sessions are active.

## Multi-User Testing

```bash
# Create two sessions with different profiles
curl -X POST http://localhost:9222/sessions \
  -d '{"name": "creator", "url": "http://localhost:3000", "profile": "creator"}'
curl -X POST http://localhost:9222/sessions \
  -d '{"name": "viewer", "url": "http://localhost:3000", "profile": "member"}'

# Creator does something
curl -X POST "http://localhost:9222/chunk?session=creator" \
  -d '{"label": "Publish", "code": "await page.click(\"button.publish\");"}'

# Viewer sees it
curl -X POST "http://localhost:9222/navigate?session=viewer" \
  -d '{"url": "http://localhost:3000/models"}'
```

## Profiles

```bash
# List profiles
curl http://localhost:9222/profiles

# Create new profile (description required)
curl -X POST http://localhost:9222/save-auth \
  -d '{"profile": "moderator", "description": "User with mod permissions"}'

# Refresh existing profile
curl -X POST http://localhost:9222/save-auth \
  -d '{"profile": "moderator"}'
```

| Profile | Description |
|---------|-------------|
| `moderator` | Mod permissions for content review |
| `creator` | Established user with published content |
| `member` | Standard logged-in user |
| `new-user` | Fresh account for onboarding flows |

## Form Filling

Fill forms using field labels instead of selectors:

```bash
# Fill form fields by label
curl -X POST http://localhost:9222/fill-form \
  -d '{
    "fields": {
      "Name": "Test Crucible",
      "Description": "A test description",
      "Entry Limit": "10"
    },
    "fixture": "cover-16x9.png"
  }'
```

The `/fill-form` endpoint:
- Finds inputs by their associated `<label>` text
- Falls back to `aria-label`, then `placeholder`
- Handles `<select>` elements automatically
- Optionally uploads a fixture file to file inputs

## Test Fixtures

Pre-made test images for file uploads:

```bash
# List available fixtures
curl http://localhost:9222/fixtures

# Use a fixture when filling forms
curl -X POST http://localhost:9222/fill-form \
  -d '{"fields": {}, "fixture": "cover-16x9.png"}'
```

Available fixtures in `.browser/fixtures/`:
- `cover-16x9.png` - 1280x720 cover image
- `avatar-square.png` - 512x512 avatar
- `thumbnail.png` - 300x300 thumbnail
- `banner.png` - 1200x300 banner
- `icon-64.png` - 64x64 icon

## Flows

Saved flows are reusable Playwright scripts with parameters.

```bash
# List flows (shows params)
curl http://localhost:9222/flows

# Run a flow with params
curl -X POST http://localhost:9222/flows/create-crucible/run \
  -d '{
    "profile": "member",
    "params": {
      "Name": "My Crucible",
      "Description": "Created via flow"
    }
  }'
```

### Recording Mode

Record specific sequences without capturing everything:

```bash
# Start recording a specific flow
curl -X POST http://localhost:9222/start-recording \
  -d '{"id": "create-crucible"}'

# ... do your actions ...

# Stop and see what was captured
curl -X POST http://localhost:9222/stop-recording \
  -d '{"id": "create-crucible"}'

# Save that recording as a flow
curl -X POST http://localhost:9222/save-flow \
  -d '{"name": "create-crucible", "recording": "create-crucible"}'
```

You can have multiple recordings in one session:
```bash
curl -X POST http://localhost:9222/start-recording -d '{"id": "setup"}'
# ... setup actions ...
curl -X POST http://localhost:9222/stop-recording -d '{"id": "setup"}'

curl -X POST http://localhost:9222/start-recording -d '{"id": "test"}'
# ... test actions ...
curl -X POST http://localhost:9222/stop-recording -d '{"id": "test"}'

# List all recordings
curl http://localhost:9222/recordings
```

### Saving Flows

After recording chunks, save them as a reusable flow:

```bash
# Review recorded chunks
curl http://localhost:9222/review

# Save all chunks as a flow
curl -X POST http://localhost:9222/save-flow \
  -d '{"name": "my-flow"}'

# Save specific chunks (by index)
curl -X POST http://localhost:9222/save-flow \
  -d '{"name": "my-flow", "chunks": [1, 2, 5, 6]}'
```

Flows are stored in `.browser/flows/*.js` as self-contained files with embedded `FLOW_META`.

## Inspect Output

The `/inspect` endpoint returns detailed info about page elements:

```json
{
  "inputs": [
    {
      "type": "select-one",
      "label": "Entry Limit per User",
      "labelSelector": "getByLabel('Entry Limit per User')",
      "role": "combobox",
      "value": "1",
      "options": [
        { "value": "1", "text": "1 entry", "selected": true },
        { "value": "5", "text": "5 entries", "selected": false },
        { "value": "10", "text": "10 entries", "selected": false }
      ]
    }
  ]
}
```

Key fields for identifying component types:
- `type`: DOM element type (`select-one`, `text`, `number`, etc.)
- `role`: ARIA role attribute (e.g., `combobox` for Mantine Select)
- `options`: For native `<select>` elements, lists all available options

## Debugging with Console & Network Logs

Chunks automatically capture console and network activity during execution:

```bash
# Execute a chunk - response includes logs from that execution
curl -X POST http://localhost:9222/chunk \
  -d '{"label": "Click submit", "code": "await page.click(\"button.submit\");"}'

# Response includes consoleLogs and networkLogs arrays
```

Get full logs for deeper debugging:

```bash
# Get all console logs (filter by type: log, error, warning, info)
curl "http://localhost:9222/console?type=error"

# Get network logs (filter by status: 4xx, 5xx, error, or specific code)
curl "http://localhost:9222/network?status=4xx"

# Get logs since a certain index (for incremental fetching)
curl "http://localhost:9222/console?since=50"

# Clear all logs
curl -X POST http://localhost:9222/clear-logs
```

## Playwright Code

Chunks execute with `page` available:

```javascript
await page.click('button.submit');
await page.fill('input[name="email"]', 'test@example.com');
await page.waitForSelector('h1');
await page.goto('https://example.com');
const title = await page.textContent('h1');
```

## Extracting Data

Return data from chunks to extract targeted information from pages:

```bash
# Extract specific content
curl -X POST http://localhost:9222/chunk \
  -d '{
    "label": "Get page info",
    "code": "return await page.evaluate(() => ({ title: document.querySelector(\"h1\")?.textContent, stats: Array.from(document.querySelectorAll(\".stat\")).map(s => s.textContent) }));"
  }'

# Response includes returnValue:
# { "type": "chunk_executed", "returnValue": { "title": "...", "stats": [...] }, ... }
```

This is more efficient than a generic extract - you control exactly what data you need.

## Mockup Comparison

Open local HTML mockups with `file://` URLs, then compare to live pages:

```bash
# 1. Open mockup and take full-page screenshot
curl -X POST http://localhost:9222/sessions \
  -d '{"name": "compare", "url": "file:///C:/path/to/mockup.html"}'
curl "http://localhost:9222/inspect?session=compare&fullPage=true"

# 2. Navigate to live page and screenshot
curl -X POST "http://localhost:9222/navigate?session=compare" \
  -d '{"url": "http://localhost:3000/page", "fullPage": true}'

# 3. Compare screenshots in session folder
```

## Complex Interaction Helpers

For Mantine and other complex components, use helpers from `ctx`. These are available in flows and chunks.

### Available Helpers

| Helper | Description | When to Use |
|--------|-------------|-------------|
| `mantineSelect(label, value)` | Select an option in a Mantine Select/Combobox | Input with `role="combobox"` or `mantine-Select-*` classes |

### Usage Examples

```javascript
// Mantine Select - instead of manually clicking dropdown and waiting
await ctx.mantineSelect('Entry Limit per User', '10 entries');
await ctx.mantineSelect('Category', 'Photography');
```

### Discovering Helpers Programmatically

```bash
# List all available helpers with full documentation
curl http://localhost:9222/interactions
```

### Adding New Helpers

Add new helpers in `.browser/interactions/`:
```javascript
// .browser/interactions/my-helper.js
module.exports = async function myHelper(page, arg1, arg2) {
  // ... interaction logic
};

// .browser/interactions/index.js
module.exports = {
  myHelper: {
    fn: require('./my-helper'),
    description: 'What it does',
    usage: "await ctx.myHelper('arg1', 'arg2')",
    identify: 'When to use it',
  },
};
```

## File Locations

- **Flows**: `.browser/flows/*.js` (self-contained with FLOW_META)
- **Fixtures**: `.browser/fixtures/*.png` (test images)
- **Interactions**: `.browser/interactions/*.js` (complex component helpers)
- **Profile metadata**: `.browser/profiles/profiles.meta.json`
- **Auth state**: `.browser/profiles/*.json` (gitignored)
- **Screenshots**: `.browser/sessions/{id}/screenshots/`
