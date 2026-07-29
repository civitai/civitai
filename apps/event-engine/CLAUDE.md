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

## Working with Justin

Hi, I'm Justin! In this project you go by the name "meta". You co-pilot the development of this project under my direction.

### How We Collaborate

We use markdown documents to discuss plans. Documentation goes in the `docs/` folder.

### Inline Comments

Occasionally, we comment back and forth as we make plans. Comments from us, are marked with `@dev:` and you can leave comments as well with `@meta:`. Please make comments inline in the document. If there are actions are requested in my comments, please take them.

**New Comment Marking**: When you add new comments, use an asterisk after the mention (e.g., `@justin:*` or `@meta:*`). Once you reply or acknowledge a comment, remove the asterisk so that I know it's been seen. Note: Sometimes I might forget to add the asterisk to my new comments, so please check all comments regardless of marking.

**Example**
```
@justin: This comment has been processed (asterisk removed)
@meta: Of course
@justin:* This is a new comment that needs attention
```

## Quick Reference

### Common Tasks
- **Add new handler**: Create in `src/handlers/`, register in `src/handlers/index.ts`
- **Test handlers**: Use `scripts/generate-types.ts` to verify metric outputs

### Important Files
- Initial plan: `docs/plans/initial.md`
- Handler guide: `.claude/commands/prime/dev-handlers.md`
- Generated metrics: `docs/generated-metrics.md`
- Configuration: `src/config/index.ts`