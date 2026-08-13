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
| `--data-packet` | Use the DataPacket replica (`DATABASE_DATA_PACKET_URL`) — read-only |
| `--notifications` | Query the notifications-db (DataPacket) — read-only via SSH bastion (see setup below) |
| `--dev` | Query the dev cnpg database (`DEV_DATABASE_URL`) via SSH bastion (see setup below) |
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

# Query the notifications-db
node .claude/skills/postgres-query/query.mjs --notifications "SELECT count(*) FROM \"Notification\""

# Query from file
node .claude/skills/postgres-query/query.mjs -f my-query.sql

# JSON output for processing
node .claude/skills/postgres-query/query.mjs --json "SELECT id, username FROM \"User\" LIMIT 3"
```

## Connection Targets

| Flag | Connection string | Use when |
|------|-------------------|----------|
| (default) | `DATABASE_REPLICA_URL` (falls back to `DATABASE_URL`) | Most queries — read-only main replica |
| `--writable` | `DATABASE_URL` | Writes against primary; needs user permission |
| `--data-packet` | `DATABASE_DATA_PACKET_URL` | Querying the DataPacket replica (read-only) |
| `--notifications` | `NOTIFICATION_DB_REPLICA_URL` | Querying notifications-db (read-only); requires SSH tunnel |
| `--dev` | `DEV_DATABASE_URL` | Querying the dev cnpg database; requires SSH tunnel |

## Querying the dev database (cnpg)

The dev database is not reachable directly — it needs an SSH tunnel to an internal
host. **Ask an infra owner for the connection recipe**; the specifics are not
documented here because this repository is public (see the Security section of
`CLAUDE.md`).

Once the tunnel is up, set `DEV_DATABASE_URL` in
`.claude/skills/postgres-query/.env` to point at your local forwarded port.

### Running dev queries

```bash
# Read-only (default — writes are blocked client-side)
node .claude/skills/postgres-query/query.mjs --dev "SELECT count(*) FROM \"User\""

# Writable DML (needs user permission)
node .claude/skills/postgres-query/query.mjs --dev --writable "UPDATE ..."
```

**DDL does not work through this credential.** `DEV_DATABASE_URL` connects as a
non-superuser role, and the dev database has a `ddl_command_end` event trigger that
reassigns each new object's ownership to the schema owner — which the connecting
role cannot become. Any `CREATE TABLE` therefore rolls back with:

```
must be able to SET ROLE "<schema owner>"
```

Having `CREATE` on the schema is not enough and does not indicate otherwise. Ask an
infra owner to run the DDL, or for a role that is a member of the schema owner.

## Querying the notifications-db

The notifications database is not reachable directly — it needs an SSH tunnel to an
internal host, and access has to be granted first.

**Ask an infra owner for access and the connection recipe.** The bastion host, the
forward target, and where the credentials live are deliberately not documented here,
because this repository is public — see the Security section of `CLAUDE.md`.

Once you have the tunnel open, set `NOTIFICATION_DB_REPLICA_URL` in
`.claude/skills/postgres-query/.env` to point at your local forwarded port.

### Running queries

```bash
# With the tunnel open in another terminal:
node .claude/skills/postgres-query/query.mjs --notifications \
  "SELECT count(*) FROM \"Notification\""

node .claude/skills/postgres-query/query.mjs --notifications --explain \
  "SELECT * FROM \"UserNotification\" WHERE \"userId\" = 12345 ORDER BY \"createdAt\" DESC LIMIT 50"
```

### Available tables (read-only)

- `Notification` — canonical notifications
- `UserNotification` — per-user fanout (largest table)
- `PendingNotification` — processing queue (often empty)

The role `notifications_readonly` only has `SELECT`. Writes are also rejected at the pooler level (replica routing).

## Safety Features

1. **Read-only by default**: Uses `DATABASE_REPLICA_URL` to prevent accidental writes
2. **Write protection**: Blocks INSERT/UPDATE/DELETE/DROP unless `--writable` flag is used
3. **Notifications is always read-only**: `--notifications` blocks writes client-side AND the database role/pooler reject them
4. **Explicit permission required**: Before using `--writable`, you MUST ask the user for permission

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
