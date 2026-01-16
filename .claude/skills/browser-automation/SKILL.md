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
| `/sessions` | GET | List active sessions |
| `/sessions` | POST | Create session `{ name, url, profile?, headless? }` |
| `/sessions/:name` | DELETE | Close session |
| `/flows` | GET | List saved flows |
| `/flows/:name/run` | POST | Run flow `{ profile?, startUrl?, headless? }` |
| `/status` | GET | Session status |
| `/inspect` | GET | Page state + screenshot. Add `?fullPage=true` for full-page screenshot |
| `/chunk` | POST | Execute code `{ label, code }` |
| `/navigate` | POST | Navigate `{ url, fullPage? }`. Set `fullPage: true` for full-page screenshot |
| `/save-auth` | POST | Save auth `{ profile, description }` |
| `/review` | GET | Review recorded chunks |
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

## Flows

Saved flows are reusable Playwright scripts.

```bash
# List flows
curl http://localhost:9222/flows

# Run a flow
curl -X POST http://localhost:9222/flows/my-flow/run \
  -d '{"profile": "member"}'

# Run with custom start URL
curl -X POST http://localhost:9222/flows/my-flow/run \
  -d '{"profile": "member", "startUrl": "http://localhost:3000"}'
```

Flows are stored in `.browser/flows/*.js`.

## Playwright Code

Chunks execute with `page` available:

```javascript
await page.click('button.submit');
await page.fill('input[name="email"]', 'test@example.com');
await page.waitForSelector('h1');
await page.goto('https://example.com');
const title = await page.textContent('h1');
```

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

## File Locations

- **Flows**: `.browser/flows/*.js`
- **Profile metadata**: `.browser/profiles/profiles.meta.json`
- **Auth state**: `.browser/profiles/*.json` (gitignored)
- **Screenshots**: `.browser/sessions/{id}/screenshots/`
