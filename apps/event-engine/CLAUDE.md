# Metric Event Watcher - Development Guide

## Project Overview

This is a high-performance microservice that maintains real-time metrics for the Civitai platform by consuming database events via Kafka/Debezium (CDC). It replaces manual metric tracking with automated event processing.

### Purpose
- Listen to PostgreSQL changes via Debezium CDC
- Process ClickHouse events via Kafka
- Update entity metrics in ClickHouse (batched)
- Maintain Redis caches (real-time)
- Update Meilisearch indexes (batched)

### Architecture
- **Event-Driven**: Kafka consumer with Debezium for PostgreSQL CDC
- **Parallel Processing**: Worker pool for concurrent event handling
- **Batching**: Efficient batching for ClickHouse (30s) and Meilisearch (5min)
- **Handler Pattern**: Factory-based handlers for different entity types

## Project Structure

```
metric-event-watcher/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── config/
│   │   └── index.ts               # Configuration management
│   ├── services/
│   │   ├── event-processor.ts     # Central event routing
│   │   ├── worker-pool.ts         # Parallel task processing
│   │   ├── debezium-manager.ts    # CDC connector management
│   │   ├── redis-cache.ts         # Redis cache updates
│   │   ├── metric-excluded-users.ts # Reaction-farm exclusion list, mirrored from ClickHouse
│   │   ├── metric-event-batcher.ts # ClickHouse batch inserts
│   │   ├── index-update-queue.ts  # Meilisearch updates
│   │   └── health-check.ts        # Health monitoring
│   ├── handlers/
│   │   ├── base.ts               # Handler factories & helpers
│   │   ├── index.ts              # Handler registry
│   │   ├── outbox/               # Outbox pattern handlers
│   │   │   ├── model.ts
│   │   │   ├── model-version.ts
│   │   │   └── post.ts
│   │   └── [entity-handlers].ts  # Entity-specific handlers
│   ├── common/
│   │   ├── services/
│   │   │   ├── metrics.ts       # Metric utilities
│   │   │   └── outbox.ts        # Outbox service
│   │   ├── types/
│   │   │   └── metric-types.ts  # Metric type definitions
│   │   └── utils/
│   │       └── query-utils.ts   # Query helpers
│   ├── types/                    # Core type definitions
│   └── utils/                    # Utilities
├── scripts/
│   ├── generate-types.ts         # Generate & test handlers
│   ├── setup-*.ts                # Setup scripts
│   └── sql/                      # SQL scripts
├── docs/
│   ├── plans/
│   │   └── initial.md           # Original project plan
│   ├── reference/               # Reference docs
│   └── generated-metrics.md    # Generated metrics docs
├── .claude/
│   └── commands/prime/
│       └── dev-handlers.md      # Handler development guide
├── docker-compose.yml           # Kafka/Debezium infrastructure
├── package.json
└── .env.example                # Environment variables

```

## Key Components

### Services (`src/services/`)
- **EventProcessor**: Central orchestrator routing events to handlers
- **WorkerPool**: Multi-threaded parallel processing
- **DebeziumManager**: PostgreSQL CDC connector management
- **MetricEventBatcher**: ClickHouse batch inserts
- **IndexUpdateQueue**: Meilisearch index updates
- **RedisCache**: Real-time metric cache updates
- **MetricExcludedUsers**: Mirrors the ClickHouse `metricExcludedUsers` reaction-farm list into memory (refreshed every `METRIC_EXCLUSION_REFRESH_MS`). `RedisCache` and the live signal path skip events from users in it, matching what the ClickHouse metric aggregates already filter

### Handlers (`src/handlers/`)
- handlers for different entity types (User, Model, Post, Image, etc.)
- Factory patterns: `createEventHandler()`, `createReactionHandler()`
- See `.claude/commands/prime/dev-handlers.md` for handler development guide

### Event Flow
1. Database change → Debezium captures → Publishes to Kafka
2. EventProcessor consumes → Routes to handlers
3. WorkerPool processes → Updates metrics:
   - ClickHouse: Batched entity events
   - Redis: Immediate cache updates
   - Meilisearch: Batched index updates

## Quick Reference

### Common Tasks
- **Add new handler**: Create in `src/handlers/`, register in `src/handlers/index.ts`
- **Test handlers**: Use `scripts/generate-types.ts` to verify metric outputs

### Important Files
- Initial plan: `docs/plans/initial.md`
- Handler guide: `.claude/commands/prime/dev-handlers.md`
- Generated metrics: `docs/generated-metrics.md`
- Configuration: `src/config/index.ts`