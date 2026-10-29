/**
 * Vector-sync: keeps the semantic image collection in step with Postgres from CDC events.
 * Runs as its own process and consumer group (`node dist/vector-sync/consumer.js`), from the
 * same image as the metrics watcher, and never configures the Debezium connector.
 */
import http from 'http';
import { Kafka, type Consumer } from 'kafkajs';
import { assertVectorSyncConfig, config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { MixedStampError, Embedder } from './embedder';
import { ModelMismatchError, VectorStore } from './qdrant';
import { connectorBlock, staticEmbedBlock, syncImageIds, type SyncDeps } from './sync';

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
/** Deferred ids beyond this are dropped (logged); the reconciler finds them. */
const MAX_DEFERRED = 100_000;
/**
 * Deferred ids taken into one flush. Flushes are serial, so one huge catch-up flush would hold
 * back every block's delete behind it, and a pause would not take effect until it ended.
 */
const DEFERRED_PER_FLUSH = 512;

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
  /** An embed workflow returning vectors, or a flush succeeding. */
  lastProgress = Date.now();
  /** Failed flushes in a row that made no progress. */
  consecutiveFailures = 0;
  private progressCount = 0;
  /** Why embedding stopped for good (until restart), if it did. */
  embedStopped: string | null = null;
  /** Why embedding is paused right now, if it is; cleared when the check passes again. */
  gateBlocked: string | null = null;
  /** Images that needed embedding while it was paused, retried once it resumes. In memory only. */
  readonly deferred = new Set<number>();

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
    const progressAtStart = this.progressCount;
    const ids = [...this.pending];
    const pendingCount = ids.length;
    const offsets = [...this.offsets.values()];
    this.pending = new Set();
    this.offsets = new Map();
    try {
      const started = Date.now();
      // A new collection's model is recorded by one process first (the backfill canary); until
      // then this consumer does not embed into it, so two writers cannot stamp it differently.
      const stamped =
        !!this.deps.embedder && !this.gateBlocked && (await this.deps.store.isStamped());
      if (this.deps.embedder && !this.gateBlocked && !stamped) {
        logger.warn('vector-sync: collection has no recorded model yet; deferring embeds');
      }
      if (stamped) {
        for (const id of this.deferred) {
          if (ids.length >= pendingCount + DEFERRED_PER_FLUSH) break;
          ids.push(id);
          this.deferred.delete(id);
        }
      }
      const stats = await syncImageIds(ids, stamped ? this.deps : { ...this.deps, embedder: null });
      const { deferredIds = [], ...counts } = stats;
      // Paused, not stopped: keep them for when it resumes. Stopped for good, they wait for a
      // reconcile like everything else that is missing.
      if (this.deps.embedder) this.defer(deferredIds);
      logger.info(
        { ids: ids.length, ms: Date.now() - started, deferred: this.deferred.size, ...counts },
        'vector-sync: flushed'
      );
    } catch (err) {
      // Put the work back; newer offsets taken meanwhile stay, older ones are re-covered by them.
      for (const id of ids) this.pending.add(id);
      for (const o of offsets) {
        const key = `${o.topic}:${o.partition}`;
        if (!this.offsets.has(key)) this.offsets.set(key, o);
      }
      // A flush that stored some vectors before one batch failed is slow, not stuck.
      if (this.progressCount === progressAtStart) this.consecutiveFailures++;
      else this.consecutiveFailures = 0;
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
    this.lastProgress = this.lastFlushOk;
    this.consecutiveFailures = 0;
  }

  private defer(ids: number[]) {
    for (const [i, id] of ids.entries()) {
      if (this.deferred.size >= MAX_DEFERRED) {
        logger.warn(
          { dropped: ids.length - i },
          'vector-sync: deferred set full; reconcile will find the rest'
        );
        return;
      }
      this.deferred.add(id);
    }
  }

  /** Pauses embedding while `reason` is set, resumes when it is cleared. */
  setGate(reason: string | null) {
    if (reason !== this.gateBlocked) {
      if (reason) logger.warn({ reason }, 'vector-sync: embedding paused');
      else logger.info('vector-sync: embedding resumed');
    }
    this.gateBlocked = reason;
  }

  noteProgress() {
    this.progressCount++;
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
   * Healthy within 10 minutes of a successful flush. Past that, a flush still finishing
   * workflows stays healthy (killing it would lose paid work), but not one whose flushes keep
   * failing without progress. 45 minutes outlasts a batch's rate-limit backoff plus the
   * 30-minute workflow timeout.
   */
  isHealthy(now = Date.now()) {
    if (now - this.lastFlushOk < 10 * 60_000) return true;
    return this.consecutiveFailures < 3 && now - this.lastProgress < 45 * 60_000;
  }
}

/**
 * The live-sync embedder, or null when this process's config rules embedding out. Whether the
 * connector streams Image is checked by the queue's gate instead, which can pause and resume.
 */
export function consumerEmbedder(): Embedder | null {
  const blocked = staticEmbedBlock();
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
  assertVectorSyncConfig();
  const vs = config.vectorSync;
  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: config.vectorSync.pgPoolMax },
    'vector-sync',
    (message, err) => logger.error({ err }, message)
  );
  const store = VectorStore.fromConfig();
  await store.bootstrap();
  const embedder = consumerEmbedder();
  const sink = embedder?.sink;
  const sinkLog = sink
    ? setInterval(() => logger.info({ sink: sink.stats() }, 'vector-sync: sink'), 60_000)
    : undefined;

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
  // Embedding is paused while the connector does not stream Image (blocks would not arrive),
  // and resumes when it does again; a Kafka Connect blip only pauses it.
  const checkGate = () =>
    connectorBlock()
      .then((reason) => queue.setGate(reason))
      .catch((err) => queue.setGate(`gate check failed: ${(err as Error).message}`));
  if (embedder) await checkGate();
  const gate = setInterval(() => {
    if (embedder) void checkGate();
  }, 60_000);

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
          embedding: !!embedder && !queue.embedStopped && !queue.gateBlocked,
          embedStopped: queue.embedStopped,
          embedPaused: queue.gateBlocked,
          deferred: queue.deferred.size,
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
    clearInterval(sinkLog);
    try {
      consumer.pause(topics.map((topic) => ({ topic })));
      await queue.flush();
    } catch (err) {
      logger.error({ err }, 'vector-sync: final flush failed; uncommitted events will redeliver');
    }
    await consumer.disconnect().catch(() => undefined);
    if (sink) {
      await sink.close();
      logger.info({ sink: sink.stats() }, 'vector-sync: sink closed');
    }
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
