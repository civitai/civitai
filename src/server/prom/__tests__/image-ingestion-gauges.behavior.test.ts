import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  failImageQuery: false,
  imageQueries: 0,
  sqls: [] as string[],
  releases: [] as (Error | undefined)[],
}));

// src/__tests__/setup.ts stubs this module globally.
vi.unmock('~/server/prom/client');

// Hands the refresh's SQL to PGlite unmodified; canned rows could not catch a wrong WHERE.
vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbWrite: {},
  pgDbRead: {
    connect: async () => ({
      query: async (sql: string) => {
        holder.sqls.push(sql);
        if (sql.includes('"Image"')) holder.imageQueries++;
        if (holder.failImageQuery && sql.includes('"Image"'))
          throw new Error('canceling statement due to statement timeout');
        return holder.db.query(sql);
      },
      release: (error?: Error) => {
        holder.releases.push(error);
      },
    }),
  },
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {} }));

import type * as PromClient from '~/server/prom/client';
import {
  __ingestionGaugeSnapshotVersionForTest,
  __refreshIngestionGaugesForTest,
  instrumentationRegistry,
  setIngestionGaugeSharedStore,
  type IngestionGaugeSharedStore,
} from '~/server/prom/client';

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

async function series(name: string): Promise<[string, number][]> {
  const metric = instrumentationRegistry.getSingleMetric(`civitai_app_${name}`) as unknown as {
    get: () => Promise<MetricJSON>;
  };
  const { values } = await metric.get();
  return values
    .map((v) => [v.labels.type ?? v.labels.status ?? '', v.value] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const value = async (name: string) => (await series(name))[0]?.[1];

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id serial PRIMARY KEY,
      ingestion text NOT NULL,
      type text NOT NULL,
      "createdAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "JobQueue" (
      type text NOT NULL,
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      "createdAt" timestamp(3) NOT NULL
    );
  `);
});

beforeEach(async () => {
  holder.failImageQuery = false;
  holder.imageQueries = 0;
  holder.sqls = [];
  holder.releases = [];
  // Different stuck counts per type, so a swapped image/video mapping cannot pass.
  await holder.db.exec(`
    TRUNCATE "Image", "JobQueue";
    INSERT INTO "Image" (ingestion, type, "createdAt") VALUES
      ('Pending', 'image', now() - interval '30 minutes'),
      ('Pending', 'image', now() - interval '40 minutes'),
      ('Pending', 'image', now() - interval '2 minutes'),
      ('Pending', 'image', now() - interval '3 days'),
      ('Pending', 'video', now() - interval '1 hour'),
      ('Scanned', 'image', now() - interval '30 minutes');
    INSERT INTO "JobQueue" (type, "entityType", "entityId", "createdAt") VALUES
      ('ImageScan', 'Image', 1, now() - interval '2 hours'),
      ('ImageScan', 'Image', 2, now()),
      ('BlockedImageDelete', 'Image', 3, now() - interval '9 days');
  `);
});

afterEach(() => {
  vi.useRealTimers();
  setIngestionGaugeSharedStore(undefined);
});

describe('image-ingestion gauges', () => {
  it('counts only Pending rows 15m-24h old, and reports every media type even at zero', async () => {
    await __refreshIngestionGaugesForTest();

    // Whole list, not a lookup: a missing `audio` series is the regression, and a `?? 0` lookup
    // would read it as a healthy zero.
    expect(await series('image_ingestion_stuck_pending')).toEqual([
      ['audio', 0],
      ['image', 2],
      ['video', 1],
    ]);
    expect(await series('image_ingestion_backlog')).toContainEqual(['Pending', 5]);
  });

  it('counts the whole ImageScan queue and ages it by its oldest row', async () => {
    await __refreshIngestionGaugesForTest();

    expect(await value('image_scan_queue_depth')).toBe(2);
    const oldest = await value('image_scan_queue_oldest_age_seconds');
    expect(oldest).toBeGreaterThanOrEqual(7200);
    expect(oldest).toBeLessThan(7300);
  });

  it('a failed refresh keeps the last values, leaves the timestamp stale, and discards the client', async () => {
    // Frozen at the real current second, not a fixed date: PGlite's now() follows the faked clock,
    // and the seeded rows are relative to the real one.
    const start = new Date(Math.floor(Date.now() / 1000) * 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);

    await __refreshIngestionGaugesForTest();
    expect(await value('image_ingestion_gauges_refreshed_timestamp_seconds')).toBe(
      start.getTime() / 1000
    );
    expect(holder.releases).toEqual([undefined]);

    await holder.db.exec(`
      INSERT INTO "Image" (ingestion, type, "createdAt")
      VALUES ('Pending', 'image', now() - interval '20 minutes')
    `);
    holder.failImageQuery = true;
    // Well inside the 45s cache window, so reading the gauges below cannot start a refresh.
    vi.setSystemTime(new Date(start.getTime() + 10_000));
    await __refreshIngestionGaugesForTest();

    expect(await value('image_ingestion_gauges_refreshed_timestamp_seconds')).toBe(
      start.getTime() / 1000
    );
    expect(await series('image_ingestion_stuck_pending')).toContainEqual(['image', 2]);
    expect(holder.releases[1]).toBeInstanceOf(Error);
  });
});

const INGESTION_GAUGES = [
  'image_ingestion_backlog',
  'image_ingestion_oldest_age_seconds',
  'image_ingestion_stuck_pending',
  'image_scan_queue_depth',
  'image_scan_queue_oldest_age_seconds',
  'image_ingestion_gauges_refreshed_timestamp_seconds',
];

// A fresh module instance stands in for one process: its own in-process cache, and the gauges are
// re-registered so `series()` reads this instance's values.
async function loadProcess(): Promise<typeof PromClient> {
  for (const name of INGESTION_GAUGES)
    instrumentationRegistry.removeSingleMetric(`civitai_app_${name}`);
  vi.resetModules();
  return import('~/server/prom/client');
}

// Whole seconds, for the same reason as the frozen clock in the failed-refresh test below.
function freezeClock() {
  const now = Math.floor(Date.now() / 1000) * 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  return now;
}

const FRESH_AS_STRING = 'the fresh timestamp, as a string';

// Every value differs from what the seeded tables produce, so a gauge read tells which side it came from.
const sharedSnapshot = (computedAt: number) => ({
  computedAt,
  backlog: [{ status: 'Pending', backlog: 777, oldestAgeSeconds: 4321 }],
  stuckPending: { image: 13, video: 17, audio: 19 },
  scanQueue: { depth: 41, oldestAgeSeconds: 99 },
});

// In-memory stand-in for the shared store: one snapshot slot and one lock per version, like the real
// keys. The lock is set-if-absent, so exactly one caller per version wins it; every call yields
// first, so concurrent callers interleave the way separate processes would. `initial` is seeded under
// the version this release's queries produce.
function fakeStore(initial?: unknown) {
  const keys = new Map<string, string>();
  if (initial)
    keys.set(`snapshot:${__ingestionGaugeSnapshotVersionForTest()}`, JSON.stringify(initial));
  const calls = { tryLock: 0, won: 0, writes: [] as string[], versions: new Set<string>() };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const store: IngestionGaugeSharedStore = {
    read: async (version) => {
      await tick();
      calls.versions.add(version);
      return keys.get(`snapshot:${version}`) ?? null;
    },
    tryLock: async (version) => {
      await tick();
      calls.tryLock++;
      if (keys.has(`lock:${version}`)) return false;
      keys.set(`lock:${version}`, '1');
      calls.won++;
      return true;
    },
    write: async (version, value) => {
      await tick();
      keys.set(`snapshot:${version}`, value);
      calls.writes.push(value);
    },
  };
  return { store, calls };
}

describe('image-ingestion gauges shared across processes', () => {
  it('serves a fresh shared snapshot without running the queries or taking the lock', async () => {
    const now = freezeClock();
    const { store, calls } = fakeStore(sharedSnapshot(now - 5_000));
    const proc = await loadProcess();
    proc.setIngestionGaugeSharedStore(store);

    await proc.__refreshIngestionGaugesForTest();

    expect(holder.imageQueries).toBe(0);
    expect(calls.tryLock).toBe(0);
    expect(await series('image_ingestion_backlog')).toEqual([['Pending', 777]]);
    expect(await series('image_ingestion_stuck_pending')).toEqual([
      ['audio', 19],
      ['image', 13],
      ['video', 17],
    ]);
    expect(await value('image_scan_queue_depth')).toBe(41);
  });

  it('exports the time the shared values were computed, not the time this process read them', async () => {
    const now = freezeClock();
    const { store } = fakeStore(sharedSnapshot(now - 7_000));
    const proc = await loadProcess();
    proc.setIngestionGaugeSharedStore(store);

    await proc.__refreshIngestionGaugesForTest();

    expect(await value('image_ingestion_gauges_refreshed_timestamp_seconds')).toBe(
      (now - 7_000) / 1000
    );
  });

  it('when the snapshot is stale, one of five processes runs the queries and the rest serve the shared result', async () => {
    const now = freezeClock();
    const { store, calls } = fakeStore(sharedSnapshot(now - 60_000));
    const procs: (typeof PromClient)[] = [];
    for (let i = 0; i < 5; i++) procs.push(await loadProcess());
    setIngestionGaugeSharedStore(store);

    await Promise.all(procs.map((p) => p.__refreshIngestionGaugesForTest()));

    expect(calls.tryLock).toBe(5);
    expect(calls.won).toBe(1);
    expect(holder.imageQueries).toBe(1);
    expect(calls.writes).toHaveLength(1);
    const written = JSON.parse(calls.writes[0]);
    expect(written.computedAt).toBe(now);
    expect(written.backlog).toContainEqual(
      expect.objectContaining({ status: 'Pending', backlog: 5 })
    );
    // The four that lost keep serving the last shared values until the new ones land.
    const computedAts = procs.map((p) => p.__ingestionGaugeStateForTest().computedAt);
    expect(computedAts.filter((t) => t === now)).toHaveLength(1);
    expect(computedAts.filter((t) => t === now - 60_000)).toHaveLength(4);

    await Promise.all(procs.map((p) => p.__refreshIngestionGaugesForTest()));

    expect(holder.imageQueries).toBe(1);
    expect(calls.tryLock).toBe(5);
    for (const p of procs) {
      const state = p.__ingestionGaugeStateForTest();
      expect(state.computedAt).toBe(now);
      expect(state.backlog).toContainEqual(
        expect.objectContaining({ status: 'Pending', backlog: 5 })
      );
    }
  });

  it('a failing store falls back to querying in-process and the gauges are still served', async () => {
    const down = () => Promise.reject(new Error('sysRedis read timed out after 2000ms'));
    const proc = await loadProcess();
    proc.setIngestionGaugeSharedStore({ read: down, tryLock: down, write: down });

    await proc.__refreshIngestionGaugesForTest();

    expect(holder.imageQueries).toBe(1);
    expect(await series('image_ingestion_stuck_pending')).toEqual([
      ['audio', 0],
      ['image', 2],
      ['video', 1],
    ]);
    expect(await value('image_scan_queue_depth')).toBe(2);
  });

  // One case per field the shape check covers; every other field stays valid, so each case reaches
  // only its own check. Any of these applied would make collect() throw and fail the whole scrape.
  // Each patch replaces one field of a valid snapshot (undefined drops it from the JSON).
  // FRESH_AS_STRING stands for the snapshot's own fresh timestamp as a string: it would subtract
  // like a number and read as fresh, where any other string just reads as stale.
  it.each<[string, Record<string, unknown>]>([
    ['a computedAt that is a numeric string', { computedAt: FRESH_AS_STRING }],
    ['stuckPending missing', { stuckPending: undefined }],
    ['stuckPending null', { stuckPending: null }],
    ['a stuck count that is not a number', { stuckPending: { image: '13', video: 17, audio: 19 } }],
    ['backlog not an array', { backlog: { Pending: 777 } }],
    [
      'a backlog row whose count is a string',
      { backlog: [{ status: 'Pending', backlog: '777', oldestAgeSeconds: 4321 }] },
    ],
    ['a backlog row without its age', { backlog: [{ status: 'Pending', backlog: 777 }] }],
    ['a backlog row without its status', { backlog: [{ backlog: 777, oldestAgeSeconds: 4321 }] }],
    ['a scan-queue depth that is a string', { scanQueue: { depth: '41', oldestAgeSeconds: 99 } }],
    ['a scan queue without its age', { scanQueue: { depth: 41 } }],
  ])(
    'a fresh shared snapshot of the wrong shape (%s) is replaced, never served',
    async (_, patch) => {
      const now = freezeClock();
      const snapshot: Record<string, unknown> = { ...sharedSnapshot(now - 5_000), ...patch };
      if (snapshot.computedAt === FRESH_AS_STRING) snapshot.computedAt = String(now - 5_000);
      const { store, calls } = fakeStore(snapshot);
      const proc = await loadProcess();
      proc.setIngestionGaugeSharedStore(store);

      await proc.__refreshIngestionGaugesForTest();

      expect(calls.won).toBe(1);
      expect(holder.imageQueries).toBe(1);
      expect(JSON.parse(calls.writes[0]).stuckPending).toEqual({ image: 2, video: 1, audio: 0 });
      expect(await series('image_ingestion_stuck_pending')).toEqual([
        ['audio', 0],
        ['image', 2],
        ['video', 1],
      ]);
      expect(await series('image_ingestion_backlog')).toContainEqual(['Pending', 5]);
    }
  );

  it('a release whose queries differ never serves, or contends for, the other release’s snapshot', async () => {
    const now = freezeClock();
    const { store, calls } = fakeStore(sharedSnapshot(now - 5_000));
    vi.doMock('@civitai/shared/image-ingestion', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      STUCK_PENDING_MINUTES: 30,
    }));
    try {
      const proc = await loadProcess();
      proc.setIngestionGaugeSharedStore(store);

      await proc.__refreshIngestionGaugesForTest();

      expect(proc.__ingestionGaugeSnapshotVersionForTest()).not.toBe(
        __ingestionGaugeSnapshotVersionForTest()
      );
      expect([...calls.versions]).toEqual([proc.__ingestionGaugeSnapshotVersionForTest()]);
      expect(calls.won).toBe(1);
      expect(holder.imageQueries).toBe(1);
      expect(await series('image_ingestion_backlog')).toContainEqual(['Pending', 5]);
    } finally {
      vi.doUnmock('@civitai/shared/image-ingestion');
    }
  });

  // Pinned to what the database receives, so a query added to the refresh but left out of the
  // version (or dropped from it) fails here rather than sharing a key across releases.
  it('the snapshot version covers every query the refresh sends, and moves when any of them does', async () => {
    const proc = await loadProcess();

    await proc.__refreshIngestionGaugesForTest();

    const selects = holder.sqls.filter((sql) => /^\s*SELECT/i.test(sql));
    expect(selects).toHaveLength(2);
    const versionOf = proc.__ingestionGaugeSnapshotVersionOfForTest;
    expect(proc.__ingestionGaugeSnapshotVersionForTest()).toBe(versionOf(selects));
    expect(versionOf([`${selects[0]} `, selects[1]])).not.toBe(versionOf(selects));
    expect(versionOf([selects[0], `${selects[1]} `])).not.toBe(versionOf(selects));
    expect(versionOf([selects[0]])).not.toBe(versionOf(selects));
  });

  it('a process that lost the lock never replaces its own newer values with an older shared snapshot', async () => {
    const now = freezeClock();
    const down = () => Promise.reject(new Error('sysRedis read timed out after 2000ms'));
    const proc = await loadProcess();
    proc.setIngestionGaugeSharedStore({ read: down, tryLock: down, write: down });
    await proc.__refreshIngestionGaugesForTest();
    expect(proc.__ingestionGaugeStateForTest().computedAt).toBe(now);

    const { store, calls } = fakeStore(sharedSnapshot(now - 60_000));
    await store.tryLock(__ingestionGaugeSnapshotVersionForTest(), 0);
    proc.setIngestionGaugeSharedStore(store);
    await proc.__refreshIngestionGaugesForTest();

    expect(calls.won).toBe(1);
    expect(holder.imageQueries).toBe(1);
    expect(proc.__ingestionGaugeStateForTest().computedAt).toBe(now);
    expect(await series('image_ingestion_backlog')).toContainEqual(['Pending', 5]);
  });
});
