---
name: clickup
description: Interact with ClickUp tasks and documents - get task details, view comments, create and manage tasks, create and edit docs. Use when working with ClickUp task/doc URLs or IDs.
---

# ClickUp

Interact with ClickUp tasks and documents via the API. Get task information, view comments, create tasks, manage assignments, post updates, and create/edit documents.

## Setup

**Install dependencies first — one time, per checkout:**

```bash
cd .claude/skills/clickup && npm install
```

`lib/markdown.mjs` parses markdown with `remark`, and `query.mjs` reaches it through
`lib/format.mjs` on startup. **Every** command — not just the comment ones — exits with
`ERR_MODULE_NOT_FOUND` until this runs.

Then create `accounts.json` in this skill directory with your API token:

```json
{
  "defaultAccount": "bot",
  "accounts": {
    "bot": {
      "apiToken": "pk_your_token_here"
    }
  }
}
```

Generate token at: ClickUp Settings > Apps > API Token

Or use the CLI to add accounts:

```bash
node query.mjs add-account bot --token pk_your_token_here
```

Team ID, User ID, and other fields are auto-detected and cached on first use.

**Migration from .env**: If you have an existing `.env` file, credentials are auto-migrated to `accounts.json` on first run. The `.env` file is preserved; remove it when ready.

### Default List (Optional)

Set `defaultListId` in your account to enable creating tasks without specifying a list:

```json
{
  "defaultAccount": "bot",
  "accounts": {
    "bot": {
      "apiToken": "pk_...",
      "defaultListId": "901111220963"
    }
  }
}
```

### Multi-Account

Support multiple named accounts (e.g., "bot" for automation, "justin" for personal use):

```json
{
  "defaultAccount": "bot",
  "accounts": {
    "bot": {
      "apiToken": "pk_...",
      "teamId": "8459928",
      "userId": "75386805",
      "defaultListId": "901111220963"
    },
    "justin": {
      "apiToken": "pk_...",
      "teamId": "8459928",
      "userId": "10620972"
    }
  }
}
```

Only `apiToken` is required per account. Other fields are auto-detected and cached.

Use `--account <name>` with any command to target a specific account:

```bash
node query.mjs me --account justin
node query.mjs my-tasks --account bot
```

Account management commands:

```bash
node query.mjs accounts                          # List all accounts
node query.mjs switch-account justin             # Change default
node query.mjs add-account justin --token pk_... # Add account
node query.mjs remove-account old-account        # Remove account
```

## Running Commands

```bash
node query.mjs <command> [options]
```

### Task Commands

| Command | Description |
|---------|-------------|
| `get <url\|id>` | Get task details (name, description, status, assignees, etc.) |
| `comments <url\|id>` | List comments on a task (use `--threads` to expand replies inline) |
| `thread <comment_id>` | View threaded replies on a specific comment |
| `reply <comment_id> "message"` | Post a threaded reply to a comment |
| `comment <url\|id> "message"` | Post a comment to a task (supports markdown) |
| `status <url\|id> [status]` | Update task status (or list available statuses) |
| `tasks <list_id>` | List tasks in a list |
| `me` | Show current user info |
| `create [list_id] "title"` | Create a new task (list_id optional if default set) |
| `my-tasks` | List all tasks assigned to you across workspace |
| `search [query]` | Search tasks — requires a scope: `--list`, `--folder`, `--me`, `--assignee`, `--status`, or `--all` |
| `find-list "name"` | Find a list or folder by name (fast structural walk, no task fetch) |
| `assign <task> <user>` | Assign task to a user (by name, email, or ID) |
| `due <task> "date"` | Set due date (e.g., "tomorrow", "friday", "+3d") |
| `priority <task> <level>` | Set priority (urgent, high, normal, low, none) |
| `subtask <task> "title"` | Create a subtask |
| `move <task> <list_id>` | Move task to a different list |
| `link <task> <url> ["desc"]` | Add external link reference (as comment) |
| `checklist <task> "item"` | Add checklist item to task |
| `delete-comment <comment_id>` | Delete a comment |
| `watch <task> <user>` | Add a user as watcher/follower on a task |
| `tag <task> "tag_name"` | Add a tag to task |
| `description <task> "text"` | Update task description (markdown supported) |
| `start <task> "date"` | Set start date (same date formats as due) |
| `schedule <task> "start" "due"` | Set both start and due dates |
| `rename <task> "new name"` | Rename a task |
| `depends <task> <other>` | Set task as waiting on another task |
| `blocks <task> <other>` | Set task as blocking another task |
| `task-link <task> <other>` | Create bidirectional link between tasks |
| `update-comment <id> "text"` | Update a comment's text |
| `resolve-comment <id>` | Resolve/close a comment |
| `remove-tag <task> "tag"` | Remove a tag from task |
| `unwatch <task> <user>` | Remove a watcher from task |
| `archive <task>` | Archive a task (remove from active views) |
| `unarchive <task>` | Restore an archived task |
| `claim <task>` | Link your session to this task (sets Session ID custom field for resumability) |

### List Commands

| Command | Description |
|---------|-------------|
| `list <list_id>` | Get list details (name, statuses, task count) |
| `create-list <space> "name"` | Create a new list in a space |
| `update-list <list_id>` | Update list properties (`--name`, `--content`) |
| `delete-list <list_id>` | Delete a list |
| `lists <folder_id>` | List all lists in a folder |
| `space-lists <space_id>` | List folderless lists in a space |

### Document Commands

| Command | Description |
|---------|-------------|
| `docs ["query"]` | Search/list docs in workspace (optional search query) |
| `doc <doc_id>` | Get doc details and page listing |
| `create-doc "title"` | Create a new doc (use `--content` for initial content) |
| `page <doc_id> <page_id>` | Get page content (markdown format) |
| `create-page <doc_id> "title"` | Add a new page to a doc (use `--parent` for subpages) |
| `edit-page <doc_id> <page_id>` | Edit a page's content or name |

### Attachment Commands

| Command | Description |
|---------|-------------|
| `attach <url\|id>` | Upload file attachment(s) to a task (`--attach path`, repeatable) |
| `fetch-image <url>` | Download a ClickUp attachment to a local temp file (`--output path` for custom location) |

### Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON response |
| `--threads`, `-t` | Expand threaded replies inline when listing comments |
| `--subtasks` | Include subtasks when getting task details |
| `--me` | Filter to tasks assigned to me (for tasks command) |
| `--content`, `-c` | Inline content string (markdown). Use for short text only. |
| `--file`, `-f` | Read content from a file path. **Preferred for anything longer than a sentence.** |
| `--cleanup` | Delete the `--file` after successful execution |
| `--name`, `-n` | New page name for edit-page |
| `--parent`, `-p` | Parent page ID for create-page (creates as subpage) |
| `--space`, `-s` | Space ID for create-doc (places doc in that space) |
| `--assignee`, `-a` | Assignee for task creation |
| `--due`, `-d` | Due date for task creation |
| `--description`, `--desc` | Description for task creation (markdown) |
| `--attach` | File path to upload as attachment (repeatable; for `attach` and `comment` commands) |
| `--output` | Custom output path for fetch-image (default: temp directory) |
| `--account` | Use a specific named account (from accounts.json) |

## Examples

### Get Task Details

```bash
# Using full URL
node query.mjs get "https://app.clickup.com/t/86a1b2c3d"

# Using task ID directly
node query.mjs get 86a1b2c3d

# Include subtasks
node query.mjs get 86a1b2c3d --subtasks
```

### Create a Task

```bash
# With explicit list ID
node query.mjs create 901111220963 "New feature: dark mode"

# Using default list (if CLICKUP_DEFAULT_LIST_ID is set)
node query.mjs create "Quick task"
```

### List My Tasks

```bash
# All tasks assigned to you across the workspace
node query.mjs my-tasks
```

### Search Tasks

ClickUp's v2 API has no native text search across tasks, so `search` requires a
**scope** so the workspace crawl stays bounded. Pick whichever scope fits:

```bash
# Scope to a specific list (fastest, recommended)
node query.mjs search "authentication" --list 901111220963

# All tasks assigned to you with a particular status
node query.mjs search --me --status "in progress"

# Scope to a folder ("project") — scans every list in that folder
node query.mjs search "oauth" --folder 90111122009

# Filter by assignee + text
node query.mjs search "migration" --assignee justin

# Multiple statuses (comma-separated)
node query.mjs search --me --status "in progress,review"

# Unscoped full-workspace scan — slow, fetches every task. Use sparingly.
node query.mjs search "dark mode" --all
```

Without a scope flag (and without `--all`), `search` will exit with a helpful
error instead of silently hammering the API.

### Find a List or Folder by Name

When you have a list name ("Red Launch", "Triage", "Sprint 12") but no ID,
use `find-list` — it walks the workspace structure (spaces → folders → lists)
using only metadata endpoints. Fast, no task fetches.

```bash
node query.mjs find-list "Red Launch"
node query.mjs find-list "triage" --json
```

Matches rank: exact > starts-with > contains, case-insensitive. Returns both
list matches and folder matches (with the folder's nested lists inlined), so
if the thing you named is a folder you still see the lists you probably want.

### Update Task Status

```bash
# List available statuses for a task
node query.mjs status 86a1b2c3d

# Update status (case-insensitive, partial match)
node query.mjs status 86a1b2c3d "in progress"
node query.mjs status 86a1b2c3d "complete"
```

### Assign Tasks

```bash
# Assign by username
node query.mjs assign 86a1b2c3d justin

# Assign by email
node query.mjs assign 86a1b2c3d jane@example.com
```

### Set Due Dates

```bash
node query.mjs due 86a1b2c3d "tomorrow"
node query.mjs due 86a1b2c3d "next friday"
node query.mjs due 86a1b2c3d "+3d"
node query.mjs due 86a1b2c3d "2024-01-15"
```

### Set Priority

```bash
node query.mjs priority 86a1b2c3d urgent
node query.mjs priority 86a1b2c3d high
node query.mjs priority 86a1b2c3d none  # Clear priority
```

### Create Subtasks

```bash
node query.mjs subtask 86a1b2c3d "Write unit tests"
node query.mjs subtask 86a1b2c3d "Update documentation"
```

### Move Tasks

```bash
node query.mjs move 86a1b2c3d 901111220964
```

### Add Links

```bash
# Add link with description
node query.mjs link 86a1b2c3d "https://github.com/..." "PR #123"

# Add link without description
node query.mjs link 86a1b2c3d "https://docs.example.com/guide"
```

### Add Checklist Items

```bash
node query.mjs checklist 86a1b2c3d "Review code"
node query.mjs checklist 86a1b2c3d "Run tests"
node query.mjs checklist 86a1b2c3d "Deploy to staging"
```

### List Tasks in a List

```bash
# All tasks in a list
node query.mjs tasks 901111220963

# Only tasks assigned to me
node query.mjs tasks 901111220963 --me
```

### View Comments

```bash
node query.mjs comments "https://app.clickup.com/t/86a1b2c3d"

# Expand all threaded replies inline
node query.mjs comments 86a1b2c3d --threads

# View replies on a specific comment thread
node query.mjs thread 90110200841741

# Reply to a comment thread
node query.mjs reply 90110200841741 "Sounds good, I'll take care of it."
```

### Post a Comment

```bash
node query.mjs comment 86a1b2c3d "Starting work on this task"

# Multi-line comment
node query.mjs comment 86a1b2c3d "Status update:
- Completed initial review
- Found 3 issues to address
- Will submit PR by EOD"
```

### @Mention Users in Comments

The skill supports two mention syntaxes:

1. **Explicit (preferred):** `@[identifier]` — bracket syntax with fuzzy matching by name, email, or user ID
2. **Bare (auto-detected):** `@Name` or `@First Last` — automatically matched against workspace members

Bare mentions are a **fallback** so mentions work even if agents forget the bracket syntax. Both produce the same ClickUp mention attribute.

```bash
# Explicit bracket syntax (preferred)
node query.mjs comment 86a1b2c3d "Hey @[justin], can you review this?"

# Bare mention (auto-detected against workspace members)
node query.mjs comment 86a1b2c3d "Hey @Justin Maier, can you review this?"

# Both work the same — these are equivalent:
node query.mjs comment 86a1b2c3d "@[justin] please review"
node query.mjs comment 86a1b2c3d "@Justin please review"

# Mention by numeric user ID (bracket syntax only)
node query.mjs comment 86a1b2c3d "@[10620972] please take a look"

# Mention by email (bracket syntax only)
node query.mjs comment 86a1b2c3d "Assigned to @[jane@example.com]"

# Multiple mentions in one comment
node query.mjs comment 86a1b2c3d "@[justin] and @[koen] - need your input on this"


**Bracket syntax**: Fuzzy matches partial names, emails, or numeric IDs. `@[justin]` matches "Justin Maier". Unknown users throw an error.

**Bare syntax**: Matches `@Name` against workspace member usernames (case-insensitive). Tries full name first (`@Justin Maier`), then first name (`@Justin`). Unmatched bare mentions are left as plain text (no error).

### Show Current User

```bash
node query.mjs me
```

### Delete a Comment

```bash
# Get comment IDs from the comments command (shown in --json output)
node query.mjs delete-comment 90110200841741
```

### Add/Remove Watchers

```bash
# Add user as watcher on a task
node query.mjs watch 86a1b2c3d koen

# Remove watcher
node query.mjs unwatch 86a1b2c3d koen
```

### Add Tags

```bash
# Add a tag to a task
node query.mjs tag 86a1b2c3d "DevOps"
node query.mjs tag 86a1b2c3d "bug"
```

### Update Description

```bash
# Update task description with markdown
node query.mjs description 86a1b2c3d "## Summary
This is a **bold** statement.

- Item 1
- Item 2

See [documentation](https://example.com) for more info."
```

### Archive / Restore Tasks

```bash
# Archive a task (removes from active views)
node query.mjs archive 86a1b2c3d

# Restore an archived task
node query.mjs unarchive 86a1b2c3d
```

### Claim a Task (Session Linking)

When you start working on a ClickUp task, **claim it immediately** so your session can be resumed later. This writes your Claude Code session ID to the task's "Session ID" custom field, allowing work to be picked up where you left off.

```bash
# Claim a task as soon as you begin working on it
node query.mjs claim 86a1b2c3d

# Works with URLs too
node query.mjs claim "https://app.clickup.com/t/86a1b2c3d"
```

**Requirements:**
- The task's list must have a text custom field with "Session" in its name (e.g., "Session ID")
- Session ID resolution order: `$CLAUDE_SESSION_ID` → most-recently-modified `~/.claude/projects/*/*.jsonl` (within 60s). The fallback handles harnesses that don't expose the env var.

**When to claim:** As soon as you start working on a ClickUp task. This is how we pick up where you left off if we need to continue work on the same task later.

### Get List Details

```bash
# Get list info including statuses
node query.mjs list 901111220963
```

### Create a List

```bash
# Create a list in a space using space ID
node query.mjs create-list 20128955 "New List"

# Create a list using space URL
node query.mjs create-list "https://app.clickup.com/8459928/v/s/20128955" "Sprint Backlog"

# Create a list with description
node query.mjs create-list 20128955 "Bug Tracker" --content "Track all bugs here"
```

### Delete a List

```bash
node query.mjs delete-list 901111220963
```

### List/Search Docs

```bash
# List all docs in workspace
node query.mjs docs

# Search docs by name
node query.mjs docs "API"
```

### Get Doc Details

```bash
# Get doc info and page listing
node query.mjs doc abc123def

# Using a doc URL
node query.mjs doc "https://app.clickup.com/12345/v/dc/abc123def"
```

### Create a Doc

```bash
# Create an empty doc
node query.mjs create-doc "Project Notes"

# Create a doc with initial content (populates the first page)
node query.mjs create-doc "API Documentation" --content "# API Documentation

This document covers the API endpoints and usage.

## Overview
..."
```

### Get Page Content

```bash
# Get a specific page's content
node query.mjs page abc123def page456
```

### Create a Page

```bash
# Create a page with just a title
node query.mjs create-page abc123def "New Section"

# Create a page with content
node query.mjs create-page abc123def "Getting Started" --content "# Welcome

This is the getting started guide.

## Prerequisites
- Node.js 18+
- npm or yarn"
```

### Edit a Page

```bash
# Update page content
node query.mjs edit-page abc123def page456 --content "Updated content here"

# Rename a page
node query.mjs edit-page abc123def page456 --name "New Page Name"

# Update both content and name
node query.mjs edit-page abc123def page456 --content "New content" --name "New Name"
```


### Upload Attachments

```bash
# Upload a single file to a task
node query.mjs attach 86a1b2c3d --attach ./screenshot.png

# Upload multiple files
node query.mjs attach 86a1b2c3d --attach ./screenshot1.png --attach ./report.pdf

# Post a comment with file attachments (comment first, then files are attached)
node query.mjs comment 86a1b2c3d "Here are the screenshots" --attach ./screenshot.png

# Comment with multiple attachments
node query.mjs comment 86a1b2c3d "Design review assets" --attach ./mockup.png --attach ./spec.pdf
```

**Supported file types**: Images (PNG, JPG, GIF, WebP, SVG), documents (PDF, DOCX, XLSX), archives (ZIP), and any other file type ClickUp accepts.

**Note**: The ClickUp API attaches files to the task itself (visible in the task's attachment list). When using `--attach` with the `comment` command, the comment is posted first and then the files are uploaded as task attachments. They appear in the task but are not embedded inline in the comment text.

### Viewing Attachments in Comments

Comments containing images or file attachments display them inline in plain-text output:

```
[Feb 11, 2026, 04:55 PM] Justin Maier (id: 90110209630450):
  [Attachment: image.png](https://t8459928.p.clickup-attachments.com/...)
  If you look at the component, you'll see that...
```

To view the actual image, use `fetch-image` to download it locally:

```bash
# Download attachment from URL shown in comment output
node query.mjs fetch-image "https://t8459928.p.clickup-attachments.com/t8459928/.../image.png"
# → Downloaded: /tmp/clickup-attachments/image.png

# Save to a specific path
node query.mjs fetch-image "https://..." --output ./screenshot.png
```

After downloading, use your file viewer or `Read` tool to view the image.

## File-based Content (Recommended)

For any content longer than a sentence, **write to a markdown file first** and use `--file` instead of `--content`. This avoids shell escaping issues and supports proper multi-line markdown.

### Workflow

1. Write your content to a temporary markdown file
2. Pass it with `--file path/to/file.md`
3. Optionally add `--cleanup` to auto-delete the file after success

### Examples

```bash
# Create a doc from a prepared markdown file
node query.mjs create-doc "Architecture Spec" --file ./docs/spec.md --space 90114072520

# Update a page from a file, then auto-delete the temp file
node query.mjs edit-page abc123 page456 --file /tmp/updated-content.md --cleanup

# Post a detailed comment from a file
node query.mjs comment 86a1b2c3d --file ./review-notes.md

# Set task description from a file
node query.mjs description 86a1b2c3d --file ./task-brief.md
```

### When to use which

| Approach | When to use |
|----------|-------------|
| `--content "short text"` | One-liners, simple status updates |
| `--file path.md` | Multi-line content, markdown with formatting, specs, documentation |
| `--file path.md --cleanup` | Temporary content (agent writes file, pushes to ClickUp, removes file) |

`--file` works with: `create-doc`, `create-page`, `edit-page`, `comment`, `description`, `create-list`, `update-list`

## Task/List/Space/Doc URL Formats

The skill recognizes these ClickUp URL formats:

**Tasks:**
- `https://app.clickup.com/t/{task_id}`
- `https://app.clickup.com/{team_id}/v/li/{list_id}?p={task_id}`
- Custom task ID: `#DEV-123` or `DEV-123`
- Direct task ID: `86a1b2c3d`

**Lists:**
- `https://app.clickup.com/{team_id}/v/li/{list_id}`
- Direct list ID: `901111220963`

**Spaces:**
- `https://app.clickup.com/{team_id}/v/s/{space_id}`
- Direct space ID: `20128955`

**Docs:**
- `https://app.clickup.com/{team_id}/v/dc/{doc_id}`
- `https://app.clickup.com/{team_id}/docs/{doc_id}`
- Direct doc ID: `abc123def`
## When to Use

**Tasks:**
- **Understanding context**: Get task details before starting work
- **Quick task creation**: Create tasks without leaving your terminal
- **Daily standups**: Use `my-tasks` to see your assignments
- **Status updates**: Post progress comments as you work
- **Task management**: Assign, prioritize, and set due dates
- **Collaboration**: View recent comments for context, add watchers
- **Task organization**: Add tags to categorize tasks
- **Task linking**: Reference task IDs in commit messages
- **Session tracking**: Claim tasks with `claim` so work can be resumed later

**Documents:**
- **Documentation**: Create and maintain project documentation
- **Knowledge base**: Build reference guides and wikis
- **Meeting notes**: Store meeting notes and decisions
- **Specifications**: Write and update technical specs
- **Quick edits**: Update doc content without leaving the terminal
- **Doc collaboration**: Read and reply to doc comments for inline reviews

## Comment Threading Best Practices

When responding to task discussions, **always check for thread context first**:

1. **Before posting a comment**, run `comments <task> --threads` to see existing conversations.
2. **If the user's message or context references a specific comment thread** (e.g., they replied in a thread, or you're continuing a prior conversation), use `reply <comment_id> "text"` to post within that thread — NOT `comment <task> "text"`.
3. **Only use `comment`** (top-level) for genuinely new topics that don't belong in an existing thread.
4. **Rule of thumb**: If you previously posted a comment and someone replied to it in a thread, your next response belongs in that same thread via `reply`.

## Tips

- Team ID, User ID, and other fields are auto-cached in `accounts.json`
- Set `defaultListId` in your account to skip list_id when creating tasks
- Use `my-tasks` for a quick overview of your assignments
- Use natural language dates: "tomorrow", "next friday", "+3d"
- Post comments to keep stakeholders updated on progress
- Include task IDs in commit messages for traceability
- Use `--json` for scripting or piping to other tools
- Doc content uses markdown format for both input and output
- The Docs API uses v3 endpoints (workspace-based instead of team-based)
- Custom task IDs supported: `#DEV-123` or `DEV-123`
- All task/comment queries auto-paginate (no manual page handling needed)
- Rate limiting handled automatically with retry and backoff


## Reference

Less-common material lives in [reference.md](reference.md) — read it when you need it:

- **Output Format** — sample output shapes for tasks, lists, comments, docs, pages
- **Technical Notes** — markdown handling per feature, @mention resolution, doc page structure, pagination
- **Testing** — smoke-test suite
- **Webhook Watchers** — real-time event monitoring via webhook.site + `listen.mjs`
- **Task Watcher (polling)** — dependency-free single-task/list watcher via `watch.mjs`
- **Batch Task Creation** — `batch-create` JSON plan schema and dependency wiring
- **Team Workflow Patterns** — lead/worker/QA/doc-keeper and phase-gate patterns
