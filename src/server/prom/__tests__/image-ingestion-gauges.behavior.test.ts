import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  failImageQuery: false,
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

import { __refreshIngestionGaugesForTest, instrumentationRegistry } from '~/server/prom/client';

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
