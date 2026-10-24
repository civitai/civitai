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
    // How often the reaction-farm exclusion list is re-read from ClickHouse. The
    // admin endpoint that writes it documents the effect as landing "within ~5
    // min", so matching that keeps the increment path no staler than the promise
    // already made about the aggregate. MetricExcludedUsers floors this at 1s —
    // it drives a setInterval, so an unparseable value would otherwise become a
    // 1ms query loop against ClickHouse from every pod.
    metricExclusionRefreshMs: parseInt(process.env.METRIC_EXCLUSION_REFRESH_MS ?? '300000', 10),
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

    // Streamed by the connector but not consumed by the metrics watcher (only by
    // vector-sync). Adding a table here changes the Debezium publication, and the
    // watcher recreates the connector on startup, so each entry is opt-in.
    cdcOnlyTables: process.env.CDC_IMAGE_ENABLED === 'true' ? ['public.Image'] : [],

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
  },
  // Semantic image search: see docs/features/semantic-image-search.md at the repo root.
  vectorSync: {
    consumerGroup: process.env.VECTOR_SYNC_CONSUMER_GROUP ?? 'image-vector-sync',
    pgPoolMax: Math.max(1, parseInt(process.env.VECTOR_PG_POOL_MAX ?? '4', 10)),
    // Off: nothing embeds (a paid call). The consumer and reconcile still delete and update
    // payloads; backfill refuses to run. Embedding also needs CDC_IMAGE_ENABLED, see
    // embedBlockedReason in vector-sync/sync.ts.
    embedEnabled: process.env.VECTOR_SYNC_EMBED_ENABLED === 'true',
    // Events for one image arriving within this window collapse into one re-read.
    debounceMs: parseInt(process.env.VECTOR_SYNC_DEBOUNCE_MS ?? '5000', 10),
    qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
    // Writes go to the collection, reads to the alias, so a model migration can fill a new
    // collection while the old one keeps serving.
    collection: process.env.VECTOR_COLLECTION ?? 'images_wemm2b_256_v1',
    alias: process.env.VECTOR_ALIAS ?? 'images_semantic',
    // Image CDN base the edge URLs are built on (the main app's NEXT_PUBLIC_IMAGE_LOCATION).
    imageLocation: process.env.VECTOR_IMAGE_LOCATION ?? '',
    orchestratorEndpoint: process.env.ORCHESTRATOR_ENDPOINT ?? '',
    embedToken: process.env.VECTOR_EMBED_TOKEN ?? '',
    // Orchestrator jobs in flight per process: one per step, i.e. per image. An upper bound: the
    // orchestrator's per-account quota (its RateLimit headers) usually lowers it.
    embedMaxInFlight: Math.max(1, parseInt(process.env.VECTOR_EMBED_MAX_IN_FLIGHT ?? '500', 10) || 500),
    embedMaxRetries: parseInt(process.env.VECTOR_EMBED_MAX_RETRIES ?? '8', 10),
    // Inputs per workflow, 1 to 128.
    embedBatchSize: Math.min(128, Math.max(1, parseInt(process.env.VECTOR_EMBED_BATCH_SIZE ?? '128', 10) || 128)),
    embedVideo: process.env.VECTOR_EMBED_VIDEO === 'true',
  },
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
