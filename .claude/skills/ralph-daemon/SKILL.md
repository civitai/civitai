---
name: ralph-daemon
description: HTTP daemon that hosts multiple autonomous Ralph agent sessions with real-time monitoring, pause/resume control, and guidance injection. Use when you need to run, monitor, or control autonomous agents programmatically.
---

# Ralph Daemon

An HTTP server that transforms Ralph from a CLI tool into an interactive, controllable service. Host multiple concurrent agent sessions, monitor them in real-time via WebSocket, and intervene with pause/resume/inject commands.

## Prerequisites

The daemon works with zero dependencies but WebSocket support requires:

```bash
npm install ws
```

Without `ws`, the daemon runs without real-time streaming (polling via `/api/sessions/:id/logs` still works).

## Quick Start

### Start the Daemon

```bash
node .claude/skills/ralph-daemon/server.mjs
```

The daemon starts on `localhost:9333` by default.

### Create and Run a Session

```bash
# Create a session
curl -X POST http://localhost:9333/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"prd": ".claude/skills/ralph/projects/my-feature/prd.json"}'

# Response: { "session": { "id": "my-feature-a1b2c3d4", ... } }

# Start the session
curl -X POST http://localhost:9333/api/sessions/my-feature-a1b2c3d4/start
```

### Web UI

Open `http://localhost:9333` in your browser for a visual dashboard.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Ralph Daemon (HTTP Server)                    │
│                        localhost:9333                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│   │   Session    │  │    Turn      │  │   Command    │          │
│   │   Manager    │  │   Engine     │  │    Queue     │          │
│   │              │  │              │  │              │          │
│   │  - Create    │  │  - Execute   │  │  - Pause     │          │
│   │  - List      │  │  - Checkpoint│  │  - Resume    │          │
│   │  - Destroy   │  │  - Broadcast │  │  - Inject    │          │
│   └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                  │
│   ┌────────────────────────────────────────────────────┐        │
│   │               Active Sessions                       │        │
│   │                                                     │        │
│   │  Session "feature-abc123"   Session "test-xyz789"  │        │
│   │  ├─ Status: RUNNING         ├─ Status: PAUSED      │        │
│   │  ├─ Story: US-003           ├─ Story: TEST-001     │        │
│   │  └─ Turn: 23/100            └─ Waiting for input   │        │
│   └────────────────────────────────────────────────────┘        │
│                                                                  │
│   ┌────────────────────────────────────────────────────┐        │
│   │                    Storage                          │        │
│   │  SQLite: sessions.db (logs, turns, metrics)        │        │
│   │  Files: PRD, progress.txt (git-tracked)            │        │
│   └────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## API Reference

### Session Management

#### Create Session

```http
POST /api/sessions
Content-Type: application/json

{
  "prd": "path/to/prd.json",
  "name": "optional-name",
  "model": "sonnet",         // opus, sonnet, haiku
  "maxTurns": 100,
  "workingDirectory": "path/to/project",
  "autoStart": false
}
```

**Response:**
```json
{
  "type": "session_created",
  "session": {
    "id": "my-feature-a1b2c3d4",
    "name": "my-feature",
    "status": "CREATED",
    "storiesTotal": 5
  }
}
```

#### List Sessions

```http
GET /api/sessions
GET /api/sessions?active=true
GET /api/sessions?status=RUNNING,PAUSED
```

#### Get Session Status

```http
GET /api/sessions/:id
```

**Response:**
```json
{
  "id": "my-feature-a1b2c3d4",
  "status": "RUNNING",
  "health": "HEALTHY",
  "currentStory": { "id": "US-003", "title": "Add user profile" },
  "progress": {
    "storiesCompleted": 2,
    "storiesTotal": 5,
    "turnCount": 23,
    "maxTurns": 100
  }
}
```

#### Destroy Session

```http
DELETE /api/sessions/:id
```

---

### Session Control

#### Start Session

```http
POST /api/sessions/:id/start
```

#### Pause Session

```http
POST /api/sessions/:id/pause
Content-Type: application/json

{
  "source": "monitoring-agent",
  "reason": "Need to start dev server"
}
```

**Response includes `lockToken`** - save this to resume:
```json
{
  "type": "pause_requested",
  "lockToken": "abc123..."
}
```

#### Resume Session

```http
POST /api/sessions/:id/resume
Content-Type: application/json

{
  "source": "monitoring-agent",
  "lockToken": "abc123...",
  "guidance": "The dev server is now running on localhost:3000.",
  "guidanceType": "ENVIRONMENT_UPDATE"
}
```

Or force resume without token:
```json
{
  "source": "human-override",
  "force": true
}
```

#### Inject Guidance

Queue guidance for the next turn without pausing:

```http
POST /api/sessions/:id/inject
Content-Type: application/json

{
  "content": "Remember to add error handling for the API call.",
  "type": "HINT",
  "source": "code-reviewer",
  "priority": "NORMAL"
}
```

**Guidance Types:**
- `CORRECTION` - Critical fix, agent must change approach
- `HINT` - Helpful suggestion
- `NEW_REQUIREMENT` - Additional requirement added
- `ENVIRONMENT_UPDATE` - Environment has changed

#### Abort Session

```http
POST /api/sessions/:id/abort
Content-Type: application/json

{
  "source": "monitoring-agent"
}
```

#### Skip Current Story

```http
POST /api/sessions/:id/skip
Content-Type: application/json

{
  "source": "human",
  "reason": "Story depends on blocked feature"
}
```

---

### Monitoring

#### Get Logs

```http
GET /api/sessions/:id/logs
GET /api/sessions/:id/logs?limit=50&since=2024-01-15T10:00:00Z
```

#### Get Turn History

```http
GET /api/sessions/:id/turns?limit=50
```

**Response:**
```json
{
  "turns": [
    {
      "turnNumber": 23,
      "storyId": "US-003",
      "toolName": "Edit",
      "toolInput": "{\"file_path\": \"...\"}",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

#### Get PRD

```http
GET /api/sessions/:id/prd
```

#### Live Log Stream (WebSocket)

```javascript
const ws = new WebSocket('ws://localhost:9333/api/sessions/:id/stream');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.event, data);
  // Events: log, text, toolUse, storyStarted, storyCompleted, paused, resumed, completed, etc.
};
```

---

### Checkpoints & Time Travel

#### List Checkpoints

```http
GET /api/sessions/:id/checkpoints
```

#### Restore to Checkpoint

```http
POST /api/sessions/:id/restore
Content-Type: application/json

{
  "turnNumber": 15,
  "source": "human"
}
```

---

### Sensitive Operations

When Ralph attempts sensitive operations (git push, destructive commands), the session auto-pauses with `WAITING_APPROVAL` status.

#### Approve Operation

```http
POST /api/sessions/:id/approve
Content-Type: application/json

{ "source": "human" }
```

#### Reject Operation

```http
POST /api/sessions/:id/reject
Content-Type: application/json

{
  "source": "human",
  "reason": "Don't push to main branch"
}
```

---

## Session States

```
CREATED ──start()──► RUNNING ◄──resume()── PAUSED
                        │                     │
                        │                     │ pause()
                        │                     │
                   abort()│              ┌────┘
                        │              │
                        ▼              ▼
                    ABORTED        WAITING
                        │         (external event)
                        │
                        └──► COMPLETED (all stories done)
```

| State | Description |
|-------|-------------|
| `CREATED` | Session created, not yet started |
| `RUNNING` | Actively executing turns |
| `PAUSED` | Paused between turns, waiting for resume |
| `WAITING` | Waiting for external event |
| `WAITING_APPROVAL` | Sensitive operation needs approval |
| `ABORTED` | Forcefully stopped |
| `COMPLETED` | All stories finished |

---

## Health States

The daemon monitors session health:

| Health | Description |
|--------|-------------|
| `HEALTHY` | Normal operation |
| `DEGRADED` | Errors encountered but recovering |
| `STUCK` | Repeated failures, likely needs intervention |
| `CRITICAL` | Cannot proceed without intervention |

---

## Usage Examples

### Monitoring Agent Workflow

```javascript
// 1. Start a session
const session = await fetch('http://localhost:9333/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prd: '.claude/skills/ralph/projects/my-feature/prd.json',
    model: 'opus',
    maxTurns: 100
  })
}).then(r => r.json());

// 2. Start execution
await fetch(`http://localhost:9333/api/sessions/${session.session.id}/start`, {
  method: 'POST'
});

// 3. Monitor via WebSocket
const ws = new WebSocket(`ws://localhost:9333/api/sessions/${session.session.id}/stream`);
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.health === 'STUCK') {
    // Intervene
  }
};

// 4. Intervene when needed
const pauseResult = await fetch(`http://localhost:9333/api/sessions/${session.session.id}/pause`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'monitoring-agent' })
}).then(r => r.json());

// 5. Fix issue...

// 6. Resume with guidance
await fetch(`http://localhost:9333/api/sessions/${session.session.id}/resume`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    lockToken: pauseResult.lockToken,
    guidance: 'The dev server is now running. Continue with your task.',
    guidanceType: 'ENVIRONMENT_UPDATE'
  })
});
```

### Running Multiple Sessions

```bash
# Create sessions for different features
curl -X POST http://localhost:9333/api/sessions -H "Content-Type: application/json" \
  -d '{"prd": "projects/feature-a/prd.json", "autoStart": true}'

curl -X POST http://localhost:9333/api/sessions -H "Content-Type: application/json" \
  -d '{"prd": "projects/feature-b/prd.json", "autoStart": true}'

# List all active
curl http://localhost:9333/api/sessions?active=true
```

---

## Configuration

### Command Line Options

```bash
node server.mjs --port 9333 --host localhost
```

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 9333 | Port to listen on |
| `--host` | localhost | Host to bind to |

### Storage

- **SQLite Database**: `.claude/skills/ralph-daemon/data/sessions.db`
  - Session metadata, turn history, logs, checkpoints
  - Ephemeral debugging data (not committed to git)

- **Files**: PRD directory
  - `prd.json` - PRD file (git-tracked)
  - `progress.txt` - Progress log (git-tracked)

---

## Files

```
.claude/skills/ralph-daemon/
├── server.mjs          # Main HTTP server
├── session-manager.mjs # Session lifecycle management
├── turn-engine.mjs     # Turn-by-turn execution
├── storage.mjs         # SQLite + file storage
├── ui.html             # Web dashboard
├── SKILL.md            # This documentation
└── data/
    └── sessions.db     # SQLite database (auto-created)
```

---

## Integration with Existing Ralph

The daemon uses the same prompt templates as the CLI Ralph:
- `.claude/skills/ralph/prompts/base.md`
- `.claude/skills/ralph/prompts/code.md`
- etc.

PRDs and progress files remain in the same locations and format.

---

## Troubleshooting

### Session Not Starting

1. Check PRD path is correct and exists
2. Verify prompt templates exist in ralph/prompts/
3. Check daemon logs for errors

### WebSocket Not Connecting

1. Ensure you're using the correct session ID
2. Check CORS if connecting from different origin
3. Verify session is active (not COMPLETED/ABORTED)

### Session Stuck

1. Check session health via API
2. Pause session and inject corrective guidance
3. Use checkpoints to restore to earlier state
4. Abort and restart if necessary

### Cleanup Old Sessions

```bash
curl -X POST http://localhost:9333/api/cleanup \
  -H "Content-Type: application/json" \
  -d '{"olderThanDays": 7}'
```
