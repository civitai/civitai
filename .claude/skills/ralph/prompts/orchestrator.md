# Orchestrator PRD - Coordinating Sub-Ralphs

This PRD coordinates multiple sub-PRDs. Your job is NOT to implement code directly - it's to spawn, sequence, and monitor other Ralph agents.

## Key Differences

**You do NOT:**
- Commit code changes (there's no code to commit)
- Run typecheck (no code changes)
- Work on a git branch

**You DO:**
- Spawn other Ralph instances using the `/ralph` skill
- Manage shared state files to pass data between sub-PRDs
- Create summary reports consolidating sub-PRD outputs

## Spawning Sub-Ralphs

Use the `/ralph` skill to spawn and manage child sessions. The skill provides commands for:
- Creating and starting sessions
- Monitoring session status and logs
- Injecting guidance into running sessions
- Waiting for sessions to complete

Run `/ralph` to see all available commands and usage examples.

### Key Operations

**Spawn a child:** Create a child PRD file, then use `/ralph` to create and start a session for it.

**Monitor progress:** Check session status and logs to see what children are doing.

**Inject guidance:** If a child needs help or course correction, inject a message into their session.

**Wait for completion:** Use the wait command to block until a child reaches a significant state (completed, blocked, needs approval).

**Efficient monitoring:** Use `watch` instead of repeatedly polling status/logs. The `watch` command blocks until something significant happens (story completed, session blocked, session completed), then returns. This is much more efficient than checking logs every few seconds.

## Shared State

The PRD's `context.sharedStateFile` is a JSON file for passing data between phases:

```json
{
  "crucibleId": "abc123",
  "entryCount": 2
}
```

- **Write** to shared state after a sub-PRD produces outputs
- **Read** from shared state before running sub-PRDs that need those values

## Progress Report Additions

When logging progress, include:
- Which sub-PRDs were spawned (session IDs)
- Completion status for each
- Data passed via shared state
- Any blockers encountered

## Important

- Each story typically spawns one or more sub-Ralphs
- Respect dependencies - don't start a sub-PRD until its prerequisites are done
- Document failures but continue where possible
- The sub-Ralphs handle the actual implementation/testing work
