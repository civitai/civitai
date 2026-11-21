// The optional secondary ClickHouse destination for metric events: off by default, and never
// able to delay or fail the primary insert or the Kafka offset commit that follows it.
// Deliberately outside `src/common` (a hand-vendored copy; see signals.test.ts).
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Count every client the app builds, while still building real (never-connected) ones.
vi.mock('@clickhouse/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickhouse/client')>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

import { createClient } from '@clickhouse/client';
import { logger } from '@/utils/logger';
import { config, secondaryClickhouseConfig, SecondaryClickhouseConfig } from '@/config';
import { secondaryTeeMetrics } from '@/metrics';
import { EventProcessor } from '@/services/event-processor';
import { MetricEventBatcher } from '@/services/metric-event-batcher';
import {
  createSecondaryMetricTee,
  MetricEventRow,
  SecondaryMetricTee,
} from '@/services/secondary-metric-tee';
import type { MetricEvent } from '@/types/events';

type InsertArgs = {
  table: string;
  values: MetricEventRow[];
  format: string;
  clickhouse_settings?: Record<string, unknown>;
};

const NEVER = new Promise<never>(() => undefined);

/** A fake ClickHouse client whose insert behaviour is scripted per call. */
function fakeClient(behaviour: (args: InsertArgs, call: number) => Promise<unknown>) {
  const inserts: InsertArgs[] = [];
  const client = {
    insert: vi.fn((args: InsertArgs) => {
      inserts.push(args);
      return behaviour(args, inserts.length);
    }),
    close: vi.fn(async () => undefined),
  };
  return { client, inserts };
}

/** Pairwise-distinct fields, none equal to the batcher's own defaults (userId 0). */
function events(n: number, seed = 1): MetricEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    entityId: 1000 * seed + i + 7,
    entityType: i % 2 ? 'Image' : 'Model',
    metricType: i % 3 ? 'Like' : 'Collection',
    metricValue: i % 2 ? -1 : 1,
    userId: 50_000 + seed * 100 + i,
    timestamp: new Date(Date.UTC(2026, 0, 2, 3, 4, i)),
  }));
}

function rows(n: number, seed: number): MetricEventRow[] {
  return events(n, seed).map((e) => ({
    entityId: e.entityId,
    entityType: e.entityType,
    metricType: e.metricType,
    metricValue: e.metricValue,
    userId: e.userId as number,
    createdAt: e.timestamp as Date,
  }));
}

function tee(
  client: ReturnType<typeof fakeClient>['client'],
  over: Partial<ConstructorParameters<typeof SecondaryMetricTee>[1]> = {}
) {
  return new SecondaryMetricTee(client as never, {
    table: 'metrics.entityMetricEvents_month',
    maxQueueRows: 1000,
    insertTimeoutMs: 1000,
    shutdownTimeoutMs: 200,
    baseBackoffMs: 1,
    maxBackoffMs: 5,
    ...over,
  });
}

/** Resolves 'settled' if `p` settles within ms, else 'timed out'. */
async function settlesWithin(ms: number, p: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timed out'>((r) => (timer = setTimeout(() => r('timed out'), ms)));
  try {
    return await Promise.race([p.then(() => 'settled' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function counter(
  c: { get(): Promise<{ values: { value: number; labels: object }[] }> },
  labels: object = {}
) {
  const { values } = await c.get();
  return values.find((v) => JSON.stringify(v.labels) === JSON.stringify(labels))?.value ?? 0;
}

const enabledCfg: SecondaryClickhouseConfig = {
  enabled: true,
  url: 'http://secondary.example:8123',
  username: 'tee_user',
  password: 'tee_pass',
  database: 'tee_db',
  maxQueueRows: 1000,
};

const originalSecondary = config.clickhouse.secondary;
afterEach(() => {
  config.clickhouse.secondary = originalSecondary;
  vi.mocked(createClient).mockClear();
});

describe('(1) disabled by default: no secondary client, primary unchanged', () => {
  test('the switch is off unless it is exactly "true" AND a URL is set', () => {
    expect(secondaryClickhouseConfig({}).enabled).toBe(false);
    expect(secondaryClickhouseConfig({ CLICKHOUSE_SECONDARY_URL: 'http://x:8123' }).enabled).toBe(
      false
    );
    expect(secondaryClickhouseConfig({ METRICS_SECONDARY_TEE_ENABLED: 'true' }).enabled).toBe(
      false
    );
    expect(
      secondaryClickhouseConfig({
        METRICS_SECONDARY_TEE_ENABLED: '1',
        CLICKHOUSE_SECONDARY_URL: 'http://x:8123',
      }).enabled
    ).toBe(false);
    const on = secondaryClickhouseConfig({
      METRICS_SECONDARY_TEE_ENABLED: 'true',
      CLICKHOUSE_SECONDARY_URL: 'http://x:8123',
    });
    expect(on.enabled).toBe(true);
    expect(on.database).toBe('metrics');
  });

  test('the process default (no env) is off', () => {
    expect(config.clickhouse.secondary.enabled).toBe(false);
  });

  test('createSecondaryMetricTee builds nothing when off', () => {
    const make = vi.fn();
    expect(
      createSecondaryMetricTee({ ...enabledCfg, enabled: false }, 't', make as never)
    ).toBeNull();
    expect(make).not.toHaveBeenCalled();
  });

  test('EventProcessor builds exactly one ClickHouse client when off', () => {
    config.clickhouse.secondary = { ...enabledCfg, enabled: false };
    const p = new EventProcessor(1) as unknown as { metricBatcher: { secondary: unknown } };
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);
    expect(p.metricBatcher.secondary).toBeNull();
  });

  test('EventProcessor builds the secondary client from its own settings when on', () => {
    config.clickhouse.secondary = enabledCfg;
    const p = new EventProcessor(1) as unknown as { metricBatcher: { secondary: unknown } };
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createClient).mock.calls[1][0]).toMatchObject({
      url: 'http://secondary.example:8123',
      username: 'tee_user',
      password: 'tee_pass',
      database: 'tee_db',
    });
    expect(p.metricBatcher.secondary).toBeInstanceOf(SecondaryMetricTee);
  });

  test('with no tee the batcher inserts and commits exactly as before', async () => {
    const primary = fakeClient(async () => undefined);
    const batcher = new MetricEventBatcher(primary.client as never, 60_000);
    const commits: Map<string, string>[] = [];
    batcher.onFlushed((s) => void commits.push(s));
    for (const e of events(3)) batcher.add(e);
    batcher.markOffset({ topic: 't', partition: 0, offset: '41' });
    await batcher.flush();
    expect(primary.inserts).toHaveLength(1);
    expect(primary.inserts[0].table).toBe(config.clickhouse.metricEventsTable);
    expect(primary.inserts[0].clickhouse_settings).toBeUndefined();
    expect(commits).toEqual([new Map([['t:0', '41']])]);
  });
});

describe('(2) enabled: the secondary receives exactly the primary rows', () => {
  test('same rows, JSONEachRow, <db>.entityMetricEvents_month, insert_quorum=2', async () => {
    const primary = fakeClient(async () => undefined);
    const secondary = fakeClient(async () => undefined);
    const t = createSecondaryMetricTee(
      enabledCfg,
      'entityMetricEvents_month',
      (() => secondary.client) as never
    )!;
    const batcher = new MetricEventBatcher(primary.client as never, 60_000, 10_000, 500_000, t);
    const sentBefore = await counter(secondaryTeeMetrics.rowsSent);

    for (const e of events(5, 3)) batcher.add(e);
    await batcher.flush();
    await t.idle();

    expect(secondary.inserts).toHaveLength(1);
    expect(secondary.inserts[0].values).toEqual(primary.inserts[0].values);
    expect(secondary.inserts[0].values).toEqual(rows(5, 3));
    expect(secondary.inserts[0].table).toBe('tee_db.entityMetricEvents_month');
    expect(secondary.inserts[0].format).toBe('JSONEachRow');
    expect(secondary.inserts[0].clickhouse_settings).toEqual({ insert_quorum: '2' });
    expect((await counter(secondaryTeeMetrics.rowsSent)) - sentBefore).toBe(5);
  });

  test('a batch the primary rejected is not teed (it is re-queued and teed once it lands)', async () => {
    let fail = true;
    const primary = fakeClient(async () => {
      if (fail) throw new Error('primary down');
    });
    const secondary = fakeClient(async () => undefined);
    const t = tee(secondary.client);
    const batcher = new MetricEventBatcher(primary.client as never, 60_000, 10_000, 500_000, t);
    for (const e of events(2, 4)) batcher.add(e);
    await expect(batcher.flush()).rejects.toThrow('primary down');
    await t.idle();
    expect(secondary.inserts).toHaveLength(0);
    fail = false;
    await batcher.flush();
    await t.idle();
    expect(secondary.inserts.map((i) => i.values)).toEqual([rows(2, 4)]);
  });

  test('a failed secondary insert is retried and then sent', async () => {
    const secondary = fakeClient(async (_a, call) => {
      if (call === 1) throw new Error('secondary blip');
    });
    const t = tee(secondary.client);
    const failedBefore = await counter(secondaryTeeMetrics.batchesFailed);
    t.enqueue(rows(2, 5));
    await t.idle();
    expect(secondary.inserts.map((i) => i.values)).toEqual([rows(2, 5), rows(2, 5)]);
    expect((await counter(secondaryTeeMetrics.batchesFailed)) - failedBefore).toBe(1);
  });
});

describe('(3) a failing or hanging secondary never touches the primary path', () => {
  test('a hanging secondary insert is abandoned after its timeout and retried', async () => {
    const secondary = fakeClient((_a, call) => (call === 1 ? NEVER : Promise.resolve()));
    const t = tee(secondary.client, { insertTimeoutMs: 20 });
    const failedBefore = await counter(secondaryTeeMetrics.batchesFailed);
    t.enqueue(rows(2, 17));
    expect(await settlesWithin(1_000, t.idle())).toBe('settled');
    expect(secondary.inserts.map((i) => i.values)).toEqual([rows(2, 17), rows(2, 17)]);
    expect((await counter(secondaryTeeMetrics.batchesFailed)) - failedBefore).toBe(1);
  });

  for (const [name, behaviour] of [
    ['hangs forever', () => NEVER],
    ['throws', async () => Promise.reject(new Error('secondary down'))],
  ] as const) {
    test(`secondary ${name}: flush settles promptly, primary insert and offset commit happen`, async () => {
      const primary = fakeClient(async () => undefined);
      const secondary = fakeClient(behaviour);
      const t = tee(secondary.client, {
        insertTimeoutMs: 60_000,
        baseBackoffMs: 60_000,
        maxBackoffMs: 60_000,
      });
      const batcher = new MetricEventBatcher(primary.client as never, 60_000, 10_000, 500_000, t);
      const commits: Map<string, string>[] = [];
      batcher.onFlushed((s) => void commits.push(s));

      for (const e of events(4, 6)) batcher.add(e);
      batcher.markOffset({ topic: 'metrics', partition: 3, offset: '9001' });

      const started = Date.now();
      expect(await settlesWithin(500, batcher.flush())).toBe('settled');
      expect(Date.now() - started).toBeLessThan(500);
      expect(secondary.inserts).toHaveLength(0); // the send starts on a later event-loop turn
      await new Promise((r) => setImmediate(r));
      expect(secondary.inserts).toHaveLength(1);
      expect(primary.inserts.map((i) => i.values)).toEqual([rows(4, 6)]);
      expect(commits).toEqual([new Map([['metrics:3', '9001']])]);

      expect(await settlesWithin(1_000, t.stop(100))).toBe('settled');
    });
  }

  test('a tee whose enqueue throws cannot fail the flush', async () => {
    const primary = fakeClient(async () => undefined);
    const broken = {
      enqueue: () => {
        throw new Error('tee exploded');
      },
      stop: async () => undefined,
    };
    const batcher = new MetricEventBatcher(
      primary.client as never,
      60_000,
      10_000,
      500_000,
      broken
    );
    const commits: Map<string, string>[] = [];
    batcher.onFlushed((s) => void commits.push(s));
    for (const e of events(2, 7)) batcher.add(e);
    batcher.markOffset({ topic: 'metrics', partition: 1, offset: '12' });
    await batcher.flush();
    expect(primary.inserts).toHaveLength(1);
    expect(commits).toEqual([new Map([['metrics:1', '12']])]);
    expect(batcher.getStats().currentQueueSize).toBe(0);
  });

  test('shutdown with a hanging secondary is bounded by its timeout', async () => {
    const primary = fakeClient(async () => undefined);
    const secondary = fakeClient(() => NEVER);
    const t = tee(secondary.client, { insertTimeoutMs: 60_000, shutdownTimeoutMs: 100 });
    const batcher = new MetricEventBatcher(primary.client as never, 60_000, 10_000, 500_000, t);
    const droppedBefore = await counter(secondaryTeeMetrics.batchesDropped, { reason: 'shutdown' });
    for (const e of events(2, 8)) batcher.add(e);
    await batcher.flush();
    t.enqueue(rows(3, 9)); // queued behind the hanging batch
    const started = Date.now();
    expect(await settlesWithin(1_000, batcher.stop())).toBe('settled');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      (await counter(secondaryTeeMetrics.batchesDropped, { reason: 'shutdown' })) - droppedBefore
    ).toBe(1);
  });
});

describe('(4) overflow drops the oldest chunks and counts them', () => {
  test('bounded by rows held; oldest queued chunk dropped, newest kept, drop counted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const secondary = fakeClient(async (_a, call) => {
      if (call === 1) await gate; // first chunk stays in flight
    });
    const t = tee(secondary.client, { maxQueueRows: 10 }); // chunks of at most 5 rows
    const batchesBefore = await counter(secondaryTeeMetrics.batchesDropped, { reason: 'overflow' });
    const rowsBefore = await counter(secondaryTeeMetrics.rowsDropped, { reason: 'overflow' });

    t.enqueue(rows(2, 10));
    await new Promise((r) => setImmediate(r)); // in flight: 2
    expect(secondary.inserts).toHaveLength(1);
    t.enqueue(rows(3, 11)); // held 5
    t.enqueue(rows(3, 12)); // held 8
    expect(t.pendingRows).toBe(6);
    t.enqueue(rows(4, 13)); // held 12 > 10 -> drop seed 11 (3) -> held 9
    expect(t.pendingRows).toBe(7);
    expect((await secondaryTeeMetrics.queueRows.get()).values[0].value).toBe(9);
    expect(
      (await counter(secondaryTeeMetrics.batchesDropped, { reason: 'overflow' })) - batchesBefore
    ).toBe(1);
    expect(
      (await counter(secondaryTeeMetrics.rowsDropped, { reason: 'overflow' })) - rowsBefore
    ).toBe(3);

    release();
    await t.idle();
    expect(secondary.inserts.map((i) => i.values)).toEqual([rows(2, 10), rows(3, 12), rows(4, 13)]);
  });
});

describe('(5) audit round 1', () => {
  const badUrlCfg: SecondaryClickhouseConfig = { ...enabledCfg, url: 'clickhouse-2:8123' };

  test('a malformed secondary URL disables the tee; EventProcessor and the primary are unaffected', async () => {
    config.clickhouse.secondary = badUrlCfg;
    let p: { metricBatcher: { secondary: unknown } } | undefined;
    expect(() => {
      p = new EventProcessor(1) as unknown as { metricBatcher: { secondary: unknown } };
    }).not.toThrow();
    expect(p!.metricBatcher.secondary).toBeNull();

    vi.mocked(logger.error).mockClear();
    const t = createSecondaryMetricTee(badUrlCfg, 'entityMetricEvents_month');
    expect(t).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);

    const primary = fakeClient(async () => undefined);
    const batcher = new MetricEventBatcher(primary.client as never, 60_000, 10_000, 500_000, t);
    const commits: Map<string, string>[] = [];
    batcher.onFlushed((s) => void commits.push(s));
    for (const e of events(3, 31)) batcher.add(e);
    batcher.markOffset({ topic: 'metrics', partition: 2, offset: '77' });
    await batcher.flush();
    expect(primary.inserts.map((i) => i.values)).toEqual([rows(3, 31)]);
    expect(commits).toEqual([new Map([['metrics:2', '77']])]);
  });

  test('enqueue does O(1) work: the insert (which encodes eagerly) starts on a later event-loop turn', async () => {
    const primary = fakeClient(async () => undefined);
    const secondary = fakeClient(async () => undefined);
    const t = tee(secondary.client);
    const batcher = new MetricEventBatcher(primary.client as never, 60_000, 10_000, 500_000, t);
    for (const e of events(3, 32)) batcher.add(e);
    await batcher.flush();
    // Drain every pending microtask: deferring with a microtask would not be enough.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(secondary.client.insert).not.toHaveBeenCalled();

    await new Promise((r) => setImmediate(r));
    expect(secondary.inserts.map((i) => i.values)).toEqual([rows(3, 32)]);
    await t.idle();
  });

  test('rows held (queued + in flight) never exceed the bound, even for one oversized batch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const heldAtInsert: number[] = [];
    let t!: SecondaryMetricTee;
    const secondary = fakeClient(async (args, call) => {
      heldAtInsert.push(args.values.length + t.pendingRows);
      if (call === 1) await gate;
    });
    // Bound 5 -> send chunks of at most 2 rows, so one chunk in flight plus one queued fits.
    t = tee(secondary.client, { maxQueueRows: 5 });
    const rowsBefore = await counter(secondaryTeeMetrics.rowsDropped, { reason: 'overflow' });

    t.enqueue(rows(2, 33));
    await new Promise((r) => setImmediate(r));
    expect(secondary.inserts).toHaveLength(1); // 2 rows in flight

    const big = rows(12, 34);
    t.enqueue(big);
    // 2 in flight + at most 3 queued; whole chunks only, so 2 queued (the newest chunk).
    expect(2 + t.pendingRows).toBeLessThanOrEqual(5);
    expect(t.pendingRows).toBe(2);
    expect((await secondaryTeeMetrics.queueRows.get()).values[0].value).toBe(4);
    expect(
      (await counter(secondaryTeeMetrics.rowsDropped, { reason: 'overflow' })) - rowsBefore
    ).toBe(10);

    release();
    await t.idle();
    expect(secondary.inserts.map((i) => i.values)).toEqual([rows(2, 33), big.slice(10, 12)]);
    expect(Math.max(...heldAtInsert)).toBeLessThanOrEqual(5);
  });

  test('the queue gauge counts the rows in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const secondary = fakeClient(async (_a, call) => {
      if (call === 1) await gate;
    });
    const t = tee(secondary.client, { maxQueueRows: 100 });
    t.enqueue(rows(3, 35));
    await new Promise((r) => setImmediate(r));
    expect(secondary.inserts).toHaveLength(1); // 3 rows in flight
    t.enqueue(rows(2, 36));
    expect((await secondaryTeeMetrics.queueRows.get()).values[0].value).toBe(5);
    release();
    await t.idle();
    expect((await secondaryTeeMetrics.queueRows.get()).values[0].value).toBe(0);
  });
});
