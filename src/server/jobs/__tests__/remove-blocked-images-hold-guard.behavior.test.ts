import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const NO_COPY = { holdForTrainingCopy: false };

const HOLD_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
);

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

// Hold markers. Owners, then one blocked, unflagged image each.
const RECENT_REPORT_USER = 6; // report sent and archived 10 days ago
const SECONDARY_USER = 7; // named as the secondary user on that report
const MANUAL_USER = 8; // hold set by a person, no end date
const RELEASED_USER = 9; // hold set by a person, then released
const EXTENDED_USER = 10; // report sent over a year ago, hold extended past today
const RECENT_REPORTED = 20;
const SECONDARY = 21;
const MANUAL = 22;
const RELEASED = 23;
const EXTENDED = 24;
const MARKED = [RECENT_REPORTED, SECONDARY, MANUAL, RELEASED, EXTENDED];

const BACKFILL_RECENT_USER = 30;
const BACKFILL_EXPIRED_USER = 31;
const backfill = {
  rows: [] as { userId: number; releasedById: number | null; releaseReason: string | null }[],
  held: [] as number[],
};

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
  // Reports already sent when the migration runs, for its backfill.
  await holder.db.exec(`
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES
      (${BACKFILL_RECENT_USER}, now() - interval '30 days', now() - interval '30 days'),
      (${BACKFILL_EXPIRED_USER}, now() - interval '400 days', now() - interval '400 days');
  `);
  await holder.db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  backfill.rows = (
    await holder.db.query<{
      userId: number;
      releasedById: number | null;
      releaseReason: string | null;
    }>(`SELECT "userId", "releasedById", "releaseReason" FROM "EvidenceHold" ORDER BY "userId"`)
  ).rows;
  backfill.held = (
    await holder.db.query<{ userId: number }>(
      `SELECT "userId" FROM "EvidenceHeldUser" ORDER BY "userId"`
    )
  ).rows.map((r) => r.userId);
  // Off unless a case turns it on, so the guard is what the other cases exercise.
  await holder.db.exec(`ALTER TABLE "Image" DISABLE TRIGGER "Image_evidence_hold"`);
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
    TRUNCATE "Image", "CsamReport", "AppealDecisionRecord", "EvidenceHold";
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
      -- Sent over a year ago, so the hold marker the send wrote has lapsed.
      (${EXPIRED_REPORT_USER}, now() - interval '400 days', NULL),
      (${CLOSED_REPORT_USER}, now() - interval '400 days', now() - interval '400 days'),
      (${UNSENT_ARCHIVED_USER}, NULL, now());
  `);
});

const insertMarkedOwners = () =>
  holder.db.exec(`
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${RECENT_REPORTED}, ${RECENT_REPORT_USER}, 'Blocked', NULL),
      (${SECONDARY}, ${SECONDARY_USER}, 'Blocked', NULL),
      (${MANUAL}, ${MANUAL_USER}, 'Blocked', NULL),
      (${RELEASED}, ${RELEASED_USER}, 'Blocked', NULL),
      (${EXTENDED}, ${EXTENDED_USER}, 'Blocked', NULL);
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${RECENT_REPORT_USER}, now() - interval '10 days', now() - interval '10 days',
        '{"secondaryUserId": ${SECONDARY_USER}}'),
      (${EXTENDED_USER}, now() - interval '400 days', now() - interval '400 days', '{}');
    UPDATE "EvidenceHold" SET "extendedUntil" = now() + interval '90 days', "extensionRequestedBy" = 'agency', "extensionReference" = 'ref'
      WHERE "userId" = ${EXTENDED_USER};
    INSERT INTO "EvidenceHold" ("userId", role, reason, "releasedAt", "releasedById", "releaseReason") VALUES
      (${MANUAL_USER}, 'manual', 'review', NULL, NULL, NULL),
      (${RELEASED_USER}, 'manual', 'review', now(), 1, 'done');
  `);

const remaining = async () =>
  (await holder.db.query<{ id: number }>(`SELECT id FROM "Image" ORDER BY id`)).rows.map(
    (r) => r.id
  );

describe('purgeHoldGuard on the delete', () => {
  it('deletes only images no hold covers at the moment of the delete', async () => {
    const deleted = await imageService.deleteImages(ALL, true, {
      onlyWhere: purgeHoldGuard([EXPIRED_REPORT_USER], NO_COPY),
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
    await imageService.deleteImages(ALL, true, { onlyWhere: purgeHoldGuard([], NO_COPY) });

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

    await imageService.deleteImages(extra, true, { onlyWhere: purgeHoldGuard([], NO_COPY) });

    expect((await remaining()).filter((id) => id >= extra[0])).toEqual([lastFlagged]);
  });

  describe('the appeal training-copy hold', () => {
    beforeEach(async () => {
      await holder.db.exec(`
        INSERT INTO "AppealDecisionRecord" ("imageId", decision, "removalLabel") VALUES
          (${PLAIN}, 'Rejected', 'spam'),
          (${CLOSED}, 'Rejected', 'realisticMinorNsfw');
      `);
    });

    it('keeps a rejected image waiting for its copy when the copy job is configured', async () => {
      await imageService.deleteImages(ALL, true, {
        onlyWhere: purgeHoldGuard([EXPIRED_REPORT_USER], { holdForTrainingCopy: true }),
      });

      expect(await remaining()).toEqual([PLAIN, APPEALED, FLAGGED, UNBLOCKED, REPORTED, UNSENT]);
    });

    it('holds nothing for it when the copy job is not configured', async () => {
      await imageService.deleteImages(ALL, true, {
        onlyWhere: purgeHoldGuard([EXPIRED_REPORT_USER], NO_COPY),
      });

      expect(await remaining()).toEqual([APPEALED, FLAGGED, UNBLOCKED, REPORTED, UNSENT]);
    });
  });

  describe('hold markers', () => {
    beforeEach(insertMarkedOwners);

    it('keeps every image of a held owner, and only of a held owner', async () => {
      await imageService.deleteImages([...ALL, ...MARKED], true, {
        onlyWhere: purgeHoldGuard([EXPIRED_REPORT_USER], NO_COPY),
      });

      expect((await remaining()).filter((id) => MARKED.includes(id))).toEqual([
        RECENT_REPORTED,
        SECONDARY,
        MANUAL,
        EXTENDED,
      ]);
    });

    it('is not lifted by the report-expiry override', async () => {
      await imageService.deleteImages(MARKED, true, {
        onlyWhere: purgeHoldGuard([RECENT_REPORT_USER, MANUAL_USER], NO_COPY),
      });

      expect(await remaining()).toContain(RECENT_REPORTED);
      expect(await remaining()).toContain(MANUAL);
    });

    it('deletes the image once the hold has ended', async () => {
      await holder.db.exec(`
        UPDATE "EvidenceHold" SET "releaseAt" = now() - interval '1 day'
        WHERE "userId" = ${RECENT_REPORT_USER}
      `);

      await imageService.deleteImages([RECENT_REPORTED], true, {
        onlyWhere: purgeHoldGuard([], NO_COPY),
      });

      expect(await remaining()).not.toContain(RECENT_REPORTED);
    });
  });

  // The backstop for every other deletion path, which passes no guard.
  describe('the image delete trigger', () => {
    beforeEach(async () => {
      await insertMarkedOwners();
      await holder.db.exec(`ALTER TABLE "Image" ENABLE TRIGGER "Image_evidence_hold"`);
    });
    afterEach(() => holder.db.exec(`ALTER TABLE "Image" DISABLE TRIGGER "Image_evidence_hold"`));

    it("skips a held owner's rows, and their side effects, with no guard given", async () => {
      const deleted = await imageService.deleteImages([PLAIN, ...MARKED], true);

      expect(deleted.map((r) => r.id).sort((a, b) => a - b)).toEqual([PLAIN, RELEASED]);
      expect((await remaining()).filter((id) => MARKED.includes(id))).toEqual([
        RECENT_REPORTED,
        SECONDARY,
        MANUAL,
        EXTENDED,
      ]);
      const deindexed = vi
        .mocked(imagesSearchIndex.queueUpdate)
        .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
      expect(deindexed.sort((a, b) => a - b)).toEqual([PLAIN, RELEASED]);
    });
  });

  // The positive control for the cases above: without the guard or the trigger the same call
  // deletes every fixture row, so what they keep is the guard's or the trigger's doing.
  it('deletes every listed image when no guard is given', async () => {
    await insertMarkedOwners();
    await imageService.deleteImages([...ALL, ...MARKED], true);

    expect(await remaining()).toEqual([]);
  });
});

describe('the migration backfill', () => {
  it('holds a report sent within the year and records an older one as released', () => {
    expect(backfill.rows).toEqual([
      { userId: BACKFILL_RECENT_USER, releasedById: null, releaseReason: null },
      {
        userId: BACKFILL_EXPIRED_USER,
        releasedById: -1,
        releaseReason: 'expired before table existed',
      },
    ]);
    expect(backfill.held).toEqual([BACKFILL_RECENT_USER]);
  });
});
