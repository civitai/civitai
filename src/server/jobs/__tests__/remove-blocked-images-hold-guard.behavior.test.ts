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
import { legalHoldUserIdsSql } from '~/server/utils/legal-hold';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { imagesSearchIndex } from '~/server/search-index';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const NO_COPY = { holdForTrainingCopy: false };

const PLAIN_USER = 1;
const OPEN_REPORT_USER = 2;
const SENT_UNARCHIVED_USER = 3; // sent over a year ago, never archived
const RECENTLY_CLOSED_USER = 4; // sent and archived within the year
const UNSENT_ARCHIVED_USER = 5;
const LONG_CLOSED_USER = 6; // sent and archived over a year ago
const SECONDARY_USER = 7; // the secondary user on a report sent within the year
const LONG_CLOSED_SECONDARY_USER = 8; // the secondary user on LONG_CLOSED_USER's report
const REPORT_SUBJECT = 9; // owns nothing; the subject of the report naming SECONDARY_USER
const PLACEHOLDER_OWNER = -1;

// Image ids, named for the case each one pins.
const PLAIN = 10; // blocked, no hold -> deleted
const APPEALED = 11; // flagged for appeal mid-run -> kept
const FLAGGED = 12; // moderator-only review flag set mid-run -> kept
const UNBLOCKED = 13; // unblocked mid-run -> kept
const REPORTED = 14; // owner's report filed mid-run -> kept
const SENT_UNARCHIVED = 15; // kept, however old the report
const RECENTLY_CLOSED = 16; // kept for a year after the report was sent
const OTHER_FLAG = 17; // a review flag that is not a hold -> deleted
const UNSENT = 18; // owner's report archived but never sent -> kept
const LONG_CLOSED = 19; // the year is up -> deleted
const SECONDARY = 20; // kept: the hold covers the report's secondary user too
const PLACEHOLDER = 21; // owned by the placeholder owner -> kept
const LONG_CLOSED_SECONDARY = 22; // the year is up for the secondary user too -> deleted
const ALL = [
  PLAIN,
  APPEALED,
  FLAGGED,
  UNBLOCKED,
  REPORTED,
  SENT_UNARCHIVED,
  RECENTLY_CLOSED,
  OTHER_FLAG,
  UNSENT,
  LONG_CLOSED,
  SECONDARY,
  PLACEHOLDER,
  LONG_CLOSED_SECONDARY,
];
const DELETED = [PLAIN, OTHER_FLAG, LONG_CLOSED, LONG_CLOSED_SECONDARY];
const KEPT = ALL.filter((id) => !DELETED.includes(id));

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
      "blockedFor" text,
      metadata jsonb
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]',
      details jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "AppealDecisionRecord" (
      "imageId" int NOT NULL,
      "imageUrl" text,
      "blockedFor" text,
      decision text NOT NULL,
      "decidedAt" timestamptz NOT NULL DEFAULT now(),
      "removalLabel" text,
      "removalNsfw" text,
      "aiNsfwLevel" int,
      "trainingCopyState" text
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
    TRUNCATE "Image", "CsamReport", "AppealDecisionRecord";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${PLAIN}, ${PLAIN_USER}, 'Blocked', NULL),
      (${APPEALED}, ${PLAIN_USER}, 'Blocked', 'appeal'),
      (${FLAGGED}, ${PLAIN_USER}, 'Blocked', 'csam'),
      (${UNBLOCKED}, ${PLAIN_USER}, 'Scanned', NULL),
      (${REPORTED}, ${OPEN_REPORT_USER}, 'Blocked', NULL),
      (${SENT_UNARCHIVED}, ${SENT_UNARCHIVED_USER}, 'Blocked', NULL),
      (${RECENTLY_CLOSED}, ${RECENTLY_CLOSED_USER}, 'Blocked', NULL),
      (${OTHER_FLAG}, ${PLAIN_USER}, 'Blocked', 'minor'),
      (${UNSENT}, ${UNSENT_ARCHIVED_USER}, 'Blocked', NULL),
      (${LONG_CLOSED}, ${LONG_CLOSED_USER}, 'Blocked', NULL),
      (${SECONDARY}, ${SECONDARY_USER}, 'Blocked', NULL),
      (${PLACEHOLDER}, ${PLACEHOLDER_OWNER}, 'Blocked', NULL),
      (${LONG_CLOSED_SECONDARY}, ${LONG_CLOSED_SECONDARY_USER}, 'Blocked', NULL);
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${OPEN_REPORT_USER}, NULL, NULL, '{}'),
      (${SENT_UNARCHIVED_USER}, now() - interval '400 days', NULL, '{}'),
      (${RECENTLY_CLOSED_USER}, now() - interval '30 days', now(), 'null'),
      (${UNSENT_ARCHIVED_USER}, NULL, now(), '{}'),
      (${LONG_CLOSED_USER}, now() - interval '400 days', now(),
        '{"secondaryUserId": ${LONG_CLOSED_SECONDARY_USER}}'),
      (${REPORT_SUBJECT}, now() - interval '30 days', now(), '{"secondaryUserId": ${SECONDARY_USER}}'),
      (NULL, NULL, NULL, '{}');
  `);
});

const remaining = async () =>
  (await holder.db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map(
    (r) => r.id
  );
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('legalHoldUserIdsSql', () => {
  it('names the subject and secondary user of every report still inside the hold', async () => {
    const { rows } = await holder.db.query<{ userId: string }>(
      `SELECT DISTINCT held."userId" FROM (${legalHoldUserIdsSql.text}) held`
    );

    expect(rows.map((r) => Number(r.userId)).sort((a, b) => a - b)).toEqual([
      OPEN_REPORT_USER,
      SENT_UNARCHIVED_USER,
      RECENTLY_CLOSED_USER,
      UNSENT_ARCHIVED_USER,
      SECONDARY_USER,
      REPORT_SUBJECT,
    ]);
  });
});

describe('purgeHoldGuard on the delete', () => {
  it('deletes only images no hold covers at the moment of the delete', async () => {
    const deleted = await imageService.deleteImages(ALL, true, {
      onlyWhere: purgeHoldGuard(NO_COPY),
    });

    expect(sorted(deleted.map((r) => r.id))).toEqual(DELETED);
    expect(await remaining()).toEqual(KEPT);
    // A kept image's own side effects must not run: it is still live in the database.
    const deindexed = vi
      .mocked(imagesSearchIndex.queueUpdate)
      .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
    expect(sorted(deindexed)).toEqual(DELETED);
  });

  it('applies the guard to every batch, not only the first', async () => {
    const extra = Array.from({ length: 150 }, (_, i) => 1000 + i);
    const lastFlagged = extra[extra.length - 1];
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview")
      SELECT g, ${PLAIN_USER}, 'Blocked', CASE WHEN g = ${lastFlagged} THEN 'csam' END
      FROM generate_series(${extra[0]}, ${lastFlagged}) g;
    `);

    await imageService.deleteImages(extra, true, { onlyWhere: purgeHoldGuard(NO_COPY) });

    expect((await remaining()).filter((id) => id >= extra[0])).toEqual([lastFlagged]);
  });

  describe('the appeal training-copy hold', () => {
    beforeEach(async () => {
      await holder.db.exec(`
        INSERT INTO "AppealDecisionRecord" ("imageId", decision, "removalLabel") VALUES
          (${PLAIN}, 'Rejected', 'spam'),
          (${LONG_CLOSED}, 'Rejected', 'realisticMinorNsfw');
      `);
    });

    it('keeps a rejected image waiting for its copy when the copy job is configured', async () => {
      await imageService.deleteImages(ALL, true, {
        onlyWhere: purgeHoldGuard({ holdForTrainingCopy: true }),
      });

      expect(await remaining()).toEqual(sorted([PLAIN, ...KEPT]));
    });

    it('holds nothing for it when the copy job is not configured', async () => {
      await imageService.deleteImages(ALL, true, { onlyWhere: purgeHoldGuard(NO_COPY) });

      expect(await remaining()).toEqual(KEPT);
    });
  });

  // The positive control for the cases above: without the guard the same call deletes every
  // fixture row, so what they keep is the guard's doing.
  it('deletes every listed image when no guard is given', async () => {
    await imageService.deleteImages(ALL, true);

    expect(await remaining()).toEqual([]);
  });
});
