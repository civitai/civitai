# Debezium

The goal of this project is to move from manually tracking a bunch of different events that affect metrics to instead just listening for events via pg->debezium, clickhouse->kafka_sink (kafka engine table), and ultimately Kafka. Then a microservice will handle the events and batch insert the appropriate entityMetricEvents to clickhouse and hincby the appropriate amount to the corresponding redis caches.

### How it'll work
1. Events will stream through Kafka to microservice
2. Microservice will create entityMetricEvent in clickhouse
3. When metric data is needed, it's fetched from clickhouse
4. Once fetched, the metric data is cached in redis and future events will increment the cached data in realtime as things happen

**When Metric Events Occur**:
- Event logged to clickhouse
- Redis cache updated (if it exists)
- Meilisearch index queued for entity (models, posts, images)

**Change to meilisearch index updates**:
- No longer updating the full document, just updating the metrics
- When processing, fetch metrics for all docs that need to be updated grouped by timeframes from clickhouse
- Write all metric updates as part of a single batch
- Run every 5 minutes to keep queue small.

## Mapping Metrics to events

**Annotation Guide**:
- `pg|ch`: where the event happens (postgres or clickhouse)
- `c|u|d`: what type of event it triggers on (created, update, delete)
- table the event happens on
The result is something like: `pg cd userEngagement` which means Postgres creates and deletes on the UserEngagement table.

### UserMetric
- `followingCount: Int` pg cd userEngagement
- `followerCount: Int` pg cd userEngagement
- `reactionCount: Int` pg cd imageReaction
- `hiddenCount: Int` pg cd userEngagement
- `uploadCount: Int` pg cud modelVersion
- `reviewCount: Int` pg cud resourceReview
- `answerCount: Int` deprecated
- `answerAcceptCount: Int` deprecated

### ModelMetric
- `rating: Float` pg cud resourceReview
- `ratingCount: Int` pg cud resourceReview
- `downloadCount: Int` ch modelVersionEvent
- `favoriteCount: Int` pg cd collectionItem
- `commentCount: Int` pg cd comment
- `collectedCount: Int` pg cd collectionItem
- `imageCount: Int` pg cd imageResourceNew
- `tippedCount: Int` pg c buzzTip
- `tippedAmountCount: Int` pg c buzzTip
- `generationCount: Int` ch c orchestration.jobs
- `thumbsUpCount: Int` pg cud resourceReview
- `thumbsDownCount: Int` pg cud resourceReview
- `earnedAmount: Int` ch c buzz_resource_compensation

### ModelVersionMetric
- `rating: Float` pg cud resourceReview
- `ratingCount: Int` pg cud resourceReview
- `downloadCount: Int` ch modelVersionEvent
- `favoriteCount: Int` pg cd collectionItem
- `commentCount: Int` pg cd comment
- `collectedCount: Int` pg cd collectionItem
- `imageCount: Int` pg cd imageResourceNew
- `tippedCount: Int` pg c buzzTip
- `tippedAmountCount: Int` pg c buzzTip
- `generationCount: Int` ch c orchestration.jobs
- `thumbsUpCount: Int` pg cud resourceReview
- `thumbsDownCount: Int` pg cud resourceReview
- `earnedAmount: Int` ch c buzz_resource_compensation

### ModelMetricDaily
- `type: String` deprecated
- `count: Int` deprecated

### PostMetric
- `likeCount: Int` pg cd imageReaction
- `dislikeCount: Int` pg cd imageReaction
- `laughCount: Int` pg cd imageReaction
- `cryCount: Int` pg cd imageReaction
- `heartCount: Int` pg cd imageReaction
- `commentCount: Int` pg cd commentv2
- `collectedCount: Int` pg cd collectionItem
- `ageGroup: MetricTimeframe` deprecated

### ImageMetric
- `likeCount: Int` pg cd imageReaction
- `dislikeCount: Int` pg cd imageReaction
- `laughCount: Int` pg cd imageReaction
- `cryCount: Int` pg cd imageReaction
- `heartCount: Int` pg cd imageReaction
- `commentCount: Int` pg cd commentv2
- `collectedCount: Int` pg cd collectionItem
- `tippedCount: Int` pg c buzzTip
- `tippedAmountCount: Int` pg c buzzTip
- `viewCount: Int` deprecated
- `reactionCount: Int` pg cd imageReaction

### CollectionMetric
- `followerCount: Int` pg cd collectionContributor
- `itemCount: Int` pg cd collectionItem
- `contributorCount: Int` pg cd collectionContributor

### TagMetric
- `modelCount: Int` pg cd tagsOnModel
- `imageCount: Int` pg cud tagsOnImageNew
- `postCount: Int` pg cud tagsOnPost
- `articleCount: Int` pg cd tagsOnArticle
- `hiddenCount: Int` pg cd tagEngagement
- `followerCount: Int` pg cd tagEngagement

### QuestionMetric - Deprecated
- `heartCount: Int`
- `commentCount: Int`
- `answerCount: Int`

### AnswerMetric - Deprecated
- `checkCount: Int`
- `crossCount: Int`
- `heartCount: Int`
- `commentCount: Int`

### ArticleMetric
- `likeCount: Int` pg cd articleReaction
- `dislikeCount: Int` pg cd articleReaction
- `laughCount: Int` pg cd articleReaction
- `cryCount: Int` pg cd articleReaction
- `heartCount: Int` pg cd articleReaction
- `commentCount: Int` pg cd commentv2
- `viewCount: Int` deprecated
- `favoriteCount: Int` pg cd collectionItem
- `hideCount: Int` pg cd articleEngagement
- `collectedCount: Int` pg cd collectionItem
- `tippedCount: Int` pg c buzzTip
- `tippedAmountCount: Int` pg c buzzTip

### BountyMetric
- `favoriteCount: Int` pg cd bountyEngagement
- `trackCount: Int` pg cd bountyEngagement
- `entryCount: Int` pg cd bountyEntry
- `benefactorCount: Int` pg cd bountyBenefactor
- `unitAmountCount: Int` pg cd bountyBenefactor
- `commentCount: Int` pg cd commentv2

### BountyEntryMetric
- `likeCount: Int` pg cd bountyEntryReaction
- `dislikeCount: Int` pg cd bountyEntryReaction
- `laughCount: Int` pg cd bountyEntryReaction
- `cryCount: Int` pg cd bountyEntryReaction
- `heartCount: Int` pg cd bountyEntryReaction
- `unitAmountCount: Int` pg u bountyBenefactor
- `tippedCount: Int` pg c buzzTip
- `tippedAmountCount: Int` pg c buzzTip

### ClubPostMetric - Deprecated
- `likeCount: Int`
- `dislikeCount: Int`
- `laughCount: Int`
- `cryCount: Int`
- `heartCount: Int`

### ClubMetric - Deprecated
- `memberCount: Int`
- `clubPostCount: Int`
- `resourceCount: Int`

## Mapping events to search index updates
- Metric changes: ch c entityMetricEvents
- model created/deleted/published: pg cud model
- model version created/deleted/published: pg cud modelVersion
- model tags changed: pg cd tagsOnModel
- post created/deleted/unpublished: pg cud post
- post tags changing: pg cd tagsOnPost
- post cover image changing: pg cud image

---

## Implementation Plan

### 1. Setup infrastructure
- Kafka
- PG Debezium
- Clickhouse -> kafka engine mv

### 2. Develop event listening microservice
- Listens to all appropriate kafka events
- Multi-threaded pool of workers that process events
- Ability to register a "listener" that has a `canHandle` function. If true, then it's work will be queued to be handled by the worker pool
- Workers make calls to main process to:
  - Queue entityMetricEvent addition
  - Update Redis cache (only for `entityEventMetrics`)
    - Signal metric change to listeners
  - Queue index updates (only for `entityEventMetrics`)
- By listening to inserts to `entityEventMetrics` we:
    - Updates corresponding redis cache (if exists)
    - Queues index updates for relevant entity types and metrics

**Connections**:
- Kafka: Listening to events
- Postgres: fetching additional data
- Redis: updating caches

**Batch Processing**:
- `entityEventMetrics` Clickhouse Inserts: Every 30s additions are bulk inserted to clickhouse
- Meilisearch Index Metrics: Every 5 minutes the index update queue is processed and the metric document updates are sent to the corresponding indexes.

### 3. Replace metrics in civitai codebase (this codebase)
- Make all metrics read from redis->clickhouse (like the image metric cache)
- Replace all fetches from the database to instead pull from the redis cache helper

### 4. Add feed index for Models and Posts (similar to image index)
- Keep it IDs and numbers only with the raw data needed for filters and sorts docs\plans\post-model-feed.md
- Replace fetches against DB to be against indexes using Flipt (as outlined in plan doc)

### 5. Backfill `entityEventMetrics`
- For each entityType, metricType, and entity
  - Get oldest `entityEventMetrics` for corresponding entityType, metricType and id
  - Add all events prior to that using `createdAt` or `updatedAt` of source data

### 6. Rollout
- Rollout using Flipt to have both running in parallel for a while

### 7. Clean-up Deprecated Stuff
*Only after things are working*
- Remove all metric tables that have been replaced
- Remove all metric computation jobs
- Remove Rank tables that aren't used anymore

### 8. Realtime Metric (Stretch)
- Subscribe to metric signals for all loaded content and inc metrics based on signals
- Show number of people "viewing" content (based on subscription count)
