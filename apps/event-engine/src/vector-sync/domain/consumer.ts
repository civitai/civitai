import http from 'http';
import { Kafka, type Consumer } from 'kafkajs';
import { assertVectorSyncConfig, config, domainEmbedEnabled } from '@/config';
import { createGuardedPgPool } from '@/utils/pg-pool-guard';
import { logger } from '@/utils/logger';
import { Embedder } from '../embedder';
import { serveMetrics } from '../metrics';
import { connectorBlock } from '../sync';
import { DomainSyncQueue } from './queue';
import type { Domain, DomainRef } from './sync';

/** The domain rows one message touches. */
export type Route = (topic: string, value: unknown) => Array<[domain: string, ref: DomainRef]>;

/** Routes each topic to the domains that list it. */
export const routeByTopic =
  (domains: Domain<any>[]): Route =>
  (topic, value) =>
    domains.flatMap((d) => {
      if (!d.topics.includes(topic)) return [];
      const ref = d.refFromEvent(topic, value);
      return ref ? [[d.name, ref] as [string, DomainRef]] : [];
    });

/**
 * Runs one consumer process over `domains`: a queue with a lane each, an embed gate per lane,
 * a health endpoint and a graceful shutdown. `log` prefixes the process's own lines.
 */
export async function runSyncConsumer(opts: {
  log: string;
  clientId: string;
  groupId: string;
  domains: Domain<any>[];
  topics: string[];
  route: Route;
}) {
  assertVectorSyncConfig();
  const { log, domains, topics } = opts;
  const vs = config.vectorSync;
  const pg = createGuardedPgPool(
    { connectionString: config.postgres.connectionString, max: vs.pgPoolMax },
    log,
    (message, err) => logger.error({ err }, message)
  );
  const lanes = [];
  for (const domain of domains) {
    const store = domain.store();
    await store.bootstrap({ alias: domain.alias() });
    const enabled = domainEmbedEnabled(domain.name, domain.embedByDefault);
    if (!enabled)
      logger.warn(`${domain.name}-sync: embedding is off (VECTOR_SYNC_EMBED_ENABLED or its own)`);
    lanes.push({
      domain,
      deps: { pg, store, embedder: enabled ? Embedder.fromConfig('normal') : null },
    });
  }

  const kafka = new Kafka({ clientId: opts.clientId, brokers: config.kafka.brokers });
  const consumer: Consumer = kafka.consumer({
    groupId: opts.groupId,
    sessionTimeout: 30000,
    retry: { restartOnFailure: async () => true },
  });
  const queue = new DomainSyncQueue(lanes, (offsets) => consumer.commitOffsets(offsets), log);
  // Fixed at start: a lane whose embedding stops keeps reporting its gate.
  const gated = [...queue.lanes.values()].filter((lane) => lane.deps.embedder);
  // A Kafka Connect blip only pauses embedding.
  const checkGates = () =>
    Promise.all(
      gated.map((lane) =>
        Promise.all([
          connectorBlock(globalThis.fetch, lane.domain.cdcTables),
          lane.refreshStamp().catch(() => undefined),
        ])
          .then(([reason]) => lane.setGate(reason))
          .catch((err) => lane.setGate(`gate check failed: ${(err as Error).message}`))
      )
    );
  await checkGates();
  const gate = setInterval(() => void checkGates(), 60_000);

  let stopping = false;
  const timer = setInterval(() => {
    queue.flush().catch((err) => logger.error({ err }, `${log}: flush failed; retrying`));
  }, vs.debounceMs);

  http
    .createServer(async (req, res) => {
      if (req.url === '/metrics') return serveMetrics(res);
      const healthy = queue.isHealthy();
      const byDomain = Object.fromEntries(
        [...queue.lanes].map(([name, lane]) => [
          name,
          {
            pending: lane.size,
            embedding: lane.embedding,
            embedStopped: lane.embedStopped,
            embedPaused: lane.gateBlocked,
          },
        ])
      );
      const [only] = Object.values(byDomain);
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      // One domain: the flat shape the model consumer has always reported.
      res.end(
        JSON.stringify(
          domains.length === 1
            ? { healthy, ...only }
            : { healthy, pending: queue.size, domains: byDomain }
        )
      );
    })
    .listen(config.app.healthCheckPort);

  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });
  logger.info({ topics, group: opts.groupId }, `${log}: consuming`);
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      const beat = setInterval(() => heartbeat().catch(() => undefined), 5000);
      try {
        for (const message of batch.messages) {
          if (!isRunning() || isStale() || stopping) break;
          const offset = { topic: batch.topic, partition: batch.partition, offset: message.offset };
          let refs: ReturnType<Route> = [];
          try {
            refs = opts.route(batch.topic, JSON.parse(message.value?.toString() ?? 'null'));
          } catch (err) {
            logger.error(
              { err, topic: batch.topic, offset: message.offset },
              `${log}: unparseable message; skipping`
            );
          }
          queue.add(null, null, offset);
          for (const [domain, ref] of refs) queue.add(domain, ref, offset);
          resolveOffset(message.offset);
          while (queue.isFull) {
            await queue.flush().catch(async (err) => {
              logger.error({ err }, `${log}: flush failed under backpressure`);
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
    logger.info({ signal }, `${log}: shutting down`);
    clearInterval(timer);
    clearInterval(gate);
    try {
      consumer.pause(topics.map((topic) => ({ topic })));
      await queue.flush();
    } catch (err) {
      logger.error({ err }, `${log}: final flush failed; uncommitted events will redeliver`);
    }
    await consumer.disconnect().catch(() => undefined);
    await pg.end().catch(() => undefined);
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
}
