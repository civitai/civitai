import client from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real read is a lazy import of the replica pool; a scrape with no snapshot kicks it. Stubbed
// to fail, so the "never read" case stays never-read and nothing here touches a database.
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { connect: () => Promise.reject(new Error('no db in tests')) },
  pgDbReadLong: {},
  pgDbWrite: {},
}));

import {
  APP_PUBLISH_QUEUE_MAX_STALENESS_MS,
  APP_PUBLISH_QUEUE_OLDEST_SECONDS,
  APP_PUBLISH_QUEUE_PENDING_COUNT,
  __setAppPublishQueueSnapshotForTest,
  computeAppPublishQueueGauges,
} from '~/server/prom/app-publish-queue.metrics';

type Sample = { value: number; labels: Record<string, string> };

async function samples(name: string): Promise<Sample[]> {
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<{ values: Sample[] }>;
  };
  return (await metric.get()).values;
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

afterEach(() => {
  __setAppPublishQueueSnapshotForTest(null);
  vi.useRealTimers();
});

describe('computeAppPublishQueueGauges', () => {
  it('age of the oldest pending request in seconds, and the pending count, per kind', () => {
    const values = computeAppPublishQueueGauges(
      [
        // 44 hours waiting — the case nobody noticed.
        { kind: 'block', pending: 3, oldest: new Date(NOW - 44 * 3600 * 1000) },
        // pg returns count(*)::int as a number, but a string must not break it.
        { kind: 'listing', pending: '2', oldest: '2026-11-07T11:30:00.000Z' },
      ],
      NOW
    );
    expect(values).toEqual({
      block: { pending: 3, oldestPendingSeconds: 158_400 },
      listing: { pending: 2, oldestPendingSeconds: 1_800 },
    });
  });

  it('an empty queue is 0/0, and a kind missing from the rows is 0/0 rather than absent', () => {
    expect(
      computeAppPublishQueueGauges([{ kind: 'block', pending: 0, oldest: null }], NOW)
    ).toEqual({
      block: { pending: 0, oldestPendingSeconds: 0 },
      listing: { pending: 0, oldestPendingSeconds: 0 },
    });
  });

  it('never emits a negative or NaN age, and ignores an unknown kind', () => {
    const values = computeAppPublishQueueGauges(
      [
        { kind: 'block', pending: 1, oldest: new Date(NOW + 60_000) }, // clock skew
        { kind: 'listing', pending: 1, oldest: 'not a date' },
        { kind: 'mystery', pending: 99, oldest: new Date(0) },
      ],
      NOW
    );
    expect(values).toEqual({
      block: { pending: 1, oldestPendingSeconds: 0 },
      listing: { pending: 1, oldestPendingSeconds: 0 },
    });
  });
});

describe('the scraped gauges', () => {
  it('serve the snapshot at scrape time, so the age keeps growing between reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    __setAppPublishQueueSnapshotForTest([
      { kind: 'block', pending: 1, oldest: new Date(NOW - 10_000) },
      { kind: 'listing', pending: 0, oldest: null },
    ]);
    expect(await samples(APP_PUBLISH_QUEUE_OLDEST_SECONDS)).toEqual([
      { value: 10, labels: { kind: 'block' } },
      { value: 0, labels: { kind: 'listing' } },
    ]);
    expect(await samples(APP_PUBLISH_QUEUE_PENDING_COUNT)).toEqual([
      { value: 1, labels: { kind: 'block' } },
      { value: 0, labels: { kind: 'listing' } },
    ]);
    vi.setSystemTime(NOW + 30_000); // inside the refresh TTL: same snapshot, older request
    expect(
      (await samples(APP_PUBLISH_QUEUE_OLDEST_SECONDS)).find((s) => s.labels.kind === 'block')
        ?.value
    ).toBe(40);
  });

  it('stop emitting once the last good read is older than the staleness bound (reads failing)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    __setAppPublishQueueSnapshotForTest([{ kind: 'block', pending: 4, oldest: new Date(NOW) }]);
    // Just inside the bound: still served (the refresh it kicks fails against the stub).
    vi.setSystemTime(NOW + APP_PUBLISH_QUEUE_MAX_STALENESS_MS - 1_000);
    expect(
      (await samples(APP_PUBLISH_QUEUE_PENDING_COUNT)).find((s) => s.labels.kind === 'block')?.value
    ).toBe(4);
    // Past it: absent, not a frozen 4 that hides a growing queue.
    vi.setSystemTime(NOW + APP_PUBLISH_QUEUE_MAX_STALENESS_MS + 1_000);
    expect(await samples(APP_PUBLISH_QUEUE_PENDING_COUNT)).toEqual([]);
    expect(await samples(APP_PUBLISH_QUEUE_OLDEST_SECONDS)).toEqual([]);
  });

  it('emit NOTHING before the first successful read — never a zero that reads as "queue empty"', async () => {
    __setAppPublishQueueSnapshotForTest(null);
    expect(await samples(APP_PUBLISH_QUEUE_OLDEST_SECONDS)).toEqual([]);
    expect(await samples(APP_PUBLISH_QUEUE_PENDING_COUNT)).toEqual([]);
  });
});
