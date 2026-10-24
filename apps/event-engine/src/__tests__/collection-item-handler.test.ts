import { afterEach, describe, expect, test } from 'vitest';
import { collectionItemHandler } from '@/handlers/collection-items';
import { EventProcessor } from '@/services/event-processor';
import { metricSignals } from '@/services/metric-signals';
import type { MetricEvent } from '@/types/events';

// A CollectionItem counts only through its addedById: the handler attributes every event to it and
// the processor drops events with no user. A writer that leaves addedById null (bookmarks did, until
// the app started setting it) produces rows that never count, in either direction.

let restoreSignals: (() => void) | null = null;
afterEach(() => {
  restoreSignals?.();
  restoreSignals = null;
});

async function run(payloads: object[]) {
  const original = metricSignals.sendDelta;
  metricSignals.sendDelta = (async () => undefined) as typeof metricSignals.sendDelta;
  restoreSignals = () => {
    metricSignals.sendDelta = original;
  };

  const batched: MetricEvent[] = [];
  const proc = Object.create(EventProcessor.prototype) as EventProcessor;
  Object.assign(proc, {
    excludedUsers: { has: () => false },
    redisCache: { incrementOnce: async () => undefined },
    metricBatcher: { add: (ev: MetricEvent) => batched.push(ev) },
  });
  const build = (
    proc as unknown as { createHandlerContext(p: object, meta: object): never }
  ).createHandlerContext.bind(proc);

  for (const p of payloads)
    await collectionItemHandler.process(build(p, { topic: 't', partition: 0, offset: '0' }));
  return batched;
}

const item = (addedById: number | null) => ({
  id: 1,
  collectionId: 10,
  articleId: 20,
  addedById,
  status: 'ACCEPTED',
});
const created = (row: object) => ({ op: 'c', before: null, after: row, source: { ts_ms: 1 } });
const deleted = (row: object) => ({ op: 'd', before: row, after: null, source: { ts_ms: 2 } });

const articleCollected = (events: MetricEvent[]) =>
  events
    .filter((e) => e.entityType === 'Article' && e.metricType === 'collectedCount')
    .map((e) => [e.userId, e.metricValue]);

describe('collectionItemHandler', () => {
  test('a row with an adder counts on create and uncounts on delete, as that user', async () => {
    const events = await run([created(item(42)), deleted(item(42))]);
    expect(articleCollected(events)).toEqual([
      [42, 1],
      [42, -1],
    ]);
  });

  test('a row with no adder emits nothing', async () => {
    const events = await run([created(item(null)), deleted(item(null))]);
    expect(events).toEqual([]);
  });
});
