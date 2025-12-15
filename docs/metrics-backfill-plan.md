# Metrics Backfill Plan: PostgreSQL to ClickHouse

## Overview

Backfill metric data from PostgreSQL metric tables to ClickHouse `entityMetricEvents_new` table. This will allow us to have a unified source of truth for metrics in ClickHouse with version 3 indicating backfilled data.

## Decisions Summary

| Decision | Value |
|----------|-------|
| Timeframe | `AllTime` only |
| Version | `3` (backfill identifier) |
| userId | `-1` (backfill marker) |
| Metric naming | **Use existing ClickHouse conventions** |
| createdAt | Fixed configurable date |
| Re-run behavior | Delete existing backfill data before insert |
| Execution | One table at a time via CLI argument |

## Column Mapping: PostgreSQL → ClickHouse

### Article
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| likeCount | `Like` | existing |
| dislikeCount | `Dislike` | **new** |
| laughCount | `Laugh` | existing |
| cryCount | `Cry` | existing |
| heartCount | `Heart` | existing |
| commentCount | `commentCount` | existing |
| viewCount | `viewCount` | **new** |
| collectedCount | `collectedCount` | existing |
| tippedCount | `tippedCount` | existing |
| tippedAmountCount | `tippedAmount` | existing |

### Bounty
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| favoriteCount | `favoriteCount` | existing |
| trackCount | `trackCount` | existing |
| entryCount | `entryCount` | existing |
| benefactorCount | `benefactorCount` | existing |
| unitAmountCount | `unitAmount` | existing |
| commentCount | `commentCount` | existing |

### BountyEntry
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| likeCount | `Like` | existing |
| dislikeCount | `Dislike` | **new** |
| laughCount | `Laugh` | existing |
| cryCount | `Cry` | existing |
| heartCount | `Heart` | existing |
| unitAmountCount | `unitAmount` | existing |
| tippedCount | `tippedCount` | **new** |
| tippedAmountCount | `tippedAmount` | **new** |

### Collection
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| followerCount | `followerCount` | existing |
| itemCount | `itemCount` | existing |
| contributorCount | `contributorCount` | existing |

### Image
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| likeCount | `ReactionLike` | existing (using newer convention) |
| dislikeCount | `ReactionDislike` | **new** |
| laughCount | `ReactionLaugh` | existing |
| cryCount | `ReactionCry` | existing |
| heartCount | `ReactionHeart` | existing |
| commentCount | `Comment` | existing |
| collectedCount | `Collection` | existing |
| tippedCount | `tippedCount` | existing |
| tippedAmountCount | `tippedAmount` | existing |
| viewCount | `viewCount` | **new** |

### Model
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| downloadCount | `downloadCount` | existing |
| thumbsUpCount | `thumbsUpCount` | existing |
| thumbsDownCount | `thumbsDownCount` | existing |
| commentCount | `commentCount` | existing |
| collectedCount | `collectedCount` | existing |
| generationCount | `generationCount` | existing |
| imageCount | `imageCount` | existing |
| tippedCount | `tippedCount` | existing |
| tippedAmountCount | `tippedAmount` | existing |
| earnedAmount | `earnedAmount` | **new** |
| ratingCount | `ratingCount` | existing |

### ModelVersion
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| downloadCount | `downloadCount` | existing |
| thumbsUpCount | `thumbsUpCount` | existing |
| thumbsDownCount | `thumbsDownCount` | existing |
| commentCount | `commentCount` | **new** |
| collectedCount | `collectedCount` | **new** |
| generationCount | `generationCount` | existing |
| imageCount | `imageCount` | existing |
| tippedCount | `tippedCount` | **new** |
| tippedAmountCount | `tippedAmount` | **new** |
| earnedAmount | `earnedAmount` | **new** |
| ratingCount | `ratingCount` | existing |

### Post
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| likeCount | `Like` | existing |
| dislikeCount | `Dislike` | **new** |
| laughCount | `Laugh` | existing |
| cryCount | `Cry` | existing |
| heartCount | `Heart` | existing |
| commentCount | `commentCount` | existing |
| collectedCount | `collectedCount` | existing |
| tippedCount | `tippedCount` | existing |
| tippedAmountCount | `tippedAmount` | existing |

### Tag
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| modelCount | `modelCount` | **new** |
| imageCount | `imageCount` | **new** |
| postCount | `postCount` | **new** |
| articleCount | `articleCount` | **new** |
| hiddenCount | `hiddenCount` | existing |
| followerCount | `followerCount` | **new** |

### User
| PG Column | CH metricType | Status |
|-----------|---------------|--------|
| followerCount | `followerCount` | existing |
| followingCount | `followingCount` | existing |
| reactionCount | `reactionCount` | existing |
| hiddenCount | `hiddenCount` | existing |
| uploadCount | `uploadCount` | **new** |
| reviewCount | `reviewCount` | **new** |

## ClickHouse Target Table

```sql
CREATE TABLE default.entityMetricEvents_new (
  `entityType` LowCardinality(String),
  `entityId` Int32,
  `userId` Int32,
  `metricType` LowCardinality(String),
  `metricValue` Int32,
  `createdAt` DateTime,
  `version` UInt8 DEFAULT 2
) ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(createdAt)
ORDER BY (entityType, entityId, createdAt)
SETTINGS index_granularity = 8192
```

## Implementation Plan

### File Structure

```
scripts/metric-migration/
├── backfill-metrics.ts           # Main backfill script
├── metric-backfill-config.ts     # Configuration with column mappings
└── README.md                     # Usage instructions
```

### Usage

```bash
# Backfill a specific table
npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric

# Backfill with custom date
npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric --date 2025-01-21

# Dry run (no insert)
npx ts-node scripts/metric-migration/backfill-metrics.ts --table BountyMetric --dry-run
```

### Config Structure

```typescript
type MetricMapping = {
  pgColumn: string;      // PostgreSQL column name
  chMetricType: string;  // ClickHouse metricType value
};

type MetricTableConfig = {
  table: string;         // PostgreSQL table name
  entityType: string;    // ClickHouse entityType value
  idField: string;       // Primary key field name
  metrics: MetricMapping[];
};
```

### Algorithm

```
1. Parse CLI args (--table, --date, --dry-run, --batch-size)
2. Validate table exists in config
3. Delete existing backfill data for this entityType:
   DELETE FROM entityMetricEvents_new
   WHERE entityType = '{entityType}' AND version = 3
4. Fetch all entity IDs with AllTime metrics
5. Process in batches:
   for each batch of entity IDs:
     - Fetch metric rows from PostgreSQL
     - Transform each metric column using mapping:
       {
         entityType,
         entityId,
         userId: -1,
         metricType: mapping.chMetricType,  // Use mapped name
         metricValue: row[mapping.pgColumn],
         version: 3,
         createdAt: configuredDate
       }
     - Bulk insert to ClickHouse
6. Log progress and final stats
```

### Data Flow Example

```
PostgreSQL (BountyMetric)              ClickHouse (entityMetricEvents_new)
┌─────────────────────────────┐        ┌─────────────────────────────────┐
│ bountyId | timeframe | ...  │        │ entityType | entityId | ...     │
│ 1        | AllTime   |      │   →    │ Bounty     | 1        | ...     │
│          | favoriteCount: 5 │        │                                 │
│          | unitAmountCount: 100      │ Bounty, 1, -1, favoriteCount, 5 │
└─────────────────────────────┘        │ Bounty, 1, -1, unitAmount, 100  │
                                       └─────────────────────────────────┘
                                       (note: unitAmountCount → unitAmount)
```

## Execution Order (Recommended)

Start with lowest-load tables first:

1. **BountyMetric** - smallest, good for testing
2. **BountyEntryMetric**
3. **CollectionMetric**
4. **TagMetric**
5. **ArticleMetric**
6. **UserMetric**
7. **PostMetric**
8. **ModelMetric**
9. **ModelVersionMetric**
10. **ImageMetric** - largest, run last

## Next Steps

1. ~~Confirm plan~~ ✓
2. ~~Confirm column mappings~~ (pending review)
3. Implement scripts in `scripts/metric-migration/`
4. Test with BountyMetric
5. Validate data integrity
6. Run remaining tables in order
