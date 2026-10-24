---
name: retool-query
description: Run queries against the moderator PostgreSQL database (the former Retool database, consolidated 2026-08-21) for moderation notes, user notes, strikes and other Retool-era data. Read-only by default. Use when you need to query that database directly.
---

# Moderator Database Query

Queries the moderator PostgreSQL database — `MODERATOR_DATABASE_URL`, one instance since the
2026-08-21 consolidation, holding the Retool-era moderation tables (`UserNotes`, `UserStrikes`,
`ReToolActions`, …) alongside the xguard-lab tables.

## Running Queries

```bash
node .claude/skills/retool-query/query.mjs "SELECT * FROM \"UserNotes\" LIMIT 5"
```

### Options

| Flag | Description |
|------|-------------|
| `--writable` | Allow write operations (requires user permission) |
| `--timeout <s>`, `-t` | Query timeout in seconds (default: 30) |
| `--file`, `-f` | Read query from a file |
| `--json` | Output results as JSON |
| `--quiet`, `-q` | Minimal output, only results |

### Examples

```bash
# List tables
node .claude/skills/retool-query/query.mjs "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"

# View UserNotes schema
node .claude/skills/retool-query/query.mjs "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'UserNotes'"

# Look up notes for a user
node .claude/skills/retool-query/query.mjs "SELECT * FROM \"UserNotes\" WHERE \"userId\" = 12345 ORDER BY created_at DESC LIMIT 10"

# JSON output
node .claude/skills/retool-query/query.mjs --json "SELECT * FROM \"UserNotes\" LIMIT 3"
```

## Safety Features

1. **Read-only by default**: Blocks write operations unless `--writable` flag is used
2. **Explicit permission required**: Before using `--writable`, you MUST ask the user for permission
3. **Timeout protection**: 30-second default timeout

## When to Use

- Exploring the `UserNotes` table schema
- Looking up moderation notes for a specific user
- Writing new moderation notes (with `--writable`)
- Investigating Retool-era moderation data
