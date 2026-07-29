import * as dotenv from 'dotenv';

dotenv.config();

export const config = {
  postgres: {
    connectionString: process.env.DATABASE_URL!,
  },
  clickhouse: {
    url: process.env.CLICKHOUSE_URL!,
    metricEventsTable: process.env.CLICKHOUSE_METRIC_EVENTS_TABLE ?? 'entityMetricEvents',
  },
  redis: {
    url: process.env.REDIS_URL!,
    cacheUpdatesEnabled: process.env.REDIS_CACHE_UPDATES_ENABLED !== 'false',
    // Idempotency window for the cache increment. A redelivered Kafka message
    // (rebalance/retry) re-applying the same delta is the cause of cache
    // doubling; a short-lived dedupe marker per (entity, metric, message)
    // makes the increment a no-op on replay. Redelivery from a rebalance lands
    // within seconds, so this only needs to cover the realistic replay gap.
    cacheDedupeTtlSeconds: parseInt(process.env.CACHE_DEDUPE_TTL_SECONDS ?? '3600'),
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    consumerGroup: process.env.KAFKA_CONSUMER_GROUP ?? 'metric-event-watcher',

    // PostgreSQL tables monitored via Debezium CDC
    monitoredTables: [
      'public.UserEngagement',
      'public.ImageReaction',
      'public.ResourceReview',
      'public.CollectionItem',
      'public.Comment',
      'public.CommentV2',
      'public.ImageResourceNew',
      'public.BuzzTip',
      'public.TagEngagement',
      'public.CollectionContributor',
      'public.ArticleReaction',
      'public.BountyEngagement',
      'public.BountyEntry',
      'public.BountyBenefactor',
      'public.BountyEntryReaction',
      'public.Outbox',
      'public.TagsOnPost',
      'public.TagsOnModels',
      'public.TagsOnImageNew',
      'public.TagsOnArticle',
      'public.TagsOnBounty',
      'public.Bounty',
      'public.Article',
      'public.ComicProjectEngagement'
    ],

    // ClickHouse topics streamed directly to Kafka
    clickhouseTopics: [
      'clickhouse.modelVersionEvents',
      'clickhouse.jobs',
      'clickhouse.manual_events',
    ],
  },
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    batchInsertIntervalMs: parseInt(process.env.BATCH_INSERT_INTERVAL ?? '30') * 1000,
    indexUpdateIntervalMs: parseInt(process.env.INDEX_UPDATE_INTERVAL ?? '300') * 1000,
    indexUpdateEnabled: process.env.INDEX_UPDATE_ENABLED !== 'false',
    workerPoolSize: parseInt(process.env.WORKER_POOL_SIZE ?? '10'),
    healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT ?? '3000'),
    // Outbox reconciliation poller. Drains rows a live CDC event never
    // processed (created pre-connector, during downtime, or handler failures).
    // Only claims rows older than the grace window so it never races the
    // real-time Kafka path.
    // DEFAULT ON (opt-out): the poller REQUIRES an `attempts` int column on the
    // "Outbox" table (civitai-db-schema migration 20260720120000_add_outbox_table,
    // now applied). Set OUTBOX_POLL_ENABLED=false to disable. See MIGRATION.md.
    outboxPollEnabled: process.env.OUTBOX_POLL_ENABLED !== 'false',
    outboxPollIntervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL ?? '300') * 1000,
    outboxPollGraceMs: parseInt(process.env.OUTBOX_POLL_GRACE ?? '300') * 1000,
    outboxPollBatchSize: parseInt(process.env.OUTBOX_POLL_BATCH_SIZE ?? '100'),
    // After this many failed attempts a row is "parked": the poller stops
    // re-selecting it (no infinite retry) and logs it for investigation.
    outboxMaxAttempts: parseInt(process.env.OUTBOX_MAX_ATTEMPTS ?? '5'),
  },
  axiom: {
    dataset: process.env.AXIOM_DATASET ?? 'civitai-event-watcher',
    token: process.env.AXIOM_TOKEN ?? '',
  },
  cache: {
    queryCache: {
      maxSize: parseInt(process.env.QUERY_CACHE_MAX_SIZE ?? (250 * 1024 * 1024)+''), // max size in bytes
      syncEnabled: process.env.QUERY_CACHE_SYNC_ENABLED !== 'false', // default: true
      backupKey: process.env.QUERY_CACHE_BACKUP_KEY ?? 'query-cache:backup', // Redis key for backup
      chunkSize: parseInt(process.env.QUERY_CACHE_CHUNK_SIZE ?? '500000'), // entries per chunk (500k ~= 25-50MB uncompressed)
      // When sync is enabled: backup every 30min (cache is shared across instances)
      // When sync is disabled: backup every 5min (need frequent snapshots)
      get backupIntervalMs() {
        const envInterval = process.env.QUERY_CACHE_BACKUP_INTERVAL
        if (envInterval) return parseInt(envInterval) * 1000
        return this.syncEnabled ? 30 * 60 * 1000 : 5 * 60 * 1000
      }
    },
    pgPoolMaxConnections: parseInt(process.env.PG_POOL_MAX_CONNECTIONS ?? '20'),
  },
  signals: {
    apiUrl: process.env.SIGNALS_API_URL ?? '',
    enabled: process.env.SIGNALS_ENABLED !== 'false',
  },
  spine: {
    url: process.env.SPINE_URL ?? '',
    apiKey: process.env.SPINE_API_KEY ?? '',
    kafkaCallbackUrl: process.env.SPINE_KAFKA_CALLBACK_URL ?? 'https://orchestrator-kafka.civitai.com/callback',
  },
  s3: {
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
  }
};

export function validateConfig() {
  const required = [
    'DATABASE_URL',
    'CLICKHOUSE_URL',
    'REDIS_URL',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
