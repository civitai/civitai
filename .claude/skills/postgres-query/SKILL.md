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

## Querying the notifications-db (DataPacket)

The notifications-db lives on the DataPacket cluster. Direct network access from your laptop isn't allowed — connect via the SSH bastion.

### One-time setup

1. Make sure your SSH public key has been added to the bastion. If you don't have access yet, ask zach to add your `~/.ssh/id_ed25519.pub` to:

   `clusters/production/apps/notifications-db/secrets/bastion-ssh-keys.enc.yaml`

2. Add an SSH config entry (`~/.ssh/config`) so the tunnel is one command:

   ```
   Host notif-bastion
     HostName 185.180.13.69
     Port 2223
     User bastion
     IdentityFile ~/.ssh/id_ed25519
     # Tunnel local 5433 → cluster pgbouncer ro pooler
     LocalForward 5433 pgbouncer-pooler-notifications-ro.cnpg-database.svc.cluster.local:5432
     ServerAliveInterval 60
   ```

3. Add the connection string to your project `.env` (or `.claude/skills/postgres-query/.env`):

   ```
   NOTIFICATION_DB_REPLICA_URL=postgresql://notifications_readonly:<password>@127.0.0.1:5433/notification_prod?sslmode=disable
   ```

   Get the password from zach (it's stored in `bastion-pg-creds.enc.yaml` in the datapacket-talos repo). The same password is also preloaded inside the bastion's `.pgpass` for in-pod use.

### Running queries

```bash
# 1. Open the SSH tunnel in one terminal (stays open)
ssh notif-bastion

#    The bastion's MOTD shows the available tables and tools.
#    You can run ad-hoc psql in this terminal too — `psql` is preloaded
#    with .pgpass and PGHOST/PGUSER env vars.

# 2. In another terminal, run queries via the skill
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
