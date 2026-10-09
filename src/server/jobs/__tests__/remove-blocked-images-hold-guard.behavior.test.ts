import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * `remove-blocked-images` reads its holds once at the start of a run, then deletes for as long as its
 * lock allows. `purgeHoldGuard` re-states those holds on the DELETE itself, so a hold placed while
 * the run is underway still stops it. Driven through the real `deleteImages`, whose DELETE runs
 * against a Postgres stand-in here, so both the predicate and its composition are exercised.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import * as imageService from '~/server/services/image.service';
import { purgeHoldGuard } from '~/server/jobs/image-ingestion';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { imagesSearchIndex } from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const PLAIN_USER = 1;
const OPEN_REPORT_USER = 2;
const EXPIRED_REPORT_USER = 3;
const CLOSED_REPORT_USER = 4;
const UNSENT_ARCHIVED_USER = 5;

// Image ids, named for the case each one pins.
const PLAIN = 10; // blocked, no hold -> deleted
const APPEALED = 11; // flagged for appeal mid-run -> kept
const FLAGGED = 12; // moderator-only review flag set mid-run -> kept
const UNBLOCKED = 13; // unblocked mid-run -> kept
const REPORTED = 14; // owner's report filed mid-run -> kept
const EXPIRED = 15; // owner's open report already judged past the ceiling -> deleted
const CLOSED = 16; // owner's report sent and archived -> deleted
const OTHER_FLAG = 17; // a review flag that is not a hold -> deleted
const UNSENT = 18; // owner's report archived but never sent -> kept
const ALL = [PLAIN, APPEALED, FLAGGED, UNBLOCKED, REPORTED, EXPIRED, CLOSED, OTHER_FLAG, UNSENT];

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text NOT NULL DEFAULT 'u',
      "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL,
      "needsReview" text,
      metadata jsonb
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3)
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    if (!flat.text.includes('DELETE FROM "Image"')) return [];
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);

  await holder.db.exec(`
    TRUNCATE "Image", "CsamReport";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${PLAIN}, ${PLAIN_USER}, 'Blocked', NULL),
      (${APPEALED}, ${PLAIN_USER}, 'Blocked', 'appeal'),
      (${FLAGGED}, ${PLAIN_USER}, 'Blocked', 'csam'),
      (${UNBLOCKED}, ${PLAIN_USER}, 'Scanned', NULL),
      (${REPORTED}, ${OPEN_REPORT_USER}, 'Blocked', NULL),
      (${EXPIRED}, ${EXPIRED_REPORT_USER}, 'Blocked', NULL),
      (${CLOSED}, ${CLOSED_REPORT_USER}, 'Blocked', NULL),
      (${OTHER_FLAG}, ${PLAIN_USER}, 'Blocked', 'minor'),
      (${UNSENT}, ${UNSENT_ARCHIVED_USER}, 'Blocked', NULL);
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES
      (${OPEN_REPORT_USER}, NULL, NULL),
      (${EXPIRED_REPORT_USER}, now(), NULL),
      (${CLOSED_REPORT_USER}, now(), now()),
      (${UNSENT_ARCHIVED_USER}, NULL, now());
  `);
});

const remaining = async () =>
  (await holder.db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map(
    (r) => r.id
  );

describe('purgeHoldGuard on the delete', () => {
  it('deletes only images no hold covers at the moment of the delete', async () => {
    const deleted = await imageService.deleteImages(ALL, true, {
      onlyWhere: purgeHoldGuard([EXPIRED_REPORT_USER]),
    });

    expect(deleted.map((r) => r.id).sort((a, b) => a - b)).toEqual([
      PLAIN,
      EXPIRED,
      CLOSED,
      OTHER_FLAG,
    ]);
    expect(await remaining()).toEqual([APPEALED, FLAGGED, UNBLOCKED, REPORTED, UNSENT]);
    // A kept image's own side effects must not run: it is still live in the database.
    const deindexed = vi
      .mocked(imagesSearchIndex.queueUpdate)
      .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
    expect(deindexed.sort((a, b) => a - b)).toEqual([PLAIN, EXPIRED, CLOSED, OTHER_FLAG]);
  });

  it('holds an open report whose owner the run did not judge expired', async () => {
    await imageService.deleteImages(ALL, true, { onlyWhere: purgeHoldGuard([]) });

    expect(await remaining()).toEqual([APPEALED, FLAGGED, UNBLOCKED, REPORTED, EXPIRED, UNSENT]);
  });

  it('applies the guard to every batch, not only the first', async () => {
    const extra = Array.from({ length: 150 }, (_, i) => 1000 + i);
    const lastFlagged = extra[extra.length - 1];
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview")
      SELECT g, ${PLAIN_USER}, 'Blocked', CASE WHEN g = ${lastFlagged} THEN 'csam' END
      FROM generate_series(${extra[0]}, ${lastFlagged}) g;
    `);

    await imageService.deleteImages(extra, true, { onlyWhere: purgeHoldGuard([]) });

    expect((await remaining()).filter((id) => id >= extra[0])).toEqual([lastFlagged]);
  });

  // The positive control for the cases above: without the guard the same call deletes every
  // fixture row, so what they keep is the guard's doing.
  it('deletes every listed image when no guard is given', async () => {
    await imageService.deleteImages(ALL, true);

    expect(await remaining()).toEqual([]);
  });
});
