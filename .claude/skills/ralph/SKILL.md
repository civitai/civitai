---
name: ralph
description: Autonomous agent for tackling big projects. Create PRDs with user stories, then run them via the CLI. Sessions persist across restarts with pause/resume and real-time monitoring.
---

# Ralph - Autonomous Agent

Ralph breaks big projects into user stories and executes them autonomously. The workflow:

1. **Create a PRD** - Define user stories with acceptance criteria
2. **Run it** - `ralph.mjs create --prd path/to/prd.json --start`
3. **Monitor** - `ralph.mjs logs <session-id> --follow`

## Creating a PRD

Create a project folder and prd.json:
```
.claude/skills/ralph/projects/<project-name>/prd.json
```

### PRD Structure

```json
{
  "description": "Brief description of the feature",
  "branchName": "feature/my-feature",
  "userStories": [
    {
      "id": "US001",
      "title": "Short descriptive title",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        "Specific testable criterion",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false
    }
  ]
}
```

### Story Guidelines

- **Priority 1**: Foundation - migrations, types, base components
- **Priority 2-3**: Core functionality
- **Priority 4+**: Secondary features, polish
- Each story should touch 1-3 files, not 10-file refactors
- Include "Typecheck passes" in acceptance criteria

## CLI Commands

The daemon starts automatically when you run any command.

### Running Sessions

```bash
# Create and start a session
ralph.mjs create --prd path/to/prd.json --start

# List all sessions
ralph.mjs list

# Check session status
ralph.mjs status <session-id>

# Follow logs in real-time
ralph.mjs logs <session-id> --follow
```

### Session Control

```bash
# Pause a session
ralph.mjs pause <session-id> --reason "Waiting for API"

# Resume with guidance
ralph.mjs resume <session-id> --guidance "API is ready on port 3000"

# Inject guidance into running session
ralph.mjs inject <session-id> --message "Try using the helper in utils.ts"

# Abort a session
ralph.mjs abort <session-id>
```

### Orchestration (Multi-Level)

For orchestrator PRDs that spawn child sessions:

```bash
# Spawn a child session
ralph.mjs spawn <parent-id> --prd child/prd.json --start

# List children of a session
ralph.mjs children <session-id>

# Wait for all children to complete
ralph.mjs wait <session-id>

# View session tree
ralph.mjs tree <session-id>

# Abort parent and all children
ralph.mjs abort <session-id> --cascade
```

## PRD Types

| Type | Use Case |
|------|----------|
| `code` (default) | Implement features, commit code |
| `orchestrator` | Coordinate multiple sub-Ralphs |
| `testing` | Browser automation testing |

Set via `"type": "orchestrator"` in prd.json.

## Full CLI Reference

Run `ralph.mjs --help` for complete documentation.
