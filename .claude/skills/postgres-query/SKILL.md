---
name: postgres-query
description: Run PostgreSQL queries for testing, debugging, and performance analysis. Use when you need to query the database directly, run EXPLAIN ANALYZE, compare query results, or test SQL optimizations. Always pass a target — `--prod` or `--dev` — because prod and dev are different databases and the default is prod. Always uses read-only connections unless explicitly directed otherwise.
---

# PostgreSQL Query Testing

Use this skill to run ad-hoc PostgreSQL queries for testing, debugging, and performance analysis.

## Running Queries

Use the included query script, and **name the target**:

```bash
node .claude/skills/postgres-query/query.mjs --prod "SELECT * FROM \"User\" LIMIT 5"
node .claude/skills/postgres-query/query.mjs --dev  "SELECT * FROM \"User\" LIMIT 5"
```

### Targets

Pick exactly one. Two target flags in one call is an error, not a silent precedence rule.

| Flag | Connection string | Use when |
|------|-------------------|----------|
| `--prod` (default) | `DATABASE_REPLICA_URL`, or `DATABASE_URL` with `--writable` | The production main database |
| `--dev` | `DEV_DATABASE_URL` | The dev cnpg database; requires SSH tunnel |
| `--data-packet` | `DATABASE_DATA_PACKET_URL` | The DataPacket replica (read-only) |
| `--notifications` | `NOTIFICATION_DB_REPLICA_URL` | notifications-db (read-only); requires SSH tunnel |

Omitting the target still runs against prod, so old commands keep working — but the run prints
`No target flag given, defaulted to --prod`. Pass the flag.

### Every run prints which database answered

Before connecting, the script writes a line to **stderr** naming the target, the access mode, the
resolved `user@host:port/database`, and the env var it came from:

```
Target: PROD (read-only) -> <user>@<host>:25061/civitai [DATABASE_REPLICA_URL, timeout 30s]
```

It prints under `--quiet` and `--json` too. It is on stderr, so `--json` piped to a file is still
clean JSON.

🔴 **Read that line before you trust a result.** This skill's `.env` and the app's root `.env` both
define `DATABASE_URL`, and **they name different databases** — the skill's is production, the root
one is the dev snapshot the dev server uses. The skill's `.env` wins (it is loaded first, and
`loadEnv` never overwrites an already-set key), so a bare `query.mjs` answers from production while
your dev server answers from dev. Comparing a value read here against one read by the running app
is comparing two different databases unless both lines say the same host and port. That cost an hour
and produced a confidently wrong root cause on 2026-08-16: `limit: 8` from the app's DB and
`limit: 40` from this skill's, reported as a config bug that did not exist.

### Options

| Flag | Description |
|------|-------------|
| `--explain` | Run EXPLAIN ANALYZE on the query |
| `--writable` | Use the primary connection instead of the read replica (requires user permission) |
| `--timeout <s>`, `-t` | Query timeout in seconds (default: 30) |
| `--file`, `-f` | Read query from a file |
| `--json` | Output results as JSON |
| `--quiet`, `-q` | Minimal output, only results |

`--writable` is rejected on `--data-packet` and `--notifications`; both are read-only replicas.

### Examples

```bash
# Simple query
node .claude/skills/postgres-query/query.mjs --prod "SELECT id, username FROM \"User\" LIMIT 5"

# Same query against the dev database
node .claude/skills/postgres-query/query.mjs --dev "SELECT id, username FROM \"User\" LIMIT 5"

# Check query performance
node .claude/skills/postgres-query/query.mjs --prod --explain "SELECT * FROM \"Model\" WHERE id = 1"

# Override default 30s timeout for longer queries
node .claude/skills/postgres-query/query.mjs --prod --timeout 60 "SELECT ... (complex query)"

# Query the notifications-db
node .claude/skills/postgres-query/query.mjs --notifications "SELECT count(*) FROM \"Notification\""

# Query from file
node .claude/skills/postgres-query/query.mjs --dev -f my-query.sql

# JSON output for processing (banner goes to stderr, stdout stays valid JSON)
node .claude/skills/postgres-query/query.mjs --prod --json "SELECT id, username FROM \"User\" LIMIT 3"
```

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

1. **Read-only by default**: `--prod` uses `DATABASE_REPLICA_URL` to prevent accidental writes
2. **Write protection**: Blocks INSERT/UPDATE/DELETE/DROP unless `--writable` flag is used
3. **Replica targets are always read-only**: `--notifications` and `--data-packet` reject `--writable` client-side, and their roles/poolers reject writes too
4. **Explicit permission required**: Before using `--writable`, you MUST ask the user for permission
5. **The target is printed on every run**: no result can be attributed to the wrong database by accident

## When to Use --writable

Only use the `--writable` flag when:
- The user explicitly requests write access
- You need to test write operations
- You're verifying transaction behavior

**IMPORTANT**: Always ask the user for permission before running with `--writable`.

## Comparing Query Performance

To compare two query approaches — same target on both runs, or the comparison is meaningless:

```bash
# Run first approach
node .claude/skills/postgres-query/query.mjs --prod --explain "SELECT ... (approach 1)"

# Run second approach
node .claude/skills/postgres-query/query.mjs --prod --explain "SELECT ... (approach 2)"

# Compare actual results
node .claude/skills/postgres-query/query.mjs --prod --json "SELECT ... (approach 1)" > /tmp/q1.json
node .claude/skills/postgres-query/query.mjs --prod --json "SELECT ... (approach 2)" > /tmp/q2.json
```

## Verifying Index Usage

Run with `--explain` and look for:
- **Good**: "Index Scan", "Bitmap Index Scan", "Index Only Scan"
- **Bad**: "Seq Scan" on large tables (indicates missing or unused index)

```bash
node .claude/skills/postgres-query/query.mjs --prod --explain "SELECT * FROM \"Account\" WHERE provider = 'discord'"
```
