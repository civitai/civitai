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
const updated = (before: object, after: object) => ({
  op: 'u',
  before,
  after,
  source: { ts_ms: 3 },
});

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

  // Only ACCEPTED rows count and the metric jobs count from Postgres, so a status change must mark
  // the article and the collection for a recount, without moving either sum.
  test('a status change marks the entity and the collection with a 0, as they were and are', async () => {
    const events = await run([
      updated(item(42), { ...item(42), collectionId: 11, status: 'REJECTED' }),
    ]);
    expect(events.map((e) => [e.entityType, e.entityId, e.metricType, e.metricValue])).toEqual([
      ['Collection', 10, 'itemCount', 0],
      ['Article', 20, 'collectedCount', 0],
      ['Collection', 11, 'itemCount', 0],
      ['Article', 20, 'collectedCount', 0],
    ]);
  });

  test('is routed updates at all', () => {
    // The processor looks handlers up by `<table>:<operation>` and drops anything unregistered,
    // which the direct calls above bypass.
    expect(collectionItemHandler.topics).toContain('CollectionItem:update');
  });

  test('an update that leaves the status alone emits nothing', async () => {
    const events = await run([updated(item(42), { ...item(42), note: 'x' })]);
    expect(events).toEqual([]);
  });

  // The Postgres-counted metrics need the mark to recount a row with no adder (the processor drops
  // events with no user); Image's 'Collection' is still a sum, and keeps not counting such rows.
  test('a row with no adder still marks the Postgres-counted metrics, as user -1', async () => {
    const events = await run([created(item(null)), deleted(item(null))]);
    expect(events.map((e) => [e.entityType, e.metricType, e.userId, e.metricValue])).toEqual([
      ['Collection', 'itemCount', -1, 1],
      ['Article', 'collectedCount', -1, 1],
      ['Collection', 'itemCount', -1, -1],
      ['Article', 'collectedCount', -1, -1],
    ]);
  });

  test('an image row with no adder adds nothing to the Image sum', async () => {
    const image = { id: 2, collectionId: 10, imageId: 70, addedById: null, status: 'ACCEPTED' };
    const events = await run([created(image)]);
    expect(events.filter((e) => e.entityType === 'Image')).toEqual([]);
  });
});
