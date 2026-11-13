/**
 * Keeps the models collection in step with Postgres from CDC events, so a new or edited model is
 * searchable within minutes: `node dist/vector-sync/models/consumer.js`. Its own process and
 * consumer group; needs CDC_MODEL_ENABLED, which adds Model and ModelVersion to the connector.
 */
import { config } from '@/config';
import { logger } from '@/utils/logger';
import { runSyncConsumer, routeByTopic } from '../domain/consumer';
import { DomainSyncQueue, type LaneDeps, type Offset, type SyncLane } from '../domain/queue';
import { connectorBlock } from '../sync';
import { MODEL_CDC_TABLES, MODEL_TOPICS, modelDomain, toDomainRef, type ModelRef } from './domain';
import type { ModelPayload } from './source';

export { MODEL_CDC_TABLES, MODEL_TOPICS, modelRefFromEvent, type ModelRef } from './domain';

/** Refuses to start without the flag: the topics it needs would never carry events. */
export function assertModelCdc() {
  if (!MODEL_CDC_TABLES.every((t) => config.kafka.cdcOnlyTables.includes(t)))
    throw new Error('CDC_MODEL_ENABLED is off, so Model and ModelVersion events never arrive');
}

/**
 * Why embedding must wait, or null. Without Model events an unpublish or ToS removal would not
 * reach the index, so no new vectors until the connector streams both tables.
 */
export const modelEmbedBlock = (fetchImpl: typeof fetch = globalThis.fetch) =>
  connectorBlock(fetchImpl, MODEL_CDC_TABLES);

export type ModelQueueDeps = LaneDeps<ModelPayload>;

/** The models-only queue: one lane, addressed by model or deleted version. */
export class ModelSyncQueue extends DomainSyncQueue {
  private readonly lane: SyncLane<ModelPayload>;

  constructor(deps: ModelQueueDeps, commit: (offsets: Offset[]) => Promise<void>) {
    super([{ domain: modelDomain, deps }], commit, 'model-sync');
    this.lane = this.lanes.get(modelDomain.name)!;
  }

  add(ref: ModelRef | null, offset: Offset): void;
  add(domain: string | null, ref: unknown, offset: Offset): void;
  add(...args: unknown[]) {
    if (args.length === 3) return super.add(...(args as Parameters<DomainSyncQueue['add']>));
    const [ref, offset] = args as [ModelRef | null, Offset];
    super.add(modelDomain.name, toDomainRef(ref), offset);
  }

  get embedStopped() {
    return this.lane.embedStopped;
  }
  get gateBlocked() {
    return this.lane.gateBlocked;
  }
  get unstamped() {
    return this.lane.unstamped;
  }
  refreshStamp() {
    return this.lane.refreshStamp();
  }
  setGate(reason: string | null) {
    this.lane.setGate(reason);
  }
  stopEmbedding(reason: string) {
    this.lane.stopEmbedding(reason);
  }
}

if (require.main === module) {
  try {
    assertModelCdc();
  } catch (err) {
    logger.error({ err }, 'model-sync: failed to start');
    process.exit(1);
  }
  runSyncConsumer({
    log: 'model-sync',
    clientId: 'model-vector-sync',
    groupId: config.vectorSync.modelConsumerGroup,
    domains: [modelDomain],
    topics: MODEL_TOPICS,
    route: routeByTopic([modelDomain]),
  }).catch((err) => {
    logger.error({ err }, 'model-sync: failed to start');
    process.exit(1);
  });
}
