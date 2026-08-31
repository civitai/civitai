# ClickUp Skill Reference

Supporting detail for [SKILL.md](SKILL.md). Read the section you need rather than the whole file.


## Output Format

### Task Details

```
Task: Implement user authentication
ID: 86a1b2c3d
Status: In Progress
Priority: High
Assignees: John Doe, Jane Smith
Watchers: 2
Due: Jan 15, 2024
Start: Jan 10, 2024
Time Estimate: 4h
Created: Jan 10, 2024
URL: https://app.clickup.com/t/86a1b2c3d
List: Sprint Backlog
Folder: Development
Space: 20128955

Description:
Add OAuth2 authentication with Google and GitHub providers...
```

### Task List

```
[to do] Fix login bug
  ID: 868h2cxat | Priority: high | Assignees: John Doe
  https://app.clickup.com/t/868h2cxat

[in progress] Update API docs
  ID: 868g7c75u | Priority: None | Assignees: Jane Smith
  https://app.clickup.com/t/868g7c75u

Total: 2 task(s)
```

### Comments

```
[2024-01-12 14:30] John Doe:
  Started working on this. Will push initial commit today.

[2024-01-12 16:45] Jane Smith:
  @John looks good! Let me know when ready for review.
```

### Doc Details

```
Doc: API Documentation
ID: abc123def
Created: Jan 10, 2024, 09:30 AM
Updated: Jan 15, 2024, 02:45 PM
Creator: John Doe
Workspace: 12345678

Pages:
Introduction
  ID: page001

Getting Started
  ID: page002

API Reference
  ID: page003

Total: 3 page(s)
```

### Page Content

```
Page: Getting Started
ID: page002
Created: Jan 10, 2024, 10:00 AM
Updated: Jan 14, 2024, 03:30 PM

Content:
---
# Getting Started

Welcome to the API documentation.

## Prerequisites
- Node.js 18+
- An API key
---
```
## Technical Notes

### Markdown Handling

ClickUp uses different content formats for different features:

| Feature | API Version | Content Format |
|---------|-------------|----------------|
| Comments | v2 | Proprietary JSON array (converted via `markdownToClickUp()`) |
| Task descriptions | v2 | Native markdown via `markdown_description` field |
| Docs/Pages | v3 | Native markdown (no conversion needed) |

The Docs API (v3) accepts and returns markdown directly, so no conversion is required. Task comments use a proprietary JSON array format that requires the `lib/markdown.mjs` conversion utilities.

### @Mentions

Comments support two mention syntaxes. The pipeline (`lib/mentions.mjs`):

1. **Phase 1 — Explicit**: Extract `@[identifier]` patterns, resolve via fuzzy matching
2. **Phase 2 — Bare**: Detect remaining `@Name` patterns, match against workspace member usernames
3. **Convert** markdown to ClickUp's JSON array format
4. **Inject** mention attributes (`{"text": "@DisplayName", "attributes": {"mention": userId}}`)

Explicit `@[identifier]` supports:
- **Partial name**: `@[justin]` → fuzzy matches "Justin Maier"
- **Email**: `@[jane@co.com]` → matches by email
- **User ID**: `@[10620972]` → direct numeric ID

Bare `@Name` auto-detection:
- Matches `@First Last` or `@First` against workspace members (case-insensitive)
- Tries full username first, then first name only
- Unmatched bare mentions are left as plain text (no error, no API call wasted)
- This is a **safety net** for agents that forget bracket syntax

If an explicit `@[identifier]` can't be matched, an error is thrown. Bare mentions fail silently.

### Doc Page Structure

When you create a doc via the API, ClickUp automatically creates an empty first page. This has implications:

- **`create-doc`** - Creates a doc with an auto-generated first page. Use `--content` to populate that first page.
- **`create-page`** - Adds an *additional* page to a doc (second page, third page, etc.)
- **`edit-page`** - Modifies an existing page's content

To add content to a new doc, use `create-doc "Title" --content "..."` rather than creating the doc and then using `create-page` (which would leave the first page empty).

### Pagination

All list endpoints now automatically paginate through all results:
- Task lists: Page-based (100 per page)
- Comments: Cursor-based (25 per page)
- Docs search: Cursor-based (returns `{ docs, nextCursor }`)

Rate limiting is handled automatically with retry and backoff (max 2 retries).

## Testing

Smoke tests verify all commands against the live ClickUp API.

```bash
# Full test suite (creates test resources, validates, cleans up)
node test/smoke-test.mjs

# Read-only tests (safe, no writes)
node test/smoke-test.mjs --readonly

# Verbose output (shows details on failures)
node test/smoke-test.mjs --verbose
```

When adding new features, add corresponding tests to `test/smoke-test.mjs`.

## Webhook Watchers (Event Monitoring)

Watch ClickUp tasks, lists, or spaces for real-time events via webhooks. Uses webhook.site as a public relay — no external infrastructure needed.

### Setup

Add your webhook.site token to `accounts.json`:

```json
{
  "webhookSiteToken": "your-uuid-from-webhook.site",
  "defaultAccount": "bot",
  "accounts": { ... }
}
```

Requires `@webhooksite/cli` (`whcli`) for live forwarding: `npm install -g @webhooksite/cli`

### Commands

```bash
# Watch a task (or multiple tasks) for events
node query.mjs watch-task <task_id>
node query.mjs watch-task <id1>,<id2>,<id3>
node query.mjs watch-task <task_id> --events taskStatusUpdated,taskCommentPosted

# Watch a list or space
node query.mjs watch-list <list_id>
node query.mjs watch-space <space_id>

# List active watchers (local registry)
node query.mjs watchers

# List all webhooks in workspace (from ClickUp API)
node query.mjs webhooks

# Remove a specific watcher
node query.mjs unwatch-webhook <webhook_id>

# Remove all watchers
node query.mjs unwatch-webhook --all
```

### Listener

The listener receives webhook events via webhook.site forwarding. Run as a background task:

```bash
# Wait mode (default): receive one event, print it, exit
node listen.mjs --timeout 600

# Server mode: stay running, log all events
node listen.mjs --mode server

# Options
node listen.mjs --port 3458 --timeout 300 --mode wait
```

### Listener Filters

Filter events so the listener only wakes the agent for relevant changes:

```bash
# Only deliver when a task moves to "qa review" status
node listen.mjs --filter-status "qa review"

# Only deliver comment events (ignore status changes etc.)
node listen.mjs --filter-event taskCommentPosted

# Only deliver events for a specific task
node listen.mjs --filter-task 868abc123

# Combine filters
node listen.mjs --filter-status "complete,qa review" --filter-event taskStatusUpdated

# Multiple values are comma-separated
node listen.mjs --filter-status "in review,ready for qa"
```

Filter behavior:
- `--filter-status` — For `taskStatusUpdated` events, only deliver if the *new* status matches. Non-status events pass through unaffected.
- `--filter-event` — Only deliver events of this type. Comma-separated for multiple.
- `--filter-task` — Only deliver events for this task ID. Comma-separated for multiple.
- Filtered events are still logged to `webhooks.jsonl` and update the cursor, but don't trigger delivery to the agent.
- Always returns 200 OK to ClickUp (even for filtered events) to keep the webhook healthy.

### Agent Workflow

Typical agent usage pattern:

```bash
# 1. Set up a watcher
node query.mjs watch-task 868abc123 --events taskStatusUpdated,taskCommentPosted

# 2. Start listener as background task (run_in_background=true)
node listen.mjs --timeout 600

# 3. Agent continues other work...

# 4. When event arrives, background task exits with the event JSON
# Agent reads webhook-latest.json or parses stdout

# 5. Restart listener if more events expected
node listen.mjs --timeout 600

# 6. Clean up when done
node query.mjs unwatch-webhook --all
```

### Default Events

| Command | Default Events |
|---------|---------------|
| watch-task | taskStatusUpdated, taskCommentPosted, taskUpdated, taskAssigneeUpdated, taskDueDateUpdated |
| watch-list | taskCreated, taskStatusUpdated, taskCommentPosted, taskUpdated, taskDeleted |
| watch-space | taskCreated, taskStatusUpdated, taskCommentPosted, taskUpdated, taskDeleted, listCreated, listUpdated, listDeleted |

Override defaults with `--events evt1,evt2,...`

### Event Payload

Events are saved to:
- `webhook-latest.json` — Most recent event (pretty-printed)
- `webhooks.jsonl` — Append-only log of all events
- `last-seen.txt` — Timestamp cursor for catch-up

The listener checks for missed events on startup (via webhook.site API), so gaps between listener restarts are handled automatically.

### Available Event Types

Task events: `taskCreated`, `taskUpdated`, `taskDeleted`, `taskPriorityUpdated`, `taskStatusUpdated`, `taskAssigneeUpdated`, `taskDueDateUpdated`, `taskTagUpdated`, `taskMoved`, `taskCommentPosted`, `taskCommentUpdated`, `taskTimeEstimateUpdated`, `taskTimeTrackedUpdated`, `taskAttachmentUploaded`, `taskCustomFieldUpdated`

List/folder/space events: `listCreated`, `listUpdated`, `listDeleted`, `folderCreated`, `folderUpdated`, `folderDeleted`, `spaceCreated`, `spaceUpdated`, `spaceDeleted`

## Task Watcher (polling)

`watch.mjs` is a **self-contained, polling-based** watcher for a single task (or
every task in a list). It snapshots the task's baseline, polls the ClickUp API
on an interval, and **exits 0 the moment a watched change is detected** — printing
a concise JSON of what changed. Run it with `run_in_background=true` and the
parent agent gets a task-notification when it exits.

Unlike the webhook watchers above (`watch-task` / `listen.mjs`), this needs **no
webhook.site account and no `whcli`** — it works anywhere the API token works.
Prefer it as the default; reach for the webhook path only when you need
real-time, sub-second latency or workspace-wide event streams.

### Usage

```bash
# Watch a single task (id or URL) for status / comment / assignee changes
node watch.mjs 868kjbyvu
node watch.mjs "https://app.clickup.com/t/868kjbyvu"

# Watch every task in a list (tracks status/assignee changes + task created/deleted)
node watch.mjs --list 901111220963

# Wake only when the task reaches one of these statuses
node watch.mjs 868kjbyvu --until-status "in progress,complete"

# Only wake on specific change types
node watch.mjs 868kjbyvu --on comments
node watch.mjs 868kjbyvu --on status,assignee

# Tune cadence + lifetime, and mirror the latest change to a state file
node watch.mjs 868kjbyvu --timeout 3600 --interval 45 --state-file ./watch-latest.json

# Target a specific account
node watch.mjs 868kjbyvu --account justin
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `<taskId\|url>` | — | Positional. The task to watch (id or any task URL). |
| `--list <id\|url>` | — | Watch all tasks in a list instead of a single task. |
| `--timeout <sec>` | `3600` | Max seconds to watch before exiting with a `timeout` result. |
| `--interval <sec>` | `45` | Poll cadence (min 10 — be gentle on rate limits). |
| `--on <types>` | `status,comments,assignee` | Comma list of change types that wake it. |
| `--until-status <list>` | — | Only wake when the task reaches one of these statuses (implies `--on status`). |
| `--account <name>` | default | Named account from `accounts.json`. |
| `--state-file <path>` | — | Optional. Writes baseline + latest change JSON here (mirrors the webhook `webhook-latest.json` idea). |

### What it detects

- **status** — task status changed (`{from, to}`).
- **comments** — new comment posted (latest comment id / count moved). *(single-task mode only; list mode skips per-task comment fetches to stay gentle on the API.)*
- **assignee** — assignees added/removed.
- **list mode** also reports `taskCreated` / `taskDeleted`.

### Exit behavior

- **Change detected** → prints `{"event":"change", ...}` and exits `0`.
- **Timed out** → prints `{"event":"timeout", ...}` and exits `0`.
- **Fatal config error** (bad id, no auth) → prints `ERROR:` and exits `1`.

API/network/rate-limit errors during polling never crash the loop — they log to
stderr and back off exponentially (capped at 60s), then keep polling.

### Agent workflow

```bash
# 1. Start the watcher as a background task (run_in_background=true)
node watch.mjs 868kjbyvu --until-status "in review" --timeout 3600

# 2. Agent continues other work...

# 3. When the task hits "in review", the background task exits 0 and the agent
#    is notified. Read the printed JSON (or --state-file) to see what changed:
#    {"event":"change","changes":[{"type":"status","from":"in progress","to":"in review"}], ...}

# 4. Act on it, then re-arm the watcher if more changes are expected:
node watch.mjs 868kjbyvu --until-status "complete" --timeout 3600
```

The change JSON includes the task URL, the fresh snapshot (status, assignees,
comment count), and `elapsedSec`, so the agent can act without an extra `get`.

## Batch Task Creation (Project Setup)

Create an entire project's tasks from a single JSON file. Supports names, descriptions, assignments, priorities, subtasks, tags, dates, and inter-task dependencies.

### Usage

```bash
# Create tasks from a JSON plan
node query.mjs batch-create --file plan.json

# Preview without creating (dry run)
node query.mjs batch-create --file plan.json --dry-run

# JSON output for programmatic use
node query.mjs batch-create --file plan.json --json
```

### JSON Plan Schema

```json
{
  "listId": "901111220963",
  "tasks": [
    {
      "ref": "design",
      "name": "Design system architecture",
      "description": "Create the high-level architecture document",
      "assignee": "justin",
      "priority": "high",
      "status": "to do",
      "dueDate": "+7d",
      "startDate": "today",
      "tags": ["architecture", "phase-1"],
      "subtasks": [
        { "name": "Draft ERD", "assignee": "mark" },
        { "name": "Review ERD", "assignee": "dakota" }
      ]
    },
    {
      "ref": "implement",
      "name": "Implement core modules",
      "assignee": "mark",
      "priority": "normal",
      "dependsOn": ["design"],
      "subtasks": [
        { "name": "Build data layer" },
        { "name": "Build API endpoints" },
        { "name": "Write unit tests" }
      ]
    },
    {
      "ref": "qa",
      "name": "QA validation",
      "assignee": "dakota",
      "dependsOn": ["implement"],
      "subtasks": [
        { "name": "Integration tests" },
        { "name": "Performance testing" }
      ]
    }
  ]
}
```

### Plan Fields

| Field | Type | Description |
|-------|------|-------------|
| `ref` | string | Local reference ID for wiring dependencies between tasks |
| `name` | string | Task title (required) |
| `description` | string | Markdown description |
| `assignee` | string | Name, email, or user ID |
| `priority` | string | urgent, high, normal, low, none |
| `status` | string | Status name (must match list's available statuses) |
| `dueDate` | string | Absolute date or relative (+3d, +1w, tomorrow) |
| `startDate` | string | Same format as dueDate |
| `tags` | string[] | Tag names to apply |
| `listId` | string | Override the default listId for this task |
| `dependsOn` | string[] | Refs of tasks that must complete first |
| `blocks` | string[] | Refs of tasks this one blocks |
| `subtasks` | object[] | Array of { name, description, assignee, status } |

### How Dependencies Work

Use `ref` as a local identifier, then reference it in `dependsOn` or `blocks`:

```json
{
  "tasks": [
    { "ref": "a", "name": "Task A", "blocks": ["b"] },
    { "ref": "b", "name": "Task B", "dependsOn": ["a"] }
  ]
}
```

Both `blocks` and `dependsOn` create the same ClickUp dependency — choose whichever reads more naturally. Tasks are created first, then dependencies are wired up in a second pass.

## Team Workflow Patterns

### Pattern 1: Team Lead Sets Up Project

The team lead creates the entire project plan as JSON, then batch-creates it:

```bash
# 1. Write the plan (or have the agent generate it)
# 2. Create all tasks in one shot
node query.mjs batch-create --file project-plan.json

# 3. Set up watchers on the list
node query.mjs watch-list <list_id> --events taskStatusUpdated,taskCommentPosted

# 4. Start listener to monitor progress
node listen.mjs --timeout 3600 --mode server
```

### Pattern 2: Worker Agent Claims and Completes Tasks

```bash
# 1. Check assigned tasks
node query.mjs my-tasks

# 2. Claim a task (links session for resumability)
node query.mjs claim <task_id>

# 3. Move to in progress
node query.mjs status <task_id> "in progress"

# 4. Do the work...

# 5. Move to review when done
node query.mjs status <task_id> "in review"
node query.mjs comment <task_id> "Implementation complete. Ready for review."
```

### Pattern 3: QA Reviewer Watches for Review State

```bash
# 1. Watch the list for status changes
node query.mjs watch-list <list_id> --events taskStatusUpdated

# 2. Start listener filtered to only "in review" status
node listen.mjs --filter-status "in review" --timeout 3600

# 3. When a task hits review, agent wakes up, reads the event
# 4. Fetches the task, reviews, and either approves or sends back
node query.mjs get <task_id>
node query.mjs comments <task_id>

# If approved:
node query.mjs status <task_id> "complete"
node query.mjs comment <task_id> "QA approved."

# If needs changes:
node query.mjs status <task_id> "in progress"
node query.mjs comment <task_id> "Needs revision: [details]"

# 5. Restart listener for next review
node listen.mjs --filter-status "in review" --timeout 3600
```

### Pattern 4: Doc Keeper Gets Notified on Completion

```bash
# Watch for tasks completing
node query.mjs watch-list <list_id> --events taskStatusUpdated
node listen.mjs --filter-status "complete" --timeout 3600

# When notified, update project documentation
node query.mjs get <task_id>  # Read what was completed
# Update docs accordingly...
```

### Pattern 5: Phase Gates

For projects with sequential phases (design → implementation → QA → deploy):

```json
{
  "listId": "...",
  "tasks": [
    { "ref": "phase1", "name": "Phase 1: Design", "tags": ["phase-gate"] },
    { "ref": "phase2", "name": "Phase 2: Implementation", "dependsOn": ["phase1"], "tags": ["phase-gate"] },
    { "ref": "phase3", "name": "Phase 3: QA", "dependsOn": ["phase2"], "tags": ["phase-gate"] },
    { "ref": "phase4", "name": "Phase 4: Deploy", "dependsOn": ["phase3"], "tags": ["phase-gate"] }
  ]
}
```

A gate-keeper agent watches for phase-gate tasks completing and triggers the next phase's work.
