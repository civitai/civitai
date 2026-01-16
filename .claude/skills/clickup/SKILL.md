---
name: clickup
description: Interact with ClickUp tasks and documents - get task details, view comments, create and manage tasks, create and edit docs. Use when working with ClickUp task/doc URLs or IDs.
---

# ClickUp

Interact with ClickUp tasks and documents via the API. Get task information, view comments, create tasks, manage assignments, post updates, and create/edit documents.

## Setup

1. Copy `.env-example` to `.env` in this skill directory
2. Add your ClickUp Personal API Token (starts with `pk_`)
3. Generate token at: ClickUp Settings > Apps > API Token

```bash
cp .claude/skills/clickup/.env-example .claude/skills/clickup/.env
# Edit .env and add your token
```

Team ID and User ID are auto-detected and cached on first use.

### Default List (Optional)

Set `CLICKUP_DEFAULT_LIST_ID` in `.env` to enable creating tasks without specifying a list:

```bash
# In .claude/skills/clickup/.env
CLICKUP_DEFAULT_LIST_ID=901111220963
```

## Running Commands

```bash
node .claude/skills/clickup/query.mjs <command> [options]
```

### Task Commands

| Command | Description |
|---------|-------------|
| `get <url\|id>` | Get task details (name, description, status, assignees, etc.) |
| `comments <url\|id>` | List comments on a task |
| `comment <url\|id> "message"` | Post a comment to a task (supports markdown) |
| `status <url\|id> [status]` | Update task status (or list available statuses) |
| `tasks <list_id>` | List tasks in a list |
| `me` | Show current user info |
| `create [list_id] "title"` | Create a new task (list_id optional if default set) |
| `my-tasks` | List all tasks assigned to you across workspace |
| `search "query"` | Search tasks by name or description |
| `assign <task> <user>` | Assign task to a user (by name, email, or ID) |
| `due <task> "date"` | Set due date (e.g., "tomorrow", "friday", "+3d") |
| `priority <task> <level>` | Set priority (urgent, high, normal, low, none) |
| `subtask <task> "title"` | Create a subtask |
| `move <task> <list_id>` | Move task to a different list |
| `link <task> <url> ["desc"]` | Add external link reference (as comment) |
| `checklist <task> "item"` | Add checklist item to task |
| `delete-comment <comment_id>` | Delete a comment |
| `watch <task> <user>` | Notify user via @mention comment (watchers not supported in API) |
| `tag <task> "tag_name"` | Add a tag to task |
| `description <task> "text"` | Update task description (markdown supported) |

### Document Commands

| Command | Description |
|---------|-------------|
| `docs ["query"]` | Search/list docs in workspace (optional search query) |
| `doc <doc_id>` | Get doc details and page listing |
| `create-doc "title"` | Create a new doc (use `--content` for initial content) |
| `page <doc_id> <page_id>` | Get page content (markdown format) |
| `create-page <doc_id> "title"` | Add a new page to a doc (creates additional page) |
| `edit-page <doc_id> <page_id>` | Edit a page's content or name |

### Options

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON response |
| `--subtasks` | Include subtasks when getting task details |
| `--me` | Filter to tasks assigned to me (for tasks command) |
| `--content`, `-c` | Page content for create-page/edit-page (markdown) |
| `--name`, `-n` | New page name for edit-page |

## Examples

### Get Task Details

```bash
# Using full URL
node .claude/skills/clickup/query.mjs get "https://app.clickup.com/t/86a1b2c3d"

# Using task ID directly
node .claude/skills/clickup/query.mjs get 86a1b2c3d

# Include subtasks
node .claude/skills/clickup/query.mjs get 86a1b2c3d --subtasks
```

### Create a Task

```bash
# With explicit list ID
node .claude/skills/clickup/query.mjs create 901111220963 "New feature: dark mode"

# Using default list (if CLICKUP_DEFAULT_LIST_ID is set)
node .claude/skills/clickup/query.mjs create "Quick task"
```

### List My Tasks

```bash
# All tasks assigned to you across the workspace
node .claude/skills/clickup/query.mjs my-tasks
```

### Search Tasks

```bash
node .claude/skills/clickup/query.mjs search "authentication"
```

### Update Task Status

```bash
# List available statuses for a task
node .claude/skills/clickup/query.mjs status 86a1b2c3d

# Update status (case-insensitive, partial match)
node .claude/skills/clickup/query.mjs status 86a1b2c3d "in progress"
node .claude/skills/clickup/query.mjs status 86a1b2c3d "complete"
```

### Assign Tasks

```bash
# Assign by username
node .claude/skills/clickup/query.mjs assign 86a1b2c3d justin

# Assign by email
node .claude/skills/clickup/query.mjs assign 86a1b2c3d jane@example.com
```

### Set Due Dates

```bash
node .claude/skills/clickup/query.mjs due 86a1b2c3d "tomorrow"
node .claude/skills/clickup/query.mjs due 86a1b2c3d "next friday"
node .claude/skills/clickup/query.mjs due 86a1b2c3d "+3d"
node .claude/skills/clickup/query.mjs due 86a1b2c3d "2024-01-15"
```

### Set Priority

```bash
node .claude/skills/clickup/query.mjs priority 86a1b2c3d urgent
node .claude/skills/clickup/query.mjs priority 86a1b2c3d high
node .claude/skills/clickup/query.mjs priority 86a1b2c3d none  # Clear priority
```

### Create Subtasks

```bash
node .claude/skills/clickup/query.mjs subtask 86a1b2c3d "Write unit tests"
node .claude/skills/clickup/query.mjs subtask 86a1b2c3d "Update documentation"
```

### Move Tasks

```bash
node .claude/skills/clickup/query.mjs move 86a1b2c3d 901111220964
```

### Add Links

```bash
# Add link with description
node .claude/skills/clickup/query.mjs link 86a1b2c3d "https://github.com/..." "PR #123"

# Add link without description
node .claude/skills/clickup/query.mjs link 86a1b2c3d "https://docs.example.com/guide"
```

### Add Checklist Items

```bash
node .claude/skills/clickup/query.mjs checklist 86a1b2c3d "Review code"
node .claude/skills/clickup/query.mjs checklist 86a1b2c3d "Run tests"
node .claude/skills/clickup/query.mjs checklist 86a1b2c3d "Deploy to staging"
```

### List Tasks in a List

```bash
# All tasks in a list
node .claude/skills/clickup/query.mjs tasks 901111220963

# Only tasks assigned to me
node .claude/skills/clickup/query.mjs tasks 901111220963 --me
```

### View Comments

```bash
node .claude/skills/clickup/query.mjs comments "https://app.clickup.com/t/86a1b2c3d"
```

### Post a Comment

```bash
node .claude/skills/clickup/query.mjs comment 86a1b2c3d "Starting work on this task"

# Multi-line comment
node .claude/skills/clickup/query.mjs comment 86a1b2c3d "Status update:
- Completed initial review
- Found 3 issues to address
- Will submit PR by EOD"
```

### Show Current User

```bash
node .claude/skills/clickup/query.mjs me
```

### Delete a Comment

```bash
# Get comment IDs from the comments command (shown in --json output)
node .claude/skills/clickup/query.mjs delete-comment 90110200841741
```

### Notify Users (Watch)

```bash
# Notify user via @mention comment (ClickUp API doesn't support adding watchers directly)
node .claude/skills/clickup/query.mjs watch 86a1b2c3d koen

# Notify by email
node .claude/skills/clickup/query.mjs watch 86a1b2c3d jane@example.com
```

### Add Tags

```bash
# Add a tag to a task
node .claude/skills/clickup/query.mjs tag 86a1b2c3d "DevOps"
node .claude/skills/clickup/query.mjs tag 86a1b2c3d "bug"
```

### Update Description

```bash
# Update task description with markdown
node .claude/skills/clickup/query.mjs description 86a1b2c3d "## Summary
This is a **bold** statement.

- Item 1
- Item 2

See [documentation](https://example.com) for more info."
```

### List/Search Docs

```bash
# List all docs in workspace
node .claude/skills/clickup/query.mjs docs

# Search docs by name
node .claude/skills/clickup/query.mjs docs "API"
```

### Get Doc Details

```bash
# Get doc info and page listing
node .claude/skills/clickup/query.mjs doc abc123def

# Using a doc URL
node .claude/skills/clickup/query.mjs doc "https://app.clickup.com/12345/v/dc/abc123def"
```

### Create a Doc

```bash
# Create an empty doc
node .claude/skills/clickup/query.mjs create-doc "Project Notes"

# Create a doc with initial content (populates the first page)
node .claude/skills/clickup/query.mjs create-doc "API Documentation" --content "# API Documentation

This document covers the API endpoints and usage.

## Overview
..."
```

### Get Page Content

```bash
# Get a specific page's content
node .claude/skills/clickup/query.mjs page abc123def page456
```

### Create a Page

```bash
# Create a page with just a title
node .claude/skills/clickup/query.mjs create-page abc123def "New Section"

# Create a page with content
node .claude/skills/clickup/query.mjs create-page abc123def "Getting Started" --content "# Welcome

This is the getting started guide.

## Prerequisites
- Node.js 18+
- npm or yarn"
```

### Edit a Page

```bash
# Update page content
node .claude/skills/clickup/query.mjs edit-page abc123def page456 --content "Updated content here"

# Rename a page
node .claude/skills/clickup/query.mjs edit-page abc123def page456 --name "New Page Name"

# Update both content and name
node .claude/skills/clickup/query.mjs edit-page abc123def page456 --content "New content" --name "New Name"
```

## Task/List/Doc URL Formats

The skill recognizes these ClickUp URL formats:

**Tasks:**
- `https://app.clickup.com/t/{task_id}`
- `https://app.clickup.com/{team_id}/v/li/{list_id}?p={task_id}`
- Direct task ID: `86a1b2c3d`

**Lists:**
- `https://app.clickup.com/{team_id}/v/li/{list_id}`
- Direct list ID: `901111220963`

**Docs:**
- `https://app.clickup.com/{team_id}/v/dc/{doc_id}`
- `https://app.clickup.com/{team_id}/docs/{doc_id}`
- Direct doc ID: `abc123def`

## Output Format

### Task Details

```
Task: Implement user authentication
Status: In Progress
Priority: High
Assignees: John Doe, Jane Smith
Due: 2024-01-15
Created: 2024-01-10
URL: https://app.clickup.com/t/86a1b2c3d

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

**Documents:**
- **Documentation**: Create and maintain project documentation
- **Knowledge base**: Build reference guides and wikis
- **Meeting notes**: Store meeting notes and decisions
- **Specifications**: Write and update technical specs
- **Quick edits**: Update doc content without leaving the terminal

## Tips

- Team ID, User ID, and default list ID are auto-cached in `.env`
- Set `CLICKUP_DEFAULT_LIST_ID` to skip list_id when creating team tasks
- Use `my-tasks` for a quick overview of your assignments
- Use natural language dates: "tomorrow", "next friday", "+3d"
- Post comments to keep stakeholders updated on progress
- Include task IDs in commit messages for traceability
- Use `--json` for scripting or piping to other tools
- Doc content uses markdown format for both input and output
- The Docs API uses v3 endpoints (workspace-based instead of team-based)

## Technical Notes

### Markdown Handling

ClickUp uses different content formats for different features:

| Feature | API Version | Content Format |
|---------|-------------|----------------|
| Comments | v2 | Proprietary JSON array (converted via `markdownToClickUp()`) |
| Task descriptions | v2 | Native markdown via `markdown_description` field |
| Docs/Pages | v3 | Native markdown (no conversion needed) |

The Docs API (v3) accepts and returns markdown directly, so no conversion is required. This is different from comments which use a proprietary format that requires the `lib/markdown.mjs` conversion utilities.

### Doc Page Structure

When you create a doc via the API, ClickUp automatically creates an empty first page. This has implications:

- **`create-doc`** - Creates a doc with an auto-generated first page. Use `--content` to populate that first page.
- **`create-page`** - Adds an *additional* page to a doc (second page, third page, etc.)
- **`edit-page`** - Modifies an existing page's content

To add content to a new doc, use `create-doc "Title" --content "..."` rather than creating the doc and then using `create-page` (which would leave the first page empty).
