-- ClickHouse Kafka Producer Setup
-- Kafka Broker: 24.144.71.35:9094
-- Topics: clickhouse.{tableName}
-- Data Flow: ClickHouse Tables → Materialized Views → Kafka Topics

-- ============================================
-- 1. Kafka Producer for entityMetricEvents
-- ============================================
/*
-- Let's not do this one for now
CREATE TABLE IF NOT EXISTS default.kafka_producer_entityMetricEvents
(
    entityType  LowCardinality(String),
    entityId    Int32,
    userId      Int32,
    metricType  LowCardinality(String),
    metricValue Int32,
    createdAt   DateTime64(3)
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = '24.144.71.35:9094',
    kafka_topic_list = 'clickhouse.entityMetricEvents',
    kafka_format = 'JSONEachRow',
    kafka_thread_per_consumer = 0,
    kafka_num_consumers = 1;

-- Materialized View to stream data from entityMetricEvents to Kafka
CREATE MATERIALIZED VIEW IF NOT EXISTS default.mv_entityMetricEvents_to_kafka TO default.kafka_producer_entityMetricEvents AS
SELECT
    entityType,
    entityId,
    userId,
    metricType,
    metricValue,
    createdAt
FROM default.entityMetricEvents;
*/

-- ============================================
-- 2. Kafka Producer for modelVersionEvents (Download events only)
-- ============================================
-- Simplified to only include: modelId, modelVersionId, userId
CREATE TABLE IF NOT EXISTS default.kafka_producer_modelVersionEvents
(
    modelId        Int32,
    modelVersionId Int32,
    userId         Int32
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = '24.144.71.35:9094',
    kafka_topic_list = 'clickhouse.modelVersionEvents',
    kafka_group_name = 'clickhouse-event-watcher',
    kafka_format = 'JSONEachRow',
    kafka_thread_per_consumer = 0,
    kafka_num_consumers = 1;

-- Materialized View to stream Download events from modelVersionEvents to Kafka
CREATE MATERIALIZED VIEW IF NOT EXISTS default.mv_modelVersionEvents_to_kafka TO default.kafka_producer_modelVersionEvents AS
SELECT
    modelId,
    modelVersionId,
    userId
FROM default.modelVersionEvents
WHERE type = 'Download' AND userId NOT IN (-1, 490053);  -- Only send Download events to Kafka

-- ============================================
-- 3. Kafka Producer for jobs (TextToImage jobs only)
-- ============================================
-- Simplified to only include: jobId, userId, jobType, remixOfId, resourcesUsed
CREATE TABLE IF NOT EXISTS orchestration.kafka_producer_jobs
(
    userId        Int32,
    jobType       LowCardinality(String),
    remixOfId     Nullable(String),
    resourcesUsed Array(Int32)
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = '24.144.71.35:9094',
    kafka_topic_list = 'clickhouse.jobs',
    kafka_group_name = 'clickhouse-event-watcher',
    kafka_format = 'JSONEachRow',
    kafka_thread_per_consumer = 0,
    kafka_num_consumers = 1;

-- Materialized View to stream specific job types from jobs to Kafka
CREATE MATERIALIZED VIEW IF NOT EXISTS orchestration.mv_jobs_to_kafka TO orchestration.kafka_producer_jobs AS
SELECT
    userId,
    jobType,
    remixOfId,
    resourcesUsed
FROM orchestration.jobs
WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy');  -- Only send specific job types to Kafka

-- ============================================
-- 4. Kafka Producer for buzz_resource_compensation
-- ============================================
CREATE TABLE IF NOT EXISTS default.kafka_producer_buzz_resource_compensation
(
    date           DateTime,
    modelVersionId Int32,
    comp           UInt32,
    tip            UInt32,
    total          UInt32,
    updated_at     DateTime,
    count          Int32
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = '24.144.71.35:9094',
    kafka_topic_list = 'clickhouse.buzz_resource_compensation',
    kafka_group_name = 'clickhouse-event-watcher',
    kafka_format = 'JSONEachRow',
    kafka_thread_per_consumer = 0,
    kafka_num_consumers = 1;

-- Materialized View to stream data from buzz_resource_compensation to Kafka
CREATE MATERIALIZED VIEW IF NOT EXISTS default.mv_buzz_resource_compensation_to_kafka TO default.kafka_producer_buzz_resource_compensation AS
SELECT
    date,
    modelVersionId,
    comp,
    tip,
    total,
    updated_at,
    count
FROM default.buzz_resource_compensation
WHERE final = true;

-- ============================================
-- Utility Commands
-- ============================================

-- To test data streaming to Kafka:
-- INSERT INTO default.modelVersionEvents VALUES ('Download', now(), 123, 456, 789, false, '127.0.0.1', 'Mozilla/5.0', false, 'device123');
-- INSERT INTO orchestration.jobs VALUES ('job-123', 456, 'TextToImageV2', now(), now(), 'provider1', 'issuer1', 0.5, 0.1, [1,2,3], null, null, 1.0, 3);
-- INSERT INTO default.buzz_resource_compensation VALUES (now(), 789, 100, 10, 110, now(), 5);

-- To detach/attach Materialized Views (pause/resume streaming):
-- DETACH TABLE default.mv_modelVersionEvents_to_kafka;
-- ATTACH TABLE default.mv_modelVersionEvents_to_kafka;

-- To monitor Kafka producer activity:
-- SELECT * FROM system.kafka_consumers WHERE database = 'default';

-- To drop everything (if needed):
/*
DROP VIEW IF EXISTS default.mv_modelVersionEvents_to_kafka;
DROP TABLE IF EXISTS default.kafka_producer_modelVersionEvents;
DROP VIEW IF EXISTS orchestration.mv_jobs_to_kafka;
DROP TABLE IF EXISTS orchestration.kafka_producer_jobs;
DROP VIEW IF EXISTS default.mv_buzz_resource_compensation_to_kafka;
DROP TABLE IF EXISTS default.kafka_producer_buzz_resource_compensation;
*/

-- ============================================
-- Configuration Notes
-- ============================================
-- Data Flow:
-- 1. Data is inserted/updated in ClickHouse tables
-- 2. Materialized Views capture new inserts
-- 3. Views push data to Kafka producer tables
-- 4. Kafka engine automatically sends to topics
--
-- Important:
-- - Materialized views only capture NEW inserts after creation
-- - To stream existing data, use INSERT INTO kafka_producer_* SELECT * FROM source_table
-- - Kafka tables act as producers when used as MV targets
-- - JSONEachRow format for easy consumption by Node.js/Python consumers
--
-- Performance Notes:
-- - kafka_thread_per_consumer = 0: Optimized for producer mode
-- - kafka_num_consumers = 1: Producer mode setting
-- - Messages are batched automatically for efficiency
-- - Consider partitioning Kafka topics for parallel processing