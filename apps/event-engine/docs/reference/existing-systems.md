# Existing Systems

This is an outline of systems that already exist that this service will connect to.

## Clickhouse
```
CLICKHOUSE_HOST=https://your-clickhouse-host:8443
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=PASSWORD
```
**Note**: When using this, I'd prefer to use a connection string style instead of individual fields like this...

### Target Tables
*The DDL of the tables we'll be inserting into the kafka engine tables using mat views*
```sql
create table default.entityMetricEvents
(
    entityType LowCardinality(String),
    entityId    Int32,
    userId      Int32,
    metricType LowCardinality(String),
    metricValue Int32,
    createdAt   DateTime64(3)
)
    engine = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
        PARTITION BY toYYYYMM(createdAt)
        ORDER BY (entityType, entityId, createdAt)
        SETTINGS index_granularity = 8192;

create table default.modelVersionEvents
(
    type Enum8('Create' = 1, 'Publish' = 2, 'Download' = 3, 'Unpublish' = 4, 'HideDownload' = 5),
    time           DateTime default now(),
    userId         Int32    default 0,
    modelId        Int32,
    modelVersionId Int32,
    nsfw           Bool,
    ip             String   default '',
    userAgent      String   default '',
    createdDate    Date materialized toDate(time),
    earlyAccess    Bool     default false,
    deviceId       String   default ''
)
    engine = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
        PARTITION BY toYYYYMM(createdDate)
        ORDER BY (time, type, modelId, modelVersionId)
        SETTINGS index_granularity = 8192;
-- It's worth noting that we only care about the 'Download' event here...

create table orchestration.jobs
(
    jobId         String,
    userId        Int32,
    jobType LowCardinality(String),
    createdAt     DateTime64(3),
    completedAt   DateTime64(3),
    provider LowCardinality(String),
    issuedBy      String,
    cost          Float64,
    creatorsTip Nullable(Float64),
    resourcesUsed Array(Int32) default [],
    remixOfId Nullable(String),
    serviceUpgradeFee Nullable(Int16),
    claimDuration Float32      default 0,
    blobsCount    Int16        default 0
)
    engine = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
        ORDER BY createdAt
        SETTINGS index_granularity = 8192;
-- We only care about jobType IN ('TextToImageV2', 'TextToImage', 'Comfy') so filtering before dumping to kafka would be great

create table default.buzz_resource_compensation
(
    date           DateTime,
    modelVersionId Int32,
    comp           UInt32,
    tip            UInt32,
    total          UInt32,
    updated_at     DateTime default now(),
    count          Int32    default 0
)
    engine = SharedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', updated_at)
        ORDER BY (date, modelVersionId)
        SETTINGS index_granularity = 8192;
```


## Postgres
```
DATABASE_URL=postgresql://civitai:PASSWORD@localhost:25061/civitai?schema=public&connection_limit=50
```
Tables we'll be working against here are documented here: docs\reference\schema.prisma

## Redis
```
REDIS_URL=redis://:PASSWORD@redis-host:30274
```

Entity metrics are stored as hSet in `entitymetric:{entityType}:{entityId}`.
The hSet looks like:
```
{
    [metricType as string]: number
}
```
