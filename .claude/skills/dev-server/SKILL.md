---
name: dev-server
description: Manage Next.js dev servers across worktrees. Start, stop, and read logs from dev servers. Agents can access logs from any running session, regardless of who started it.
---

# Dev Server Skill

Centralized management of Next.js dev servers across multiple git worktrees. The daemon handles port allocation, environment variable injection, and log aggregation so that any agent can access dev server logs regardless of who started the server.

## Quick Start

```bash
# Check what's running
node .claude/skills/dev-server/cli.mjs status

# Start a dev server for current worktree
node .claude/skills/dev-server/cli.mjs start

# Start for a specific worktree
node .claude/skills/dev-server/cli.mjs start /path/to/worktree

# View logs
node .claude/skills/dev-server/cli.mjs logs <session-id>

# Stop a session
node .claude/skills/dev-server/cli.mjs stop <session-id>
```

**Checking if server is ready:** After starting, poll the session status to check `ready: true`. The daemon marks sessions ready either via configured health check endpoint or by detecting "Ready" patterns in logs.

## CLI Commands

| Command | Description |
|---------|-------------|
| `status` | Check daemon status and list all sessions |
| `list` | List all dev sessions |
| `start [worktree]` | Start dev server (default: current directory) |
| `logs [session-id]` | Get logs for a session |
| `tail [session-id]` | Tail logs continuously |
| `stop <session-id>` | Stop a session |
| `restart <session-id>` | Restart a session |
| `shutdown` | Shutdown the daemon |

## Session Object

Each session includes:

```json
{
  "id": "a1b2c3d4",
  "worktree": "/path/to/worktree",
  "branch": "feature/my-feature",
  "port": 3000,
  "status": "running",
  "ready": true,
  "readyAt": "2024-01-15T10:30:02.000Z",
  "startedAt": "2024-01-15T10:30:00.000Z",
  "url": "http://localhost:3000"
}
```

Status values: `starting`, `running`, `stopped`, `crashed`, `error`

## Log Entries

```json
{
  "index": 42,
  "timestamp": "2024-01-15T10:30:05.123Z",
  "level": "stdout",
  "message": "Ready on http://localhost:3000"
}
```

Log levels: `stdout`, `stderr`, `error`, `warn`, `info`

## Notes

- The daemon starts automatically when you run CLI commands
- Sessions persist until explicitly stopped or the daemon shuts down
- Logs are kept in memory (up to 2000 lines per session)
