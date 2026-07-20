import { Kafka, EachBatchPayload } from 'kafkajs';
import * as dotenv from 'dotenv';
import pino from 'pino';
import { DebeziumManager } from './services/debezium-manager';
import { getEventProcessor } from './services/event-processor';
import { config, validateConfig } from './config';
import { startHealthServer } from './server';
import { metricBatcherMetrics, eventProcessorMetrics } from './metrics';
import { BatcherBackpressureError, type OffsetSnapshot } from './services/metric-event-batcher';

dotenv.config();

const logger = pino({
  level: config.app.logLevel,
  transport: config.app.nodeEnv === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : config.axiom.token ? {
        target: '@axiomhq/pino',
        options: {
          dataset: config.axiom.dataset,
          token: config.axiom.token,
        },
      } : undefined,
});

const HEARTBEAT_EVERY_N_MESSAGES = 20;
// Background heartbeat cadence while inside an eachBatch callback. Must be
// well below sessionTimeout (30s) so a single slow handler can't get the
// consumer kicked from the group.
const HEARTBEAT_BACKGROUND_INTERVAL_MS = 5000;
// Backoff after a backpressure throw. KafkaJS won't refetch the failed
// batch any earlier than `retry.initialRetryTime`; this is just a hint to
// any custom retry policy and primarily serves to surface the wait.
const BACKPRESSURE_BACKOFF_MS = 1000;

/**
 * A "poison" error is a deterministic bug in handler code or message shape
 * (TypeError, ReferenceError, SyntaxError) that will throw identically on every
 * redelivery. Redelivering it just crash-loops the consumer and wedges the
 * whole group (one bad CollectionContributor delete took the watcher offline
 * 2026-06-17). We skip-and-advance past poison messages instead. Genuinely
 * transient failures (ClickHouse/Postgres/network) are NOT poison: they bubble
 * so the batch redelivers and ClickHouse dedup absorbs the re-inserts.
 *
 * Deliberately conservative. RangeError is excluded: it can come from a
 * *valid* but oversized payload or transient deep-async overflow, which we'd
 * rather redeliver than silently drop. The DB clients reject with plain
 * Error / library types on connectivity loss (not TypeError), so a DB outage
 * bubbles as transient — it does not match here.
 *
 * NOTE: every skip is a (small) silent data drop, so `mew_messages_poisoned_total`
 * must be alerted on — a sustained increment means a real handler bug, not a
 * one-off bad row, and should be paged, not absorbed.
 */
function isPoisonError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError
  );
}

async function startMetricEventWatcher() {
  validateConfig();

  const healthServer = startHealthServer();

  const eventProcessor = getEventProcessor();
  await eventProcessor.start();

  const debeziumManager = DebeziumManager.getInstance();
  await debeziumManager.ensureConnectorConfigured();

  const kafka = new Kafka({
    clientId: 'metric-event-watcher',
    brokers: config.kafka.brokers,
  });

  const consumer = kafka.consumer({
    groupId: config.kafka.consumerGroup,
    sessionTimeout: 30000,
    retry: {
      // Without this, a non-retriable crash (e.g. an unclassified handler
      // throw escaping eachBatch) stops the runner for good: the process
      // keeps serving health 200s with a DEAD consumer — a silent "deaf pod"
      // that consumes nothing. Returning true makes KafkaJS restart the
      // runner so the pod self-heals instead of going quietly offline.
      restartOnFailure: async (err) => {
        logger.error({ err }, 'Consumer runner failed; restarting runner');
        return true;
      },
    },
  });

  // Visibility: surface every consumer crash. Paired with restartOnFailure
  // above (which restarts the runner) and the poison-pill skip in eachBatch
  // (which prevents deterministic crash-loops in the first place).
  consumer.on(consumer.events.CRASH, (e) => {
    logger.error(
      { error: e.payload.error, restart: e.payload.restart, groupId: e.payload.groupId },
      'Kafka consumer CRASH event',
    );
  });

  const postgresTopics = DebeziumManager.getTopicsToConsume();
  const clickhouseTopics = config.kafka.clickhouseTopics;
  const allTopics = [...postgresTopics, ...clickhouseTopics];

  // Wire the batcher's onFlushed callback to commit Kafka offsets. Events
  // are durable in ClickHouse before this fires, so committing here is
  // safe: a crash before the next flush will redeliver from the last
  // committed offset, and ClickHouse dedups duplicates via the
  // entityMetricEvents_month ReplacingMergeTree key.
  const batcher = eventProcessor.getMetricBatcher();
  batcher.onFlushed(async (snapshot: OffsetSnapshot) => {
    if (snapshot.size === 0) return;

    const topicPartitions = Array.from(snapshot.entries()).map(([key, offset]) => {
      const sepIndex = key.lastIndexOf(':');
      const topic = key.slice(0, sepIndex);
      const partition = parseInt(key.slice(sepIndex + 1), 10);
      // Kafka commits the NEXT offset to read, i.e. last processed + 1.
      const nextOffset = (BigInt(offset) + 1n).toString();
      return { topic, partition, offset: nextOffset };
    });

    try {
      await consumer.commitOffsets(topicPartitions);
      logger.debug({ topicPartitions }, 'Committed offsets after flush');
    } catch (err) {
      // A commit failure is recoverable: Kafka redelivers the uncommitted
      // messages, ClickHouse dedup absorbs the re-inserts, and the cache apply
      // is skipped (see MetricEventBatcher.processBatch) so the redelivery
      // re-applies it exactly once after a commit finally lands. Re-throw so
      // the batcher knows the commit did not succeed and holds off the cache.
      metricBatcherMetrics.offsetCommitFailures.inc();
      logger.error({ err, topicPartitions }, 'Failed to commit offsets');
      throw err;
    }
  });

  let shuttingDown = false;

  try {
    logger.info('Connecting to Kafka...');
    await consumer.connect();

    logger.info(`Subscribing to ${allTopics.length} topics...`);
    await consumer.subscribe({
      topics: allTopics,
      fromBeginning: false,
    });

    logger.info('Starting consumer in eachBatch mode (autoCommit: false)...');
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, heartbeat, resolveOffset, isRunning, isStale }: EachBatchPayload) => {
        // Background heartbeat so a slow handler can't blow the session
        // timeout. KafkaJS dedupes back-to-back heartbeat calls so the
        // explicit ones below are still safe.
        const heartbeatTimer = setInterval(() => {
          heartbeat().catch((err) => {
            logger.warn({ err }, 'background heartbeat failed');
          });
        }, HEARTBEAT_BACKGROUND_INTERVAL_MS);

        let processedInBatch = 0;

        try {
          for (const message of batch.messages) {
            if (!isRunning() || isStale() || shuttingDown) break;

            const value = message.value?.toString() || 'null';

            let parsedValue: any;
            try {
              parsedValue = JSON.parse(value);
            } catch (err) {
              logger.error(
                { err, topic: batch.topic, partition: batch.partition, offset: message.offset, value },
                'Failed to parse message; advancing offset',
              );
              // Mark this offset as processed so a poison-pill message
              // doesn't permanently stall the consumer. Loss is acceptable
              // here: the message is malformed and can't be re-parsed on
              // retry.
              batcher.markOffset({
                topic: batch.topic,
                partition: batch.partition,
                offset: message.offset,
              });
              resolveOffset(message.offset);
              continue;
            }

            // Skip Debezium snapshot reads (CDC catch-up rows).
            if (parsedValue.op === 'r') {
              batcher.markOffset({
                topic: batch.topic,
                partition: batch.partition,
                offset: message.offset,
              });
              resolveOffset(message.offset);
              continue;
            }

            try {
              await eventProcessor.handleKafkaEvent(parsedValue, batch.topic, {
                topic: batch.topic,
                partition: batch.partition,
                offset: message.offset,
              });
            } catch (err) {
              if (err instanceof BatcherBackpressureError) {
                // Queue is full — ClickHouse is likely down. Don't resolve
                // this offset, sleep briefly, and re-throw so KafkaJS
                // refetches the batch from this offset after a backoff.
                logger.warn(
                  { err: err.message, topic: batch.topic, partition: batch.partition, offset: message.offset },
                  'Backpressure: batcher queue full; bailing out of batch',
                );
                await new Promise((r) => setTimeout(r, BACKPRESSURE_BACKOFF_MS));
                throw err;
              }

              if (isPoisonError(err)) {
                // Deterministic handler/data bug: redelivery would throw
                // identically and crash-loop the consumer, wedging the whole
                // group. Skip this one message (advance its offset) instead of
                // taking the pipeline down. The lost event is recomputed from
                // the source-of-truth backfill.
                eventProcessorMetrics.messagesPoisoned.inc({
                  topic: batch.topic,
                  reason: (err as Error)?.name ?? 'unknown',
                });
                logger.error(
                  { err, topic: batch.topic, partition: batch.partition, offset: message.offset },
                  'Poison message: deterministic handler error; advancing offset to avoid crash-wedging the consumer',
                );
                batcher.markOffset({
                  topic: batch.topic,
                  partition: batch.partition,
                  offset: message.offset,
                });
                resolveOffset(message.offset);
                continue;
              }

              // Treat as transient (ClickHouse/Postgres/network). Bail the
              // batch so it redelivers; ClickHouse dedup absorbs re-inserts.
              // restartOnFailure (consumer config) keeps the runner alive
              // instead of letting the crash leave a deaf pod.
              logger.error(
                { err, topic: batch.topic, partition: batch.partition, offset: message.offset },
                'Handler threw (transient); bailing out of batch for redelivery',
              );
              throw err;
            }

            // resolveOffset bounds the redelivery window: a later message
            // failing only rewinds the in-memory cursor to the next
            // unresolved offset, not the whole batch. The actual broker
            // commit still flows through batcher.onFlushed below.
            resolveOffset(message.offset);

            processedInBatch++;
            if (processedInBatch % HEARTBEAT_EVERY_N_MESSAGES === 0) {
              await heartbeat();
            }
          }

          await heartbeat();
        } finally {
          clearInterval(heartbeatTimer);
        }
      },
    });

    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        logger.info(`Received ${signal}, shutting down...`);

        // 1) Pause partitions so no new messages are fetched. Any in-flight
        //    eachBatch callback finishes its current batch — KafkaJS will
        //    not invoke eachBatch again for paused topics. We keep the
        //    consumer connection alive so commitOffsets still works.
        try {
          consumer.pause(allTopics.map((topic) => ({ topic })));
        } catch (err) {
          logger.warn({ err }, 'consumer.pause failed; continuing shutdown');
        }

        // 2) Drain handler work + final-flush downstream batchers. The
        //    final flush triggers onFlushed, which commits the final
        //    offset snapshot through the still-connected consumer. If the
        //    flush throws, offsets stay uncommitted and Kafka will
        //    redeliver after restart (ClickHouse dedup absorbs dupes).
        logger.info('Stopping event processor (drain + final flush + commit)...');
        await eventProcessor.stop();

        // 3) Disconnect after all commits are in. Safe to drop the
        //    consumer connection now.
        logger.info('Disconnecting Kafka consumer...');
        await consumer.disconnect();

        logger.info('Shutdown complete.');
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
      } finally {
        process.exit(0);
      }
    };

    ['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach((signal) => {
      process.once(signal, () => {
        void shutdown(signal);
      });
    });

    ['unhandledRejection', 'uncaughtException'].forEach((type) => {
      process.on(type, async (err) => {
        logger.error({ err }, `process.on ${type}`);
        await shutdown(type);
      });
    });

    logger.info('Metric Event Watcher is running. Press Ctrl+C to stop.');
  } catch (err) {
    logger.error({ err }, 'Error starting consumer');
    throw err;
  }
}

if (require.main === module) {
  startMetricEventWatcher().catch((err) => {
    logger.error({ err }, 'Failed to start metric event watcher');
    process.exit(1);
  });
}

export { startMetricEventWatcher };
