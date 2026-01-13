---
name: meilisearch-admin
description: Check Meilisearch index status, tasks, health, and settings. Use for debugging search issues, monitoring indexing tasks, and inspecting index configuration. Read-only admin operations.
---

# Meilisearch Admin

Use this skill for admin operations on Meilisearch - checking status, monitoring tasks, and inspecting index settings.

## Running Commands

```bash
node .claude/skills/meilisearch-admin/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `health` | Check if Meilisearch is healthy |
| `stats` | Get overall stats and list indexes |
| `tasks` | List recent tasks |
| `task <id>` | Get details of a specific task |
| `indexes` | List all indexes |
| `index <name>` | Get index stats |
| `index <name> settings` | Get all index settings |
| `index <name> filterable` | Get filterable attributes |
| `index <name> sortable` | Get sortable attributes |
| `index <name> searchable` | Get searchable attributes |

### Options

| Flag | Description |
|------|-------------|
| `--feed` | Use feed/metrics search (METRICS_SEARCH_HOST) instead of main search |
| `--status <s>` | Filter tasks by status: enqueued, processing, succeeded, failed |
| `--limit <n>` | Limit results (default: 20) |
| `--json` | Output raw JSON |

### Examples

```bash
# Check health
node .claude/skills/meilisearch-admin/query.mjs health

# Get overall stats
node .claude/skills/meilisearch-admin/query.mjs stats

# Check failed tasks
node .claude/skills/meilisearch-admin/query.mjs tasks --status failed

# Check processing tasks
node .claude/skills/meilisearch-admin/query.mjs tasks --status processing --limit 50

# Get specific task details
node .claude/skills/meilisearch-admin/query.mjs task 2030419

# List all indexes
node .claude/skills/meilisearch-admin/query.mjs indexes

# Get index stats
node .claude/skills/meilisearch-admin/query.mjs index models_v9

# Get filterable attributes for an index
node .claude/skills/meilisearch-admin/query.mjs index metrics_images_v1 filterable

# Use feed search instead of main
node .claude/skills/meilisearch-admin/query.mjs --feed stats
node .claude/skills/meilisearch-admin/query.mjs --feed tasks --status failed
```

## Search Instances

The project has two Meilisearch instances:

| Instance | Env Variables | Purpose |
|----------|---------------|---------|
| **Main Search** | `SEARCH_HOST`, `SEARCH_API_KEY` | Primary search (models, users, etc.) |
| **Feed/Metrics** | `METRICS_SEARCH_HOST`, `METRICS_SEARCH_API_KEY` | Image feed and metrics search |

Use `--feed` flag to target the feed/metrics instance.

## Common Indexes

### Main Search
- `models_v9` - Model search
- `users_v3` - User search
- `articles_v3` - Article search

### Feed/Metrics Search
- `metrics_images_v1` - Image feed with metrics

## Debugging Tips

```bash
# Check if indexing is stuck
node .claude/skills/meilisearch-admin/query.mjs tasks --status processing

# Find failed indexing tasks
node .claude/skills/meilisearch-admin/query.mjs tasks --status failed

# Get error details for a failed task
node .claude/skills/meilisearch-admin/query.mjs task <taskId>

# Check if an index is still indexing
node .claude/skills/meilisearch-admin/query.mjs index <indexName>
```
