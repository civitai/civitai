---
name: opensearch-admin
description: Inspect and debug OpenSearch clusters — health, index stats, search performance, query profiling, mappings, shards, and thread pools. Read-only admin operations for monitoring and troubleshooting.
---

# OpenSearch Admin

Use this skill to inspect OpenSearch clusters, debug search performance, profile queries, and monitor index health.

## Running Commands

```bash
node .claude/skills/opensearch-admin/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `health` | Cluster health (green/yellow/red, shard counts) |
| `stats` | Cluster-wide stats (docs, store, JVM, disk, CPU) |
| `nodes` | Per-node stats (heap, CPU, load, disk, doc count) |
| `indexes` | List all indexes with doc counts and sizes |
| `index <name>` | Index stats (docs, indexing, search, merges, cache) |
| `index <name> mappings` | Show field type mappings |
| `index <name> settings` | Show index settings |
| `index <name> shards` | Show shard allocation |
| `count <name> [filter]` | Count docs with optional JSON filter |
| `search <name> <query>` | Search docs with JSON query body |
| `sample <name>` | Fetch sample documents |
| `profile <name> <query>` | Profile query execution timing |
| `tasks` | List running cluster tasks |
| `aliases` | List all aliases |
| `segments <name>` | Segment info (merge health) |
| `cat-indices` | Compact index overview |
| `pending-tasks` | Pending cluster tasks |
| `thread-pool` | Thread pool stats (active, queue, rejected) |

### Options

| Flag | Description |
|------|-------------|
| `--host <url>` | Override OPENSEARCH_HOST (default: http://localhost:9200) |
| `--key <key>` | Override OPENSEARCH_API_KEY |
| `--limit <n>` | Limit results (default: 20) |
| `--sort <field>` | Sort field for search (e.g. "sortAt:desc") |
| `--json` | Output raw JSON |

### Examples

```bash
# Cluster health
node .claude/skills/opensearch-admin/query.mjs health

# Cluster-wide stats (docs, JVM, disk)
node .claude/skills/opensearch-admin/query.mjs stats

# Node-level stats
node .claude/skills/opensearch-admin/query.mjs nodes

# List all indexes
node .claude/skills/opensearch-admin/query.mjs indexes

# Index stats (search perf, indexing, cache)
node .claude/skills/opensearch-admin/query.mjs index metrics_images_v1

# View field mappings
node .claude/skills/opensearch-admin/query.mjs index metrics_images_v1 mappings

# Count all docs
node .claude/skills/opensearch-admin/query.mjs count metrics_images_v1

# Count with filter
node .claude/skills/opensearch-admin/query.mjs count metrics_images_v1 '{"term":{"userId":4}}'

# Sample documents
node .claude/skills/opensearch-admin/query.mjs sample metrics_images_v1 --limit 3

# Search with query DSL
node .claude/skills/opensearch-admin/query.mjs search metrics_images_v1 '{"term":{"userId":4}}' --sort sortAt:desc --limit 10

# Profile a query (execution timing breakdown)
node .claude/skills/opensearch-admin/query.mjs profile metrics_images_v1 '{"term":{"userId":4}}'

# Shard allocation
node .claude/skills/opensearch-admin/query.mjs index metrics_images_v1 shards

# Thread pool stats
node .claude/skills/opensearch-admin/query.mjs thread-pool

# Target a remote cluster
node .claude/skills/opensearch-admin/query.mjs --host https://prod-os:9200 --key mytoken stats
```

## Performance Debugging

```bash
# 1. Check cluster health and resource usage
node .claude/skills/opensearch-admin/query.mjs health
node .claude/skills/opensearch-admin/query.mjs stats

# 2. Check index-level search stats (avg query time, cache hits)
node .claude/skills/opensearch-admin/query.mjs index metrics_images_v1

# 3. Profile a slow query
node .claude/skills/opensearch-admin/query.mjs profile metrics_images_v1 '{"bool":{"must":[{"term":{"userId":4}}],"filter":[{"range":{"sortAtUnix":{"gte":1700000000}}}]}}'

# 4. Check segment health (too many segments = slow)
node .claude/skills/opensearch-admin/query.mjs segments metrics_images_v1

# 5. Check thread pool for rejected queries
node .claude/skills/opensearch-admin/query.mjs thread-pool
```

## Query DSL Quick Reference

```bash
# Term filter (exact match)
'{"term":{"userId":4}}'

# Terms filter (IN clause)
'{"terms":{"nsfwLevel":[1,2,4]}}'

# Range filter
'{"range":{"sortAtUnix":{"gte":1700000000,"lte":1710000000}}}'

# Bool query (AND/OR/NOT)
'{"bool":{"must":[{"term":{"userId":4}}],"must_not":[{"term":{"poi":true}}],"filter":[{"range":{"sortAtUnix":{"gte":1700000000}}}]}}'

# Exists filter
'{"exists":{"field":"baseModel"}}'

# Match all
'{"match_all":{}}'
```
