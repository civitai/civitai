# Orchestrator PRD - Coordinating Sub-Ralphs

This PRD coordinates multiple sub-PRDs. Your job is NOT to implement code directly - it's to spawn, sequence, and monitor other Ralph agents.

## Key Differences

**You do NOT:**
- Commit code changes (there's no code to commit)
- Run typecheck (no code changes)
- Work on a git branch

**You DO:**
- Spawn other Ralph instances
- Manage shared state files to pass data between sub-PRDs
- Create summary reports consolidating sub-PRD outputs

## Spawning Sub-Ralphs

### Sequential (wait for completion):
```bash
node .claude/skills/ralph/ralph.mjs --prd path/to/sub-prd.json
```
This blocks until the sub-Ralph completes all its stories.

### Parallel (run in background):
Use Bash tool with `run_in_background: true`:
```bash
node .claude/skills/ralph/ralph.mjs --prd path/to/project-a/prd.json
```
Then use `TaskOutput` to wait for completion or check progress.

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
- Which sub-PRDs were spawned
- Completion status for each
- Data passed via shared state
- Any blockers encountered

## Important

- Each story typically spawns one or more sub-Ralphs
- Respect dependencies - don't start a sub-PRD until its prerequisites are done
- Document failures but continue where possible
- The sub-Ralphs handle the actual implementation/testing work
