/**
 * Keeps the models collection in step with Postgres from CDC events, so a new or edited model is
 * searchable within minutes: `node dist/vector-sync/models/consumer.js`. Its own process and
 * consumer group; needs CDC_MODEL_ENABLED, which adds Model and ModelVersion to the connector.
 */
import http from 'http';
import { Kafka, type Consumer } from 'kafkajs';
import { assertVectorSyncConfig, config } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { Embedder, MixedStampError } from '../embedder';
import { ModelMismatchError, type VectorStore } from '../qdrant';
import { connectorBlock } from '../sync';
import { modelVectorStore } from './collection';
import type { ModelPayload } from './source';
import { syncModelIds, type ModelSyncDeps } from './sync';

export const MODEL_TOPICS = ['postgres.Model', 'postgres.ModelVersion', 'postgres.TagsOnModels'];
/** The tables whose changes decide a model's eligibility; embedding waits until both stream. */
export const MODEL_CDC_TABLES = ['public.Model', 'public.ModelVersion'];
const MAX_PENDING = 2_000;

/**
 * The model id a CDC message touches. A ModelVersion delete carries only the version's own id
 * (the table's replica identity is its key), so it yields null; the backfill sweep catches it.
 */
export function modelIdFromEvent(topic: string, value: unknown): number | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.Model' ? row.id : row.modelId;
  return typeof id === 'number' ? id : null;
}

type Offset = { topic: string; partition: number; offset: string };

export type ModelQueueDeps = Omit<ModelSyncDeps, 'store'> & {
  store: ModelSyncDeps['store'] & Pick<VectorStore<ModelPayload>, 'isStamped'>;
};

/**
 * Collects model ids and syncs them every `debounceMs`, committing offsets only once the Qdrant
 * writes for everything before them have succeeded; a crash redelivers, which the sync absorbs.
 * While embedding is off, paused or the collection unstamped, deletes and payload updates still
 * run, and models needing a vector are left for the backfill.
 */
export class ModelSyncQueue {
  private pending = new Set<number>();
  private offsets = new Map<string, Offset>();
  private flushing: Promise<void> | null = null;
  lastFlushOk = Date.now();
  consecutiveFailures = 0;
  embedStopped: string | null = null;
  gateBlocked: string | null = null;

  constructor(
    private readonly deps: ModelQueueDeps,
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
    const ids = [...this.pending];
    const offsets = [...this.offsets.values()];
    this.pending = new Set();
    this.offsets = new Map();
    try {
      // A new collection's model is recorded by the backfill canary first, so two writers
      // cannot stamp it differently.
      const embed =
        !!this.deps.embedder && !this.gateBlocked && (await this.deps.store.isStamped());
      if (ids.length) {
        const started = Date.now();
        const stats = await syncModelIds(ids, embed ? this.deps : { ...this.deps, embedder: null });
        logger.info({ ids: ids.length, ms: Date.now() - started, ...stats }, 'model-sync: flushed');
      }
    } catch (err) {
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
    if (offsets.length) {
      try {
        await this.commit(
          offsets.map((o) => ({ ...o, offset: (BigInt(o.offset) + 1n).toString() }))
        );
      } catch (err) {
        logger.warn({ err }, 'model-sync: offset commit failed');
      }
    }
    this.lastFlushOk = Date.now();
    this.consecutiveFailures = 0;
  }

  setGate(reason: string | null) {
    if (reason !== this.gateBlocked) {
      if (reason) logger.warn({ reason }, 'model-sync: embedding paused');
      else logger.info('model-sync: embedding resumed');
    }
    this.gateBlocked = reason;
  }

  stopEmbedding(reason: string) {
    if (!this.deps.embedder) return;
    logger.error({ reason }, 'model-sync: embedding stopped');
    this.deps.embedder = null;
    this.embedStopped = reason;
  }

  /**
   * Healthy within 10 minutes of a successful flush; past that, only while flushes are not
   * failing and one has succeeded within 45 minutes, which outlasts a batch's rate-limit backoff
   * plus the 30-minute workflow timeout.
   */
  isHealthy(now = Date.now()) {
    const since = now - this.lastFlushOk;
    return since < 10 * 60_000 || (this.consecutiveFailures < 3 && since < 45 * 60_000);
  }
}

async function main() {
  assertVectorSyncConfig();
  if (!MODEL_CDC_TABLES.every((t) => config.kafka.cdcOnlyTables.includes(t)))
    throw new Error('CDC_MODEL_ENABLED is off, so Model and ModelVersion events never arrive');
  const vs = config.vectorSync;
  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: vs.pgPoolMax },
    'model-sync',
    (message, err) => logger.error({ err }, message)
  );
  const store = modelVectorStore();
  await store.bootstrap({ alias: vs.modelAlias });
  const embedder = vs.embedEnabled ? Embedder.fromConfig('normal') : null;
  if (!embedder) logger.warn('model-sync: VECTOR_SYNC_EMBED_ENABLED is off; not embedding');

  const kafka = new Kafka({ clientId: 'model-vector-sync', brokers: config.kafka.brokers });
  const consumer: Consumer = kafka.consumer({
    groupId: vs.modelConsumerGroup,
    sessionTimeout: 30000,
    retry: { restartOnFailure: async () => true },
  });
  const queue = new ModelSyncQueue({ pg, store, embedder }, (offsets) =>
    consumer.commitOffsets(offsets)
  );
  // Without Model events an unpublish or ToS removal would not reach the index, so no new
  // vectors until the connector streams both tables; a Kafka Connect blip only pauses it.
  const checkGate = () =>
    connectorBlock(globalThis.fetch, MODEL_CDC_TABLES)
      .then((reason) => queue.setGate(reason))
      .catch((err) => queue.setGate(`gate check failed: ${(err as Error).message}`));
  if (embedder) await checkGate();
  const gate = setInterval(() => {
    if (embedder) void checkGate();
  }, 60_000);

  let stopping = false;
  const timer = setInterval(() => {
    queue.flush().catch((err) => logger.error({ err }, 'model-sync: flush failed; retrying'));
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
        })
      );
    })
    .listen(config.app.healthCheckPort);

  await consumer.connect();
  await consumer.subscribe({ topics: MODEL_TOPICS, fromBeginning: false });
  logger.info({ topics: MODEL_TOPICS, group: vs.modelConsumerGroup }, 'model-sync: consuming');
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      const beat = setInterval(() => heartbeat().catch(() => undefined), 5000);
      try {
        for (const message of batch.messages) {
          if (!isRunning() || isStale() || stopping) break;
          let id: number | null = null;
          try {
            id = modelIdFromEvent(batch.topic, JSON.parse(message.value?.toString() ?? 'null'));
          } catch (err) {
            logger.error(
              { err, topic: batch.topic, offset: message.offset },
              'model-sync: unparseable message; skipping'
            );
          }
          queue.add(id, { topic: batch.topic, partition: batch.partition, offset: message.offset });
          resolveOffset(message.offset);
          while (queue.isFull) {
            await queue.flush().catch(async (err) => {
              logger.error({ err }, 'model-sync: flush failed under backpressure');
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
    logger.info({ signal }, 'model-sync: shutting down');
    clearInterval(timer);
    clearInterval(gate);
    try {
      consumer.pause(MODEL_TOPICS.map((topic) => ({ topic })));
      await queue.flush();
    } catch (err) {
      logger.error({ err }, 'model-sync: final flush failed; uncommitted events will redeliver');
    }
    await consumer.disconnect().catch(() => undefined);
    await pg.end().catch(() => undefined);
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'model-sync: failed to start');
    process.exit(1);
  });
}
