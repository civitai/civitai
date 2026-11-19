---
name: redis-inspect
description: Inspect Redis keys, values, and TTLs for debugging. Supports both the cache (default) and the system store (`--sys`, durable state, not a cache). Use for debugging cache issues, checking cached values, and monitoring cache state. Read-only by default.
---

# Redis Cache Inspector

Use this skill to inspect Redis cache state for debugging purposes.

## Running Commands

```bash
node .claude/skills/redis-inspect/query.mjs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `get <key>` | Get a string value |
| `keys <pattern>` | Find keys matching pattern (use * as wildcard) |
| `ttl <key>` | Get TTL (-1 = no expiry, -2 = not found) |
| `type <key>` | Get the type of a key |
| `exists <key>` | Check if key exists |
| `hgetall <key>` | Get all fields from a hash |
| `hget <key> <field>` | Get a specific hash field |
| `scard <key>` | Get set cardinality (count) |
| `smembers <key>` | Get all set members |
| `llen <key>` | Get list length |
| `lrange <key>` | Get list elements |
| `del <key>` | Delete a key (requires --writable) |
| `info` | Get Redis server info |

### Options

| Flag | Description |
|------|-------------|
| `--sys` | Use the system store (sysRedis) instead of the cache |
| `--writable` | Allow write operations (required for del) |
| `--json` | Output raw JSON |
| `--limit <n>` | Limit results (default: 100) |

## The two stores

The project has two Redis instances. They are not interchangeable: pick by what the data is, not by
where a similar key already lives.

| Store | Flag | Env Variable | Purpose |
|-------|------|--------------|---------|
| **Cache** (`redis`, `REDIS_KEYS`) | (default) | `REDIS_URL` | Cached and recomputable data, rate-limit windows. Give every key a TTL; anything here can be lost. |
| **sysRedis (durable state, not a cache)** (`REDIS_SYS_KEYS`) | `--sys` | `REDIS_SYS_URL` | Existing durable state: revocations, idempotency markers, spend reservations, ledgers, job and game state. Never cached or recomputable data. |

New durable data goes in Postgres, not in a new sysRedis key. A new `REDIS_SYS_KEYS` entry needs
explicit sign-off and an entry in the ledger test `packages/civitai-redis/src/__tests__/sys-key-ledger.test.ts`.
The rule with the helpers to use is in `.claude/rules/server.md`.

### Cache (default)
Data here can be regenerated if lost.
- Session cache
- Cached queries (`createCachedObject`, `fetchThroughCache`)
- Rate-limit windows (the tRPC `rateLimit` middleware)
- Short-lived locks (`withDistributedLock`)

### sysRedis (--sys)
State that must survive a cache flush.
- Feature and system configuration
- Generation limits/status
- System permissions
- Job state
- Event configurations

## Examples

```bash
# Find keys matching a pattern
node .claude/skills/redis-inspect/query.mjs keys "user:*" --limit 20
node .claude/skills/redis-inspect/query.mjs keys "packed:caches:*"

# Get a value
node .claude/skills/redis-inspect/query.mjs get "session:data2:123456"

# Check sysRedis values
node .claude/skills/redis-inspect/query.mjs --sys get "system:features"
node .claude/skills/redis-inspect/query.mjs --sys hgetall "system:entity-moderation"

# Check TTL
node .claude/skills/redis-inspect/query.mjs ttl "generation:count:123"

# Inspect a hash
node .claude/skills/redis-inspect/query.mjs hgetall "packed:caches:cosmetics"
node .claude/skills/redis-inspect/query.mjs hget "system:entity-moderation" "entities"

# Check set size
node .claude/skills/redis-inspect/query.mjs scard "queues:seen-images"

# Get server info
node .claude/skills/redis-inspect/query.mjs info
node .claude/skills/redis-inspect/query.mjs --sys info
```

## Common Key Patterns

### Main Cache
| Pattern | Description |
|---------|-------------|
| `user:*` | User data |
| `session:*` | Session data |
| `packed:caches:*` | Packed/compressed cached data |
| `packed:user:*` | Packed user cache |
| `generation:*` | Generation-related cache |
| `tag:*` | Tag cache |

### sysRedis
| Pattern | Description |
|---------|-------------|
| `system:*` | System configuration |
| `generation:*` | Generation limits/status |
| `download:limits` | Download limits |
| `job:*` | Job state |
| `event:*` | Event configurations |
| `new-order:*` | New Order game state |
| `daily-challenge:*` | Daily challenge config |

## Debugging Tips

```bash
# Check if a user's session exists
node .claude/skills/redis-inspect/query.mjs keys "session:data2:*" --limit 10

# Check generation status
node .claude/skills/redis-inspect/query.mjs --sys get "generation:status"

# Check feature flags
node .claude/skills/redis-inspect/query.mjs --sys hgetall "system:features"

# Check cache memory usage
node .claude/skills/redis-inspect/query.mjs info
```

## Write Operations

Write operations require `--writable` flag and user approval:

```bash
# Delete a specific key (requires approval)
node .claude/skills/redis-inspect/query.mjs del "some:key" --writable
```

**IMPORTANT**: Always ask the user for permission before using `--writable`.
