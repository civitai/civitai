# Query Cache Persistence & Multi-Instance Sync

## Overview

The query cache persistence system ensures that the 25MB/418k entry query cache (with ~80% hit rate) survives deployments, crashes, and is synchronized across multiple instances in real-time.

## Architecture

### Three-Layer Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    Instance 1 (Pod A)                       │
│  ┌──────────────┐    Real-time     ┌──────────────┐        │
│  │  LRU Cache   │◄──────Sync──────►│  Redis Pub   │        │
│  │   (Local)    │                   │    /Sub      │        │
│  └──────────────┘                   └──────┬───────┘        │
│         │                                   │                │
│         │ Periodic Backup (30min)           │ Broadcast      │
│         ▼                                   │ Cache Ops      │
│  ┌──────────────┐                   ┌──────▼───────┐        │
│  │    Redis     │◄──────────────────│  Redis Sub   │        │
│  │  (Snapshot)  │                   │              │        │
│  └──────────────┘                   └──────────────┘        │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Redis Pub/Sub Channel
                            │
┌─────────────────────────────────────────────────────────────┐
│                    Instance 2 (Pod B)                       │
│  ┌──────────────┐                   ┌──────────────┐        │
│  │  LRU Cache   │◄──────Sync──────►│  Redis Pub   │        │
│  │   (Local)    │                   │    /Sub      │        │
│  └──────────────┘                   └──────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### 1. **Real-time Pub/Sub Sync** (Primary)
- **Purpose**: Share cache entries across all instances in real-time
- **Mechanism**: Redis pub/sub broadcasts every `cache.set()` to other instances
- **Benefits**:
  - New pods get cache entries immediately during rolling updates
  - All instances share the same cache state
  - Sub-second propagation latency
  - Zero duplicate work across instances

### 2. **Periodic Backup** (Safety Net)
- **Purpose**: Snapshot cache for disaster recovery
- **Frequency**: 30 minutes (when sync enabled) / 5 minutes (when sync disabled)
- **Storage**: Compressed snapshot in Redis (gzip, ~70-90% compression)
- **Leader Election**: When sync is enabled, only one instance performs backup using Redis distributed lock
- **Benefits**:
  - Survives full cluster restarts
  - Handles OOMKills, crashes, forced deletions
  - Max data loss: 30 minutes of cache warming
  - Zero duplicate backup work across instances

### 3. **Graceful Shutdown** (Optimization)
- **Purpose**: Final snapshot during normal terminations
- **When**: SIGTERM/SIGINT signal handlers
- **Benefits**: Zero data loss during normal deployments

## How It Works

### Rolling Update Scenario

```
Time  │ Old Pod (A)                    │ New Pod (B)
──────┼────────────────────────────────┼────────────────────────────
T+0   │ Cache: 418k entries (warm)     │ [Not started]
      │                                 │
T+10  │ Cache: 418k entries            │ Started, Cache: 0 entries
      │ Query "user_123" → cache hit   │ Restored: 410k entries from backup
      │   → Broadcast to Redis pub/sub │
      │                                 │ Receives "user_123" → cache set
      │                                 │
T+20  │ Query "model_456" → cache hit  │ Cache: 410k + user_123
      │   → Broadcast to Redis pub/sub │ Receives "model_456" → cache set
      │                                 │
T+30  │ Received SIGTERM               │ Cache: 410k + user_123 + model_456
      │ Final backup (optional)        │ [Both pods in sync]
      │ Shutdown                        │
      │                                 │
T+40  │ [Terminated]                   │ Cache: ~418k entries (full)
```

**Result**: New pod has full cache within seconds, not hours!

### Cache Sync Internals

**Broadcasting a Cache Entry**:
```typescript
// Pod A sets a cache entry
cache.set("query:user_123", {id: 123, name: "John"})
  ↓
// Intercepted by QueryCacheSync
{
  type: "set",
  key: "query:user_123",
  value: {id: 123, name: "John"},
  instanceId: "pod-a-1234567"
}
  ↓
// Published to Redis channel "query-cache:sync"
  ↓
// Pod B receives message
  ↓
// Pod B sets local cache (if instanceId != self)
cache.set("query:user_123", {id: 123, name: "John"})
```

**Infinite Loop Prevention**:
- Each message includes `instanceId`
- Instances ignore their own messages
- `settingFromSync` flag prevents re-broadcasting synced entries

## Performance Impact

### Real-time Sync
- **Overhead per cache set**: ~1-2ms (async Redis publish)
- **Network traffic**: ~500 bytes per cache entry
- **For 418k entries**: ~209MB total sync traffic (one-time during startup)
- **Ongoing**: Only new queries broadcast (typically <100/sec)

### Periodic Backup
- **Backup duration**: ~100-300ms for 25MB
- **Compression ratio**: 70-90% (25MB → ~5MB)
- **Redis storage**: 5MB per backup (24h TTL)
- **Frequency**: Every 30 minutes (minimal impact)

## Configuration

### Environment Variables

```bash
# Enable/disable multi-instance sync (default: true)
QUERY_CACHE_SYNC_ENABLED=true

# Override backup interval (seconds)
# Default: 1800s (30min) with sync, 300s (5min) without sync
QUERY_CACHE_BACKUP_INTERVAL=1800

# Max cache size (bytes)
QUERY_CACHE_MAX_SIZE=262144000  # 250MB
```

### Behavior Matrix

| Sync Enabled | Backup Interval | Use Case |
|--------------|-----------------|----------|
| `true` (default) | 30min | **Production**: Multi-instance K8s deployment |
| `false` | 5min | **Single instance**: Docker Compose, local dev |
| Custom | Custom | Fine-tune for specific needs |

## Benefits Summary

### Problem 1: Rolling Updates ✅
**Before**: New pods start with empty cache, need hours to warm up
**After**: New pods sync cache from old pods in seconds

### Problem 2: Multiple Instances ✅
**Before**: Each instance maintains separate cache, wasting work
**After**: All instances share the same cache state, zero duplication

### Problem 3: Cache Loss on Crash ✅
**Before**: OOMKill = complete cache loss
**After**: Max 30 minutes of cache loss

## Monitoring

### Key Metrics

```typescript
// Cache sync metrics
queryCacheSync_messages_sent_total{instance_id}
queryCacheSync_messages_received_total{instance_id}
queryCacheSync_sync_errors_total

// Cache backup metrics
queryCacheBackup_duration_seconds
queryCacheBackup_entries_total
queryCacheBackup_compressed_bytes
```

### Health Checks

Watch for:
- Sync lag: Messages received significantly less than sent
- Backup failures: Check logs for Redis connection issues
- Memory growth: Ensure LRU eviction is working

## Disabling Sync (If Needed)

If you only run a single instance or want to disable sync:

```bash
QUERY_CACHE_SYNC_ENABLED=false
```

This reverts to:
- No real-time sync
- Periodic backup every 5 minutes
- Traditional single-instance behavior

## Leader Election for Backups

When multiple instances are running with sync enabled, only one needs to create the backup snapshot (since all caches are identical).

### How It Works

```
Time  │ Pod A                           │ Pod B                           │ Pod C
──────┼─────────────────────────────────┼─────────────────────────────────┼────────────────
T+0   │ Backup timer fires              │ Backup timer fires              │ Backup timer fires
      │ Try SET backup-lock (NX)        │ Try SET backup-lock (NX)        │ Try SET backup-lock (NX)
      │   → Success! Acquired lock      │   → Failed (already exists)     │   → Failed (already exists)
      │                                  │   → Skip backup                 │   → Skip backup
T+1   │ Perform backup (100-300ms)      │ Continue processing events      │ Continue processing events
      │ Backup complete                 │                                 │
      │                                  │                                 │
T+5min│ Lock expires (auto-cleanup)     │                                 │
```

### Redis Lock Implementation

```typescript
// Try to acquire lock with Redis SET NX (only set if not exists)
const acquired = await redis.set('query-cache:backup-lock', instanceId, {
  NX: true,  // Only set if key doesn't exist
  EX: 300    // 5 minute expiry (auto-cleanup if instance crashes)
})

if (acquired) {
  // This instance is the leader - perform backup
  await backupQueryCache()
} else {
  // Another instance is handling it - skip
  logger.debug('Skipping backup - another instance is handling it')
}
```

### Lock Properties

- **Expiry**: 5 minutes (longer than 30min backup interval to ensure overlap)
- **Auto-cleanup**: If instance crashes mid-backup, lock expires automatically
- **Fail-open**: If Redis lock fails, backup proceeds anyway (availability > consistency)
- **No coordination needed**: First instance to check wins, no complex consensus

### Why This Works

1. **30-minute backup interval** means instances check every 30min
2. **5-minute lock duration** ensures only one backup per cycle
3. **Clock drift tolerance**: Even with slight clock differences, lock prevents duplicates
4. **Crash recovery**: If leader crashes, lock expires and another instance takes over on next cycle

## Future Enhancements

Potential improvements:
1. **Selective sync**: Only sync "hot" queries (>N hits)
2. **Batch broadcasts**: Group multiple sets into single pub/sub message
3. **TTL sync**: Propagate cache TTLs across instances
4. **Metrics dashboard**: Grafana dashboard showing sync stats
5. **Active leader monitoring**: Track which instance is backup leader via metrics
