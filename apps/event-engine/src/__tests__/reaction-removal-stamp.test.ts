import { afterEach, describe, expect, test } from 'vitest';
import { imageReactionHandler } from '@/handlers/image-reactions';
import { EventProcessor } from '@/services/event-processor';
import { eventProcessorMetrics } from '@/metrics';
import { metricSignals } from '@/services/metric-signals';
import type { MetricEvent } from '@/types/events';

// `entityMetricEvents_month.createdAt` is DateTime (whole seconds) and part of its
// ReplacingMergeTree key, and per-user reaction state is argMax over (createdAt, version). A like
// and an un-like in the same second therefore tie: the state keeps the +1 and the served count
// never comes down. Reaction removals are stamped one second later so they sort after. Delete
// this file with that stamp once the column is DateTime64.

const row = { id: 1, imageId: 1001, userId: 2002, reaction: 'Like' };
const POST_ID = 3003;
const OWNER_ID = 4004;

// Debezium envelopes as they arrive: the commit time is source.ts_ms.
const created = (tsMs: number) => ({ op: 'c', before: null, after: row, source: { ts_ms: tsMs } });
const deleted = (tsMs: number) => ({ op: 'd', before: row, after: null, source: { ts_ms: tsMs } });

const second = (e: MetricEvent) => Math.floor(+(e.timestamp ?? 0) / 1000);
const BASE = Date.UTC(2026, 9, 23, 0, 54, 10);

let restoreSignals: (() => void) | null = null;
afterEach(() => {
  restoreSignals?.();
  restoreSignals = null;
});

// The real context builder and actions, so the stamp is asserted where it reaches the batcher
// (what becomes `createdAt`), not on whatever the handler hands its helpers.
async function run(payloads: object[], image: object = { postId: POST_ID, userId: OWNER_ID }) {
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
    pgQueryOneMemoized: async () => image,
  });
  const build = (
    proc as unknown as { createHandlerContext(p: object, meta: object): never }
  ).createHandlerContext.bind(proc);

  for (const p of payloads)
    await imageReactionHandler.process(build(p, { topic: 't', partition: 0, offset: '0' }));
  return batched;
}

const imageLike = (events: MetricEvent[]) =>
  events.filter((e) => e.entityType === 'Image' && e.metricType === 'Like');

describe('reaction removal stamp', () => {
  test('a same-second un-like lands in a later second than its like', async () => {
    const [add, remove] = imageLike(await run([created(BASE + 382), deleted(BASE + 716)]));

    expect(add.metricValue).toBe(1);
    expect(remove.metricValue).toBe(-1);
    expect(second(add)).toBe(BASE / 1000);
    expect(second(remove)).toBe(BASE / 1000 + 1);
  });

  // The post's and the owner's counters come from the same row and tie the same way.
  test('the post and owner metrics of a removal carry the same stamp', async () => {
    const events = await run([deleted(BASE + 716)]);
    const stamps = events.map((e) => `${e.entityType}.${e.metricType}=${+(e.timestamp ?? 0)}`);

    expect(stamps.sort()).toEqual(
      [
        `Image.Like=${BASE + 1716}`,
        `Post.Like=${BASE + 1716}`,
        `Post.reactionCount=${BASE + 1716}`,
        `User.reactionCount=${BASE + 1716}`,
      ].sort()
    );
  });

  // The stamped builder must keep forMetric's guard: an image with no post or owner emits nothing
  // for them, rather than reaching addMetricEvent and counting as a dropped event.
  test('a removal on an image with no post or owner emits only the image metric', async () => {
    const dropped = async () =>
      ((await eventProcessorMetrics.eventsDropped.get()).values ?? []).reduce(
        (n, v) => n + v.value,
        0
      );
    const before = await dropped();
    const events = await run([deleted(BASE + 716)], { postId: null, userId: null });

    expect(events.map((e) => `${e.entityType}.${e.metricType}`)).toEqual(['Image.Like']);
    expect(await dropped()).toBe(before);
  });

  // The Redis dedupe marker keys on the millisecond stamp and not the value, so two removals in
  // one second must keep distinct milliseconds or the second -1 is dropped as a replay.
  test('two removals in one second keep distinct stamps', async () => {
    const [first, again] = imageLike(await run([deleted(BASE + 200), deleted(BASE + 800)]));
    expect(+(first.timestamp ?? 0)).not.toBe(+(again.timestamp ?? 0));
  });

  // A model of the ClickHouse objects, transcribed from their DDL (2026-10-23), not ClickHouse
  // itself: per-user state is argMaxState(metricValue, (createdAt, version)) with createdAt in
  // seconds and version defaulting to 3 (the batcher never sets it); the today MV sums the
  // per-(user, createdAt) values over the day. On a tie argMax keeps the value it saw first.
  test('the per-user state reads un-liked and the day nets to zero', async () => {
    const events = imageLike(await run([created(BASE + 215), deleted(BASE + 463)]));
    const rows = events.map((e) => ({ key: [second(e), 3], value: e.metricValue }));

    const later = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    const latest = rows.reduce((best, r) => (later(r.key, best.key) ? r : best));
    expect(latest.value).toBe(-1);

    const perSecond = new Map(rows.map((r) => [r.key[0], r.value]));
    expect(perSecond.size).toBe(2);
    expect([...perSecond.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  test('an addition keeps its commit time', async () => {
    const events = await run([created(BASE + 829)]);
    expect(events.map((e) => +(e.timestamp ?? 0))).toEqual(events.map(() => BASE + 829));
  });

  // Kafka redelivers; the event table and the Redis dedupe marker both key on this stamp, so a
  // replay has to reproduce it exactly or it is counted twice.
  test('a redelivered removal gets the identical stamp', async () => {
    const [first] = imageLike(await run([deleted(BASE + 463)]));
    await new Promise((r) => setTimeout(r, 1100));
    const [replay] = imageLike(await run([deleted(BASE + 463)]));
    expect(+(replay.timestamp ?? 0)).toBe(+(first.timestamp ?? 0));
  });
});
