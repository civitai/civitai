/**
 * Vector-sync: keeps the semantic image collection in step with Postgres from CDC events.
 * Runs as its own process and consumer group (`node dist/vector-sync/consumer.js`), from the
 * same image as the metrics watcher, and never configures the Debezium connector.
 */
import http from 'http';
import { Kafka, type Consumer } from 'kafkajs';
import { config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { MixedStampError, Embedder } from './embedder';
import { ModelMismatchError, VectorStore } from './qdrant';
import { embedBlockedReason, syncImageIds, type SyncDeps } from './sync';

/** Image ids a CDC message touches. Deletes carry the key columns in `before`. */
export function imageIdFromEvent(topic: string, value: unknown): number | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.Image' ? row.id : row.imageId;
  return typeof id === 'number' ? id : null;
}

export const VECTOR_SYNC_TOPICS = ['postgres.TagsOnImageNew', 'postgres.ImageResourceNew'];
const IMAGE_TOPIC = 'postgres.Image';
/** Above this many pending ids, consumption waits for a flush. */
const MAX_PENDING = 5_000;

type Offset = { topic: string; partition: number; offset: string };

/**
 * Collects image ids from messages and syncs them every `debounceMs`, committing offsets only
 * once the Qdrant writes for everything before them have succeeded. A crash redelivers from the
 * last commit, which the idempotent sync absorbs.
 */
export class VectorSyncQueue {
  private pending = new Set<number>();
  private offsets = new Map<string, Offset>();
  private flushing: Promise<void> | null = null;
  lastFlushOk = Date.now();
  /** A flush starting or an embed workflow finishing. */
  lastProgress = Date.now();
  consecutiveFailures = 0;
  /** Why embedding stopped at runtime, if it did. */
  embedStopped: string | null = null;

  constructor(
    private readonly deps: SyncDeps,
    private readonly commit: (offsets: Offset[]) => Promise<void>
  ) {}

  add(id: number | null, offset: Offset) {
    if (id !== null) this.pending.add(id);
    this.offsets.set(`${offset.topic}:${offset.partition}`, offset);
  }

  get size() {
    return this.pending.size;
  }

  get isFull() {
    return this.pending.size >= MAX_PENDING;
  }

  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush() {
    if (!this.pending.size && !this.offsets.size) {
      this.lastFlushOk = Date.now();
      return;
    }
    this.noteProgress();
    const ids = [...this.pending];
    const offsets = [...this.offsets.values()];
    this.pending = new Set();
    this.offsets = new Map();
    try {
      const started = Date.now();
      // A new collection's model is recorded by one process first (the backfill canary); until
      // then this consumer does not embed into it, so two writers cannot stamp it differently.
      const stamped = !!this.deps.embedder && (await this.deps.store.isStamped());
      if (this.deps.embedder && !stamped) {
        logger.warn('vector-sync: collection has no recorded model yet; not embedding this flush');
      }
      const stats = await syncImageIds(ids, stamped ? this.deps : { ...this.deps, embedder: null });
      logger.info({ ids: ids.length, ms: Date.now() - started, ...stats }, 'vector-sync: flushed');
    } catch (err) {
      // Put the work back; newer offsets taken meanwhile stay, older ones are re-covered by them.
      for (const id of ids) this.pending.add(id);
      for (const o of offsets) {
        const key = `${o.topic}:${o.partition}`;
        if (!this.offsets.has(key)) this.offsets.set(key, o);
      }
      this.consecutiveFailures++;
      if (err instanceof ModelMismatchError || err instanceof MixedStampError) {
        // Retrying would pay for the same rejected vectors every tick.
        this.stopEmbedding((err as Error).message);
      }
      throw err;
    }
    try {
      await this.commit(offsets.map((o) => ({ ...o, offset: (BigInt(o.offset) + 1n).toString() })));
    } catch (err) {
      // The writes landed; an uncommitted offset only means a redelivery, which is idempotent.
      logger.warn({ err }, 'vector-sync: offset commit failed');
    }
    this.lastFlushOk = Date.now();
    this.consecutiveFailures = 0;
  }

  noteProgress() {
    this.lastProgress = Date.now();
  }

  /** Embedding stays off until the process restarts; deletes and payload updates carry on. */
  stopEmbedding(reason: string) {
    if (!this.deps.embedder) return;
    logger.error({ reason }, 'vector-sync: embedding stopped');
    this.deps.embedder = null;
    this.embedStopped = reason;
  }

  /**
   * Healthy within 10 minutes of a successful flush. Past that, a slow flush that is still
   * finishing workflows stays healthy (killing it would lose paid work), but not one whose
   * flushes keep failing: retries restart the flush every tick, so they look like progress.
   * 35 minutes outlasts the 30-minute workflow timeout.
   */
  isHealthy(now = Date.now()) {
    if (now - this.lastFlushOk < 10 * 60_000) return true;
    return this.consecutiveFailures < 3 && now - this.lastProgress < 35 * 60_000;
  }
}

/** The live-sync embedder, or null when embedding may not run (see embedBlockedReason). */
export async function consumerEmbedder(): Promise<Embedder | null> {
  const blocked = await embedBlockedReason();
  if (blocked) {
    logger.warn(
      { reason: blocked },
      'vector-sync: not embedding; only deletes and payload updates run'
    );
    return null;
  }
  return Embedder.fromConfig('normal');
}

async function main() {
  const vs = config.vectorSync;
  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: config.vectorSync.pgPoolMax },
    'vector-sync',
    (message, err) => logger.error({ err }, message)
  );
  const store = VectorStore.fromConfig();
  await store.bootstrap();
  const embedder = await consumerEmbedder();

  const topics = [
    ...VECTOR_SYNC_TOPICS,
    ...(config.kafka.cdcOnlyTables.includes('public.Image') ? [IMAGE_TOPIC] : []),
  ];
  const kafka = new Kafka({ clientId: 'image-vector-sync', brokers: config.kafka.brokers });
  const consumer: Consumer = kafka.consumer({
    groupId: vs.consumerGroup,
    sessionTimeout: 30000,
    retry: { restartOnFailure: async () => true },
  });
  const queue = new VectorSyncQueue({ pg, store, embedder }, (offsets) =>
    consumer.commitOffsets(offsets)
  );
  if (embedder) embedder.onProgress = () => queue.noteProgress();
  // The connector can lose Image after startup (the watcher recreates it from its own env), and
  // then blocks stop arriving.
  const gate = setInterval(() => {
    if (!embedder || queue.embedStopped) return;
    embedBlockedReason()
      .then((reason) => reason && queue.stopEmbedding(reason))
      .catch((err) => logger.error({ err }, 'vector-sync: gate re-check failed'));
  }, 10 * 60_000);

  let stopping = false;
  const timer = setInterval(() => {
    queue
      .flush()
      .catch((err) => logger.error({ err }, 'vector-sync: flush failed; retrying next tick'));
  }, vs.debounceMs);

  http
    .createServer((_req, res) => {
      const healthy = queue.isHealthy();
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          healthy,
          pending: queue.size,
          embedding: !!embedder && !queue.embedStopped,
          embedStopped: queue.embedStopped,
        })
      );
    })
    .listen(config.app.healthCheckPort);

  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });
  logger.info({ topics, group: vs.consumerGroup }, 'vector-sync: consuming');
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      // A flush under backpressure can outlast the session timeout.
      const beat = setInterval(() => heartbeat().catch(() => undefined), 5000);
      try {
        for (const message of batch.messages) {
          if (!isRunning() || isStale() || stopping) break;
          let id: number | null = null;
          try {
            id = imageIdFromEvent(batch.topic, JSON.parse(message.value?.toString() ?? 'null'));
          } catch (err) {
            logger.error(
              { err, topic: batch.topic, offset: message.offset },
              'vector-sync: unparseable message; skipping'
            );
          }
          queue.add(id, { topic: batch.topic, partition: batch.partition, offset: message.offset });
          resolveOffset(message.offset);
          while (queue.isFull) {
            await queue.flush().catch(async (err) => {
              logger.error({ err }, 'vector-sync: flush failed under backpressure');
              await new Promise((r) => setTimeout(r, 5000));
            });
            await heartbeat();
          }
        }
        await heartbeat();
      } finally {
        clearInterval(beat);
      }
    },
  });

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'vector-sync: shutting down');
    clearInterval(timer);
    clearInterval(gate);
    try {
      consumer.pause(topics.map((topic) => ({ topic })));
      await queue.flush();
    } catch (err) {
      logger.error({ err }, 'vector-sync: final flush failed; uncommitted events will redeliver');
    }
    await consumer.disconnect().catch(() => undefined);
    await pg.end().catch(() => undefined);
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'vector-sync: failed to start');
    process.exit(1);
  });
}
