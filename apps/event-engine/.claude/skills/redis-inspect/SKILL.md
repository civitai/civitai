---
name: redis-inspect
description: Inspect Redis cache keys, values, and TTLs for debugging. Supports both main cache and system cache. Use for debugging cache issues, checking cached values, and monitoring cache state. Read-only by default.
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
| `--sys` | Use system cache instead of main cache |
| `--writable` | Allow write operations (required for del) |
| `--json` | Output raw JSON |
| `--limit <n>` | Limit results (default: 100) |

## Cache Types

The project has two Redis instances:

| Cache | Flag | Env Variable | Purpose |
|-------|------|--------------|---------|
| **Main Cache** | (default) | `REDIS_URL` | Regular cache, cluster mode, can be lost |
| **System Cache** | `--sys` | `REDIS_SYS_URL` | Persistent system values, single node |

### Main Cache (default)
Regular application cache. Data here can be regenerated if lost.
- User sessions
- Cached queries
- Temporary data
- Rate limiting counters

### System Cache (--sys)
Persistent system configuration and state. More critical data.
- Feature flags
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

# Check system cache values
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

### System Cache
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
