---
name: postgres-query
description: Run PostgreSQL queries for testing, debugging, and performance analysis. Use when you need to query the database directly, run EXPLAIN ANALYZE, compare query results, or test SQL optimizations. Always uses read-only connections unless explicitly directed otherwise.
---

# PostgreSQL Query Testing

Use this skill to run ad-hoc PostgreSQL queries for testing, debugging, and performance analysis.

## Running Queries

Use the included query script:

```bash
node .claude/skills/postgres-query/query.mjs "SELECT * FROM \"User\" LIMIT 5"
```

### Options

| Flag | Description |
|------|-------------|
| `--explain` | Run EXPLAIN ANALYZE on the query |
| `--writable` | Use primary database instead of read replica (requires user permission) |
| `--timeout <s>`, `-t` | Query timeout in seconds (default: 30) |
| `--file`, `-f` | Read query from a file |
| `--json` | Output results as JSON |
| `--quiet`, `-q` | Minimal output, only results |

### Examples

```bash
# Simple query
node .claude/skills/postgres-query/query.mjs "SELECT id, username FROM \"User\" LIMIT 5"

# Check query performance
node .claude/skills/postgres-query/query.mjs --explain "SELECT * FROM \"Model\" WHERE id = 1"

# Override default 30s timeout for longer queries
node .claude/skills/postgres-query/query.mjs --timeout 60 "SELECT ... (complex query)"

# Query from file
node .claude/skills/postgres-query/query.mjs -f my-query.sql

# JSON output for processing
node .claude/skills/postgres-query/query.mjs --json "SELECT id, username FROM \"User\" LIMIT 3"
```

## Safety Features

1. **Read-only by default**: Uses `DATABASE_REPLICA_URL` to prevent accidental writes
2. **Write protection**: Blocks INSERT/UPDATE/DELETE/DROP unless `--writable` flag is used
3. **Explicit permission required**: Before using `--writable`, you MUST ask the user for permission

## When to Use --writable

Only use the `--writable` flag when:
- The user explicitly requests write access
- You need to test write operations
- You're verifying transaction behavior

**IMPORTANT**: Always ask the user for permission before running with `--writable`.

## Comparing Query Performance

To compare two query approaches:

```bash
# Run first approach
node .claude/skills/postgres-query/query.mjs --explain "SELECT ... (approach 1)"

# Run second approach
node .claude/skills/postgres-query/query.mjs --explain "SELECT ... (approach 2)"

# Compare actual results
node .claude/skills/postgres-query/query.mjs --json "SELECT ... (approach 1)" > /tmp/q1.json
node .claude/skills/postgres-query/query.mjs --json "SELECT ... (approach 2)" > /tmp/q2.json
```

## Verifying Index Usage

Run with `--explain` and look for:
- **Good**: "Index Scan", "Bitmap Index Scan", "Index Only Scan"
- **Bad**: "Seq Scan" on large tables (indicates missing or unused index)

```bash
node .claude/skills/postgres-query/query.mjs --explain "SELECT * FROM \"Account\" WHERE provider = 'discord'"
```
