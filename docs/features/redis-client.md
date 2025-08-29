# Custom Redis Client

This document explains Civitai's custom Redis client implementation, including its typing system and the distinction between cache and system Redis instances.

## Client Architecture

### Two Separate Redis Instances

```typescript
export let redis: CustomRedisClientCache;      // Cache instance
export let sysRedis: CustomRedisClientSys;     // System instance
```

**Cache Redis** (`redis`):
- Temporary data that can be rebuilt
- User sessions, cached queries, temporary state
- Can be flushed without data loss
- Uses `REDIS_URL` environment variable

**System Redis** (`sysRedis`):
- Source of truth configuration data
- Feature flags, policies, system settings
- Critical data that shouldn't be lost
- Uses `REDIS_SYS_URL` environment variable

## Type-Safe Key System

### Key Template Types
```typescript
type RedisKeyTemplateCache = `${RedisKeyStringsCache}${'' | `:${string}`}`;
type RedisKeyTemplateSys = `${RedisKeyStringsSys}${'' | `:${string}`}`;
```

Keys are constrained to predefined patterns with optional suffixes:
- `user:123` ✅ (valid: base key + suffix)
- `user` ✅ (valid: exact base key)
- `random-key` ❌ (invalid: not in predefined keys)

## Client Interface

Redis functions have been redeclared to use the new custom typing system.

**Usage:**
```typescript
// Manual JSON handling
await redis.set('user:123', JSON.stringify(userData));
const data = JSON.parse(await redis.get('user:123'));

// Automatic packing
await redis.packed.set('packed:user:123', userData);
const data2 = await redis.packed.get<UserData>('packed:user:123');
```

## Key Naming Conventions

### Prefixes
- `packed:` - Uses MessagePack serialization
- `system:` - System configuration data

### Patterns
- `type:id` - Entity-specific data (`user:123`)
- `type:subtype:id` - Nested categories (`user:settings:123`)

### Dynamic Keys
Template types allow dynamic suffixes:
```typescript
// These are all valid for 'user' base key:
'user'           // Exact key
'user:123'       // With ID suffix  
'user:settings'  // With type suffix
```

### Data Serialization
- Prefer `packed` methods for complex objects
- Use regular methods for simple strings/numbers
- Consider storage efficiency vs. readability
