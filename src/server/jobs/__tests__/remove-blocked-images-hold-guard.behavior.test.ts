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
// The stored-file delete, captured by key: the only place a file leaves storage.
const storage = vi.hoisted(() => ({ deletedKeys: [] as string[] }));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getB2ImageS3Client: () => ({
    send: async (command: { input: { Key: string } }) => {
      storage.deletedKeys.push(command.input.Key);
      return {};
    },
  }),
}));
vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: async () => ({ backend: 'b2Image' }),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import * as imageService from '~/server/services/image.service';
import { purgeHoldGuard } from '~/server/jobs/image-ingestion';
import { legalHoldUserIdsSql, userNamedOnHoldingReportSql } from '~/server/utils/legal-hold';
import {
  accountHoldSql,
  assertOwnersNotUnderLegalHold,
  LegalHoldUnconfirmedError,
} from '~/server/services/legal-hold.service';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { imagesSearchIndex } from '~/server/search-index';
import * as postService from '~/server/services/post.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const NO_COPY = { holdForTrainingCopy: false };

const HOLD_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
);

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

// Hold markers. Owners, then one blocked, unflagged image each.
const RECENT_REPORT_USER = 56; // report sent and archived 10 days ago
const MARKED_SECONDARY_USER = 57; // named as the secondary user on that report
const MANUAL_USER = 58; // hold set by a person, no end date
const RELEASED_USER = 59; // hold set by a person, then released
const EXTENDED_USER = 60; // report sent over a year ago, hold extended past today
const RECENT_REPORTED = 70;
const MARKED_SECONDARY = 71;
const MANUAL = 72;
const RELEASED = 73;
const EXTENDED = 74;
const MARKED = [RECENT_REPORTED, MARKED_SECONDARY, MANUAL, RELEASED, EXTENDED];
const LAPSED_USER = 61; // report sent a year and a day ago
const LAPSED = 75;
const LIVE_HELD = 76; // a held owner's image still on the site
const POST_NEIGHBOUR = 77; // an unheld owner's image in the same post
const POST = 500;

const BACKFILL_RECENT_USER = 30;
const BACKFILL_EXPIRED_USER = 31;
const BACKFILL_SECONDARY_USER = 32;
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
      metadata jsonb,
      "updatedAt" timestamp(3),
      "cascadeParentId" int
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      title text,
      detail text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "publishedAt" timestamp(3),
      "modelVersionId" int,
      "collectionId" int,
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
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${BACKFILL_RECENT_USER}, now() - interval '30 days', now() - interval '30 days',
        '{"secondaryUserId": ${BACKFILL_SECONDARY_USER}}'),
      (${BACKFILL_EXPIRED_USER}, now() - interval '400 days', now() - interval '400 days', '{}');
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
  // Off unless a case turns it on, so the guard is what the other cases exercise, and so the report
  // fixtures below write no hold markers of their own.
  await holder.db.exec(`
    ALTER TABLE "Image" DISABLE TRIGGER "Image_evidence_hold";
    ALTER TABLE "CsamReport" DISABLE TRIGGER "CsamReport_evidence_hold";
  `);
});

// The hold tables refuse TRUNCATE, so the reset between cases runs with triggers off.
const reset = (tables: string) =>
  holder.db.exec(`
    SET session_replication_role = replica;
    TRUNCATE ${tables};
    SET session_replication_role = DEFAULT;
  `);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    if (!flat.text.includes('DELETE FROM "Image"') && !flat.text.includes('"EvidenceHoldImage"'))
      return [];
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);

  await reset(
    '"Image", "CsamReport", "AppealDecisionRecord", "EvidenceHold", "EvidenceHoldImage", "Post", "EvidenceHoldPost", "Model"'
  );
  await holder.db.exec(`
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

const insertMarkedOwners = () =>
  holder.db.exec(`
    ALTER TABLE "CsamReport" ENABLE TRIGGER "CsamReport_evidence_hold";
    INSERT INTO "Image" (id, "userId", ingestion, "needsReview") VALUES
      (${RECENT_REPORTED}, ${RECENT_REPORT_USER}, 'Blocked', NULL),
      (${MARKED_SECONDARY}, ${MARKED_SECONDARY_USER}, 'Blocked', NULL),
      (${MANUAL}, ${MANUAL_USER}, 'Blocked', NULL),
      (${RELEASED}, ${RELEASED_USER}, 'Blocked', NULL),
      (${EXTENDED}, ${EXTENDED_USER}, 'Blocked', NULL);
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details) VALUES
      (${RECENT_REPORT_USER}, now() - interval '10 days', now() - interval '10 days',
        '{"secondaryUserId": ${MARKED_SECONDARY_USER}}'),
      (${EXTENDED_USER}, now() - interval '400 days', now() - interval '400 days', '{}');
    ALTER TABLE "CsamReport" DISABLE TRIGGER "CsamReport_evidence_hold";
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
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('legalHoldUserIdsSql', () => {
  it('names the subject and secondary user of every report still inside the hold', async () => {
    // The query the job runs, as it runs it.
    const { rows } = await holder.db.query<{ userId: string }>(
      legalHoldUserIdsSql.text,
      legalHoldUserIdsSql.values
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

  describe('hold markers', () => {
    beforeEach(insertMarkedOwners);

    it('keeps every image of a held owner, and only of a held owner', async () => {
      await imageService.deleteImages([...ALL, ...MARKED], true, {
        onlyWhere: purgeHoldGuard(NO_COPY),
      });

      expect((await remaining()).filter((id) => MARKED.includes(id))).toEqual([
        RECENT_REPORTED,
        MARKED_SECONDARY,
        MANUAL,
        EXTENDED,
      ]);
    });

    it('deletes the image once the hold has ended', async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion) VALUES (${LAPSED}, ${LAPSED_USER}, 'Blocked');
        INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES
          (${LAPSED_USER}, now() - interval '366 days', now() - interval '366 days');
        INSERT INTO "EvidenceHold" ("userId", role, reason, "releaseAt")
          VALUES (${LAPSED_USER}, 'manual', 'review', now() - interval '1 day');
      `);

      await imageService.deleteImages([LAPSED], true, { onlyWhere: purgeHoldGuard(NO_COPY) });

      expect(await remaining()).not.toContain(LAPSED);
    });

    // A transfer checks this before it moves anything, with the predicate the purge jobs read.
    it('refuses an owner change for a held owner or the placeholder owner, and no other', async () => {
      const routeToPostgres = () =>
        vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementationOnce((async (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => {
          const flat = Prisma.sql(strings, ...(values as never[]));
          return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
        }) as never);

      // Held, as opposed to unreadable, which is a subclass of the same error.
      const held = { name: 'LegalHoldError' };

      routeToPostgres();
      await expect(
        assertOwnersNotUnderLegalHold([LONG_CLOSED_USER, MANUAL_USER])
      ).rejects.toMatchObject(held);
      routeToPostgres();
      await expect(assertOwnersNotUnderLegalHold([PLACEHOLDER_OWNER])).rejects.toMatchObject(held);
      // An account leg: PLAIN_USER is on no report but has an image under CSAM review.
      routeToPostgres();
      await expect(assertOwnersNotUnderLegalHold([PLAIN_USER])).rejects.toMatchObject(held);
      // The control.
      routeToPostgres();
      await expect(
        assertOwnersNotUnderLegalHold([LONG_CLOSED_USER, RELEASED_USER])
      ).resolves.toBeUndefined();
    });

    it('refuses an owner change when the hold cannot be read', async () => {
      // Unrouted, the query answers no rows.
      await expect(assertOwnersNotUnderLegalHold([LONG_CLOSED_USER])).rejects.toBeInstanceOf(
        LegalHoldUnconfirmedError
      );
      vi.mocked(dbMock.dbWrite.$queryRaw).mockRejectedValueOnce(new Error('db down'));
      await expect(assertOwnersNotUnderLegalHold([LONG_CLOSED_USER])).rejects.toBeInstanceOf(
        LegalHoldUnconfirmedError
      );
    });
  });

  // The backstop for every other deletion path, which passes no guard.
  describe('the image delete trigger', () => {
    beforeEach(async () => {
      await insertMarkedOwners();
      await holder.db.exec(`ALTER TABLE "Image" ENABLE TRIGGER "Image_evidence_hold"`);
    });
    afterEach(() => holder.db.exec(`ALTER TABLE "Image" DISABLE TRIGGER "Image_evidence_hold"`));

    it("keeps a held owner's rows with no guard given, and every requested id leaves search", async () => {
      const deleted = await imageService.deleteImages([PLAIN, ...MARKED], true);

      expect(deleted.map((r) => r.id).sort((a, b) => a - b)).toEqual([PLAIN, RELEASED]);
      expect((await remaining()).filter((id) => MARKED.includes(id))).toEqual([
        RECENT_REPORTED,
        MARKED_SECONDARY,
        MANUAL,
        EXTENDED,
      ]);
      const deindexed = vi
        .mocked(imagesSearchIndex.queueUpdate)
        .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
      expect(deindexed.sort((a, b) => a - b)).toEqual([PLAIN, ...MARKED].sort((a, b) => a - b));
    });

    // A guard that knows only the report holds lets the marker-held row through to the trigger.
    it('takes a kept row out of search under a guard, and leaves a row the guard excluded', async () => {
      await imageService.deleteImages([PLAIN, MANUAL, REPORTED], true, {
        onlyWhere: Prisma.sql`NOT ${userNamedOnHoldingReportSql(Prisma.raw('"Image"."userId"'))}`,
      });

      expect(await remaining()).toEqual(expect.arrayContaining([MANUAL, REPORTED]));
      const deindexed = vi
        .mocked(imagesSearchIndex.queueUpdate)
        .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
      // REPORTED is the control: excluded by the guard, so still live and still indexed.
      expect(deindexed.sort((a, b) => a - b)).toEqual([PLAIN, MANUAL]);
      expect(
        vi.mocked(userImageVideoCountCaches.bust).mock.calls.flatMap(([ids]) => ids as number[])
      ).toContain(MANUAL_USER);
    });

    // Keyed on the rows the DELETE returned, never on the ids asked for: a kept image's file is
    // the evidence.
    it("deletes the stored file of each deleted image and never a kept one's", async () => {
      await holder.db.exec(`UPDATE "Image" SET url = 'file-' || id`);
      storage.deletedKeys = [];
      setEnv({ DATABASE_IS_PROD: true });
      try {
        await imageService.deleteImages([PLAIN, ...MARKED], true);
      } finally {
        setEnv({ DATABASE_IS_PROD: false });
      }

      expect(storage.deletedKeys.sort()).toEqual([`file-${PLAIN}`, `file-${RELEASED}`]);
    });

    // Kept counts as moderated: the account-deletion markers go, already-blocked rows included, or
    // restoring the account would un-block the image. Keys are the app's own constants.
    it("drops a kept image's account-deletion markers, keeping the rest of its metadata", async () => {
      await holder.db.query(
        `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", metadata)
         VALUES ($1, $2, 'Blocked', 'moderated', $3), ($4, $5, 'Blocked', 'moderated', $3)`,
        [
          LIVE_HELD,
          MANUAL_USER,
          JSON.stringify({
            width: 1,
            [PRIOR_INGESTION_KEY]: 'Scanned',
            [PRIOR_BLOCKED_FOR_KEY]: null,
          }),
          POST_NEIGHBOUR,
          PLAIN_USER,
        ]
      );
      // The neighbour is unheld and deleted, so only the kept row is read back.
      await imageService.deleteImages([LIVE_HELD, POST_NEIGHBOUR], true);

      const rows = (
        await holder.db.query<{ id: number; metadata: unknown }>(
          `SELECT id, metadata FROM "Image" WHERE id IN (${LIVE_HELD}, ${POST_NEIGHBOUR})`
        )
      ).rows;
      expect(rows).toEqual([{ id: LIVE_HELD, metadata: { width: 1 } }]);
    });

    it('takes a kept image out of its post and records which post it was in', async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion, "postId") VALUES
          (${LIVE_HELD}, ${MANUAL_USER}, 'Scanned', ${POST}),
          (${POST_NEIGHBOUR}, ${PLAIN_USER}, 'Scanned', ${POST});
      `);
      const postBust = vi.spyOn(postService, 'bustCachesForPosts').mockResolvedValue(undefined);
      const inPost = async () =>
        (
          await holder.db.query<{ id: number }>(
            `SELECT id FROM "Image" WHERE "postId" = ${POST} ORDER BY id`
          )
        ).rows.map((r) => r.id);
      const record = async () =>
        (
          await holder.db.query(
            `SELECT "imageId", "userId", "postId" FROM "EvidenceHoldImage" ORDER BY "imageId"`
          )
        ).rows;

      await imageService.deleteImages([LIVE_HELD], true);

      expect(await remaining()).toContain(LIVE_HELD);
      expect(await inPost()).toEqual([POST_NEIGHBOUR]);
      expect(await record()).toEqual([{ imageId: LIVE_HELD, userId: MANUAL_USER, postId: POST }]);
      // The deleted rows' bust runs too, empty here; the kept post is busted once.
      expect(postBust.mock.calls.filter(([ids]) => (ids as number[]).length)).toEqual([[[POST]]]);

      // A second delete finds it already out of the post; the first record stands.
      await imageService.deleteImages([LIVE_HELD], true);
      expect(await record()).toEqual([{ imageId: LIVE_HELD, userId: MANUAL_USER, postId: POST }]);
      postBust.mockRestore();
    });

    // The trigger writes the block in SQL; these are the app's own values for a moderator block, so
    // the two spellings cannot drift apart unnoticed.
    it("takes a held owner's live image off the site the way a moderator block does", async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel", "needsReview")
        VALUES (${LIVE_HELD}, ${MANUAL_USER}, 'Scanned', 1, 'csam');
      `);

      await imageService.deleteImages([LIVE_HELD], true);

      const row = (
        await holder.db.query<Record<string, unknown>>(
          `SELECT ingestion, "nsfwLevel", "blockedFor", "needsReview", "updatedAt" IS NOT NULL AS stamped
           FROM "Image" WHERE id = ${LIVE_HELD}`
        )
      ).rows[0];
      expect(row).toEqual({
        ingestion: 'Blocked',
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: BlockedReason.Moderated,
        needsReview: 'csam',
        stamped: true,
      });
    });

    // AiNotVerified is a block its owner can lift, and one the blocked-image purge never deletes.
    it("moves a held owner's AiNotVerified image to the moderated block", async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel", "blockedFor")
        VALUES (${LIVE_HELD}, ${MANUAL_USER}, 'Blocked', 4, '${BlockedReason.AiNotVerified}');
      `);

      await imageService.deleteImages([LIVE_HELD], true);

      const row = (
        await holder.db.query<Record<string, unknown>>(
          `SELECT ingestion, "nsfwLevel", "blockedFor" FROM "Image" WHERE id = ${LIVE_HELD}`
        )
      ).rows[0];
      expect(row).toEqual({
        ingestion: 'Blocked',
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: BlockedReason.Moderated,
      });
    });

    // A Blocked row with no reason is no moderator's block either.
    it("gives a held owner's blocked image with no block reason the moderated block", async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel")
        VALUES (${LIVE_HELD}, ${MANUAL_USER}, 'Blocked', 4);
      `);

      await imageService.deleteImages([LIVE_HELD], true);

      const row = (
        await holder.db.query<Record<string, unknown>>(
          `SELECT "nsfwLevel", "blockedFor" FROM "Image" WHERE id = ${LIVE_HELD}`
        )
      ).rows[0];
      expect(row).toEqual({ nsfwLevel: NsfwLevel.Blocked, blockedFor: BlockedReason.Moderated });
    });

    it.each([BlockedReason.Moderated, BlockedReason.TOS, BlockedReason.CSAM])(
      "leaves a held owner's image under a moderator's %s block exactly as it was",
      async (blockedFor) => {
        await holder.db.exec(`
          INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel", "blockedFor")
          VALUES (${LIVE_HELD}, ${MANUAL_USER}, 'Blocked', ${NsfwLevel.Blocked}, '${blockedFor}');
        `);

        await imageService.deleteImages([LIVE_HELD], true);

        const row = (
          await holder.db.query<Record<string, unknown>>(
            `SELECT ingestion, "blockedFor", "updatedAt" FROM "Image" WHERE id = ${LIVE_HELD}`
          )
        ).rows[0];
        expect(row).toEqual({ ingestion: 'Blocked', blockedFor, updatedAt: null });
      }
    );

    // A model transfer moves a held owner's models, images and posts to another account.
    it("refuses to move a held owner's model, image or post to another owner", async () => {
      await holder.db.exec(`
        INSERT INTO "Post" (id, "userId") VALUES (${POST}, ${MANUAL_USER}), (${
        POST + 1
      }, ${PLAIN_USER});
        INSERT INTO "Model" (id, "userId") VALUES (1, ${MANUAL_USER}), (2, ${PLAIN_USER});
      `);

      await expect(
        holder.db.exec(`UPDATE "Model" SET "userId" = ${PLAIN_USER} WHERE id = 1`)
      ).rejects.toThrow(/cannot change owner/);
      await holder.db.exec(`UPDATE "Model" SET "userId" = ${MANUAL_USER} WHERE id = 2`);

      await expect(
        holder.db.exec(`UPDATE "Image" SET "userId" = ${PLAIN_USER} WHERE id = ${MANUAL}`)
      ).rejects.toThrow(/cannot change owner/);
      await expect(
        holder.db.exec(`UPDATE "Post" SET "userId" = ${PLAIN_USER} WHERE id = ${POST}`)
      ).rejects.toThrow(/cannot change owner/);
      // The control: an unheld owner's rows move.
      await holder.db.exec(`
        UPDATE "Image" SET "userId" = ${MANUAL_USER} WHERE id = ${PLAIN};
        UPDATE "Post" SET "userId" = ${MANUAL_USER} WHERE id = ${POST + 1};
      `);
      expect(
        (
          await holder.db.query<{ userId: number }>(
            `SELECT "userId" FROM "Image" WHERE id IN (${PLAIN}, ${MANUAL}) ORDER BY id`
          )
        ).rows.map((r) => r.userId)
      ).toEqual([MANUAL_USER, MANUAL_USER]);
      expect(
        (
          await holder.db.query<{ userId: number }>(
            `SELECT "userId" FROM "Post" WHERE id IN (${POST}, ${POST + 1}) ORDER BY id`
          )
        ).rows.map((r) => r.userId)
      ).toEqual([MANUAL_USER, MANUAL_USER]);
      expect(
        (
          await holder.db.query<{ userId: number }>(`SELECT "userId" FROM "Model" ORDER BY id`)
        ).rows.map((r) => r.userId)
      ).toEqual([MANUAL_USER, MANUAL_USER]);
    });

    it("fails a cascading delete of a held owner's image rather than orphan it", async () => {
      await holder.db.exec(`
        CREATE TABLE "CascadeParent" (id int PRIMARY KEY);
        ALTER TABLE "Image" ADD CONSTRAINT image_cascade_parent FOREIGN KEY ("cascadeParentId")
          REFERENCES "CascadeParent"(id) ON DELETE CASCADE;
        INSERT INTO "CascadeParent" VALUES (1), (2);
        UPDATE "Image" SET "cascadeParentId" = 1 WHERE id = ${MANUAL};
        UPDATE "Image" SET "cascadeParentId" = 2 WHERE id = ${PLAIN};
      `);
      try {
        await expect(holder.db.exec(`DELETE FROM "CascadeParent" WHERE id = 1`)).rejects.toThrow(
          /cannot be deleted/
        );
        // The control: an unheld owner's image cascades as before.
        await holder.db.exec(`DELETE FROM "CascadeParent" WHERE id = 2`);
        expect(await remaining()).toContain(MANUAL);
        expect(await remaining()).not.toContain(PLAIN);
      } finally {
        await holder.db.exec(`
          UPDATE "Image" SET "cascadeParentId" = NULL;
          ALTER TABLE "Image" DROP CONSTRAINT image_cascade_parent;
          DROP TABLE "CascadeParent";
        `);
      }
    });
  });

  describe('how a hold ends', () => {
    beforeEach(insertMarkedOwners);

    const holdIdOf = async (userId: number) =>
      (
        await holder.db.query<{ id: number }>(
          `SELECT id FROM "EvidenceHold" WHERE "userId" = ${userId}`
        )
      ).rows[0].id;

    it.each([
      [
        'moving the release date into the past',
        `"releaseAt" = now() - interval '1 day'`,
        RECENT_REPORT_USER,
      ],
      [
        'bringing the end forward to just before it would run out',
        `"releaseAt" = now() + interval '1 second'`,
        RECENT_REPORT_USER,
      ],
      [
        'giving an open-ended hold an end date',
        `"releaseAt" = now() + interval '30 days'`,
        MANUAL_USER,
      ],
    ])('refuses %s without a recorded release', async (_name, set, userId) => {
      const id = await holdIdOf(userId);
      await expect(
        holder.db.exec(`UPDATE "EvidenceHold" SET ${set} WHERE id = ${id}`)
      ).rejects.toThrow(/recorded release/);
    });

    it.each([
      ['its id', `id = 999999`],
      ['its owner', `"userId" = 999`],
      ['its report', `"csamReportId" = 999`],
      ['its role', `role = 'secondary'`],
      ['when its report was sent', `"reportSentAt" = now()`],
      ['its reason', `reason = 'other'`],
      ['when it was made', `"createdAt" = now() - interval '5 years'`],
      ['who made it', `"createdById" = 7`],
    ])('refuses to change %s', async (_name, set) => {
      const id = await holdIdOf(RECENT_REPORT_USER);
      await expect(
        holder.db.exec(`UPDATE "EvidenceHold" SET ${set} WHERE id = ${id}`)
      ).rejects.toThrow(/owner or source/);
    });

    it('refuses to change who asked for an extension without a new one', async () => {
      const id = await holdIdOf(EXTENDED_USER);
      await expect(
        holder.db.exec(
          `UPDATE "EvidenceHold" SET "extensionRequestedBy" = 'someone else' WHERE id = ${id}`
        )
      ).rejects.toThrow(/only with a new one/);
    });

    it.each([`"releaseReason" = 'r'`, `"releasedById" = 1`])(
      'refuses release columns without the release itself (%s)',
      async (set) => {
        const id = await holdIdOf(MANUAL_USER);
        await expect(
          holder.db.exec(`UPDATE "EvidenceHold" SET ${set} WHERE id = ${id}`)
        ).rejects.toThrow(/only with "releasedAt"/);
      }
    );

    it('refuses a new hold row that carries release columns but no release', async () => {
      await expect(
        holder.db.exec(`
          INSERT INTO "EvidenceHold" ("userId", role, reason, "releaseReason")
          VALUES (${PLAIN_USER}, 'manual', 'review', 'r')
        `)
      ).rejects.toThrow(/release_whole_check/);
    });

    it('refuses to clear an extension, even once the end has moved past it', async () => {
      const id = await holdIdOf(EXTENDED_USER);
      await holder.db.exec(
        `UPDATE "EvidenceHold" SET "releaseAt" = now() + interval '2 years' WHERE id = ${id}`
      );
      await expect(
        holder.db.exec(`
          UPDATE "EvidenceHold" SET "extendedUntil" = NULL, "extensionRequestedBy" = NULL,
            "extensionReference" = NULL
          WHERE id = ${id}
        `)
      ).rejects.toThrow(/cannot clear its extension/);
    });

    it.each([
      ['who asked', `"extensionRequestedBy" = ' ', "extensionReference" = 'r'`],
      ['the reference', `"extensionRequestedBy" = 'a', "extensionReference" = ' '`],
    ])('refuses an extension with a blank %s', async (_name, fields) => {
      const id = await holdIdOf(RECENT_REPORT_USER);
      await expect(
        holder.db.exec(`
          UPDATE "EvidenceHold" SET "extendedUntil" = now() + interval '2 years', ${fields}
          WHERE id = ${id}
        `)
      ).rejects.toThrow(/extension_logged_check/);
    });

    // The control for the end check: an edit that keeps the same end goes through.
    it('allows an edit that leaves the end where it was', async () => {
      const id = await holdIdOf(EXTENDED_USER);
      await holder.db.exec(
        `UPDATE "EvidenceHold" SET "releaseAt" = "releaseAt" - interval '1 day' WHERE id = ${id}`
      );
      expect(
        (
          await holder.db.query(
            `SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ${EXTENDED_USER}`
          )
        ).rows
      ).toHaveLength(1);
    });

    it('ends a hold by a recorded release, which then never changes', async () => {
      const id = await holdIdOf(MANUAL_USER);
      await holder.db.exec(`
        UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'r'
        WHERE id = ${id}
      `);
      expect(
        (await holder.db.query(`SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ${MANUAL_USER}`))
          .rows
      ).toEqual([]);

      await expect(
        holder.db.exec(`UPDATE "EvidenceHold" SET "releaseReason" = 'other' WHERE id = ${id}`)
      ).rejects.toThrow(/released and cannot change/);
    });

    it('stamps a release with the time it is recorded', async () => {
      const id = await holdIdOf(MANUAL_USER);
      await holder.db.exec(`
        UPDATE "EvidenceHold" SET "releasedAt" = now() - interval '30 days', "releasedById" = 1,
          "releaseReason" = 'r'
        WHERE id = ${id}
      `);
      const row = (
        await holder.db.query<{ recent: boolean }>(
          `SELECT "releasedAt" > now() - interval '1 minute' AS recent FROM "EvidenceHold" WHERE id = ${id}`
        )
      ).rows[0];
      expect(row.recent).toBe(true);
    });

    it('refuses a release with no reason', async () => {
      const id = await holdIdOf(MANUAL_USER);
      await expect(
        holder.db.exec(`
          UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = ' '
          WHERE id = ${id}
        `)
      ).rejects.toThrow(/release_logged_check/);
    });

    it.each([
      ['its end', `"releaseAt" = now() - interval '1 day'`, RECENT_REPORT_USER],
      ['its extension', `"extendedUntil" = now() + interval '3 years'`, EXTENDED_USER],
      ['who asked for its extension', `"extensionRequestedBy" = 'x'`, EXTENDED_USER],
    ])('refuses a release that also moves %s', async (_name, set, userId) => {
      const id = await holdIdOf(userId);
      await expect(
        holder.db.exec(`
          UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'r',
            ${set}
          WHERE id = ${id}
        `)
      ).rejects.toThrow(/dates in a release/);
    });

    it('refuses to delete a hold, released or not', async () => {
      await expect(
        holder.db.exec(`DELETE FROM "EvidenceHold" WHERE "userId" = ${MANUAL_USER}`)
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        holder.db.exec(`DELETE FROM "EvidenceHold" WHERE "userId" = ${RELEASED_USER}`)
      ).rejects.toThrow(/cannot be deleted/);
    });

    it.each(['EvidenceHold', 'EvidenceHoldImage', 'EvidenceHoldPost'])(
      'refuses to truncate %s',
      async (table) => {
        await expect(holder.db.exec(`TRUNCATE "${table}"`)).rejects.toThrow(/cannot be truncated/);
      }
    );

    // The control: an edit that keeps the hold running is not refused.
    it('allows extending a running hold', async () => {
      const id = await holdIdOf(RECENT_REPORT_USER);
      await holder.db.exec(`
        UPDATE "EvidenceHold" SET "extendedUntil" = now() + interval '2 years',
          "extensionRequestedBy" = 'a', "extensionReference" = 'r' WHERE id = ${id}
      `);
      const row = (
        await holder.db.query<{ ok: boolean }>(
          `SELECT "extendedUntil" > now() + interval '1 year' AS ok FROM "EvidenceHold" WHERE id = ${id}`
        )
      ).rows[0];
      expect(row.ok).toBe(true);
    });
  });

  describe('what a hold keeps of a deleted post, and for how long', () => {
    beforeEach(async () => {
      await insertMarkedOwners();
      // LAPSED_USER's only hold ended by its date; RELEASED_USER's was released.
      await reset('"Post", "EvidenceHoldPost"');
      await holder.db.exec(`
        INSERT INTO "EvidenceHold" ("userId", role, reason, "releaseAt")
          VALUES (${LAPSED_USER}, 'manual', 'review', now() - interval '1 day');
        INSERT INTO "Post" (id, "userId", title, detail, "createdAt", "publishedAt", "modelVersionId", "collectionId", metadata) VALUES
          (1, ${MANUAL_USER}, 't1', 'd1', '2025-01-02 03:04:05', '2025-02-03 04:05:06', 70, 80, '{"k": 1}'),
          (2, ${MARKED_SECONDARY_USER}, 't2', NULL, '2025-03-04 05:06:07', NULL, NULL, NULL, NULL),
          (3, ${PLAIN_USER}, 't3', 'd3', now(), now(), NULL, NULL, NULL),
          (4, ${RELEASED_USER}, 't4', NULL, now(), NULL, NULL, NULL, NULL),
          (5, ${LAPSED_USER}, 't5', NULL, now(), NULL, NULL, NULL, NULL);
      `);
    });

    const snapshots = async () =>
      (
        await holder.db.query<Record<string, unknown>>(
          `SELECT "postId", "userId", title, detail, "createdAt"::text AS "createdAt",
             "publishedAt"::text AS "publishedAt", "modelVersionId", "collectionId", metadata
           FROM "EvidenceHoldPost" ORDER BY "postId"`
        )
      ).rows;
    const keptImages = async () =>
      (
        await holder.db.query<{ imageId: number }>(
          `SELECT "imageId" FROM "EvidenceHoldImage" ORDER BY "imageId"`
        )
      ).rows.map((r) => r.imageId);

    // Any delete, the owner's own included; a manual hold and a report's secondary user alike. An
    // owner whose hold was released, or ended by its date, is not held.
    it("copies a held owner's post as it deletes it, and only a held owner's", async () => {
      await holder.db.exec(`DELETE FROM "Post"`);

      expect((await holder.db.query(`SELECT id FROM "Post"`)).rows).toEqual([]);
      expect(await snapshots()).toEqual([
        {
          postId: 1,
          userId: MANUAL_USER,
          title: 't1',
          detail: 'd1',
          createdAt: '2025-01-02 03:04:05',
          publishedAt: '2025-02-03 04:05:06',
          modelVersionId: 70,
          collectionId: 80,
          metadata: { k: 1 },
        },
        {
          postId: 2,
          userId: MARKED_SECONDARY_USER,
          title: 't2',
          detail: null,
          createdAt: '2025-03-04 05:06:07',
          publishedAt: null,
          modelVersionId: null,
          collectionId: null,
          metadata: null,
        },
      ]);
    });

    it("purges an owner's kept posts and images when their last hold is released", async () => {
      await holder.db.exec(`
        DELETE FROM "Post";
        INSERT INTO "EvidenceHoldImage" ("imageId", "userId", "postId") VALUES
          (${MANUAL}, ${MANUAL_USER}, 1), (${MARKED_SECONDARY}, ${MARKED_SECONDARY_USER}, 2);
        UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'r'
        WHERE "userId" = ${MANUAL_USER} AND "releasedAt" IS NULL;
      `);

      // The control: the still-held owner's rows stay.
      expect((await snapshots()).map((r) => r.postId)).toEqual([2]);
      expect(await keptImages()).toEqual([MARKED_SECONDARY]);
    });

    it('keeps them while another hold on the same owner is still running', async () => {
      await holder.db.exec(`
        INSERT INTO "Post" (id, "userId") VALUES (6, ${RECENT_REPORT_USER});
        DELETE FROM "Post";
        INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (${RECENT_REPORTED}, ${RECENT_REPORT_USER});
        INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${RECENT_REPORT_USER}, 'manual', 'review');
        UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'r'
        WHERE "userId" = ${RECENT_REPORT_USER} AND role = 'manual';
      `);

      expect((await snapshots()).map((r) => r.postId)).toEqual([1, 2, 6]);
      expect(await keptImages()).toEqual([RECENT_REPORTED]);
    });

    it.each([
      ['EvidenceHoldImage', 'imageId'],
      ['EvidenceHoldPost', 'postId'],
    ])("refuses to edit %s, or to delete a held owner's row from it", async (table, key) => {
      await holder.db.exec(`
        INSERT INTO "${table}" ("${key}", "userId") VALUES (90, ${MANUAL_USER}), (91, ${RELEASED_USER});
      `);

      await expect(
        holder.db.exec(`UPDATE "${table}" SET "userId" = ${PLAIN_USER} WHERE "${key}" = 90`)
      ).rejects.toThrow(/cannot change/);
      await expect(holder.db.exec(`DELETE FROM "${table}" WHERE "${key}" = 90`)).rejects.toThrow(
        /while its owner is held/
      );
      // The control: the row of an owner no longer held is deleted.
      await holder.db.exec(`DELETE FROM "${table}" WHERE "${key}" = 91`);
      expect(
        (await holder.db.query(`SELECT "${key}" AS id FROM "${table}" WHERE "${key}" IN (90, 91)`))
          .rows
      ).toEqual([{ id: 90 }]);
    });

    it('sweeps the rows of an owner whose hold ended by its date', async () => {
      await holder.db.exec(`
        DELETE FROM "Post";
        INSERT INTO "EvidenceHoldPost" ("postId", "userId") VALUES (9, ${LAPSED_USER});
        INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES
          (${LAPSED}, ${LAPSED_USER}), (${MANUAL}, ${MANUAL_USER});
        SELECT evidence_hold_purge_unheld();
      `);

      // The controls: the held owners' rows stay.
      expect((await snapshots()).map((r) => r.postId)).toEqual([1, 2]);
      expect(await keptImages()).toEqual([MANUAL]);
    });
  });

  describe('the report trigger', () => {
    beforeEach(() =>
      holder.db.exec(`ALTER TABLE "CsamReport" ENABLE TRIGGER "CsamReport_evidence_hold"`)
    );
    afterEach(() =>
      holder.db.exec(`ALTER TABLE "CsamReport" DISABLE TRIGGER "CsamReport_evidence_hold"`)
    );

    const holdsOf = async (reportId: number) =>
      (
        await holder.db.query<{ userId: number; role: string; releaseAt: Date }>(
          `SELECT "userId", role, "releaseAt" FROM "EvidenceHold"
           WHERE "csamReportId" = ${reportId} ORDER BY role`
        )
      ).rows;
    const sendReport = async (details: string) =>
      (
        await holder.db.query<{ id: number }>(
          `INSERT INTO "CsamReport" ("userId", "reportSentAt", details)
           VALUES (40, now(), '${details}') RETURNING id`
        )
      ).rows[0].id;

    // The way the app records a send: the report row exists first, unsent, and is updated.
    it('holds nothing while a report is unsent, and its owner for a year once it is sent', async () => {
      const id = (
        await holder.db.query<{ id: number }>(
          `INSERT INTO "CsamReport" ("userId", details) VALUES (42, '{}') RETURNING id`
        )
      ).rows[0].id;
      expect(await holdsOf(id)).toEqual([]);

      await holder.db.exec(`UPDATE "CsamReport" SET "reportSentAt" = now() WHERE id = ${id}`);

      const held = (
        await holder.db.query<{ inAYear: boolean; heldUntilMatches: boolean }>(
          `SELECT abs(extract(epoch FROM h."releaseAt" - (c."reportSentAt" + interval '1 year'))) < 1
                    AS "inAYear",
                  v."heldUntil" = h."releaseAt" AS "heldUntilMatches"
           FROM "EvidenceHold" h
           JOIN "CsamReport" c ON c.id = h."csamReportId"
           JOIN "EvidenceHeldUser" v ON v."userId" = h."userId"
           WHERE h."csamReportId" = ${id} AND h.role = 'subject'`
        )
      ).rows;
      expect(held).toEqual([{ inAYear: true, heldUntilMatches: true }]);
    });

    it.each([['{"secondaryUserId": "abc"}'], ['{"secondaryUserId": 99999999999}']])(
      'records a send with an unusable secondary id (%s) and holds only the subject',
      async (details) => {
        const id = await sendReport(details);
        expect((await holdsOf(id)).map((h) => h.role)).toEqual(['subject']);
      }
    );

    it('holds a secondary user added after the send', async () => {
      const id = await sendReport('{}');
      await holder.db.exec(
        `UPDATE "CsamReport" SET details = '{"secondaryUserId": 41}' WHERE id = ${id}`
      );
      expect((await holdsOf(id)).map((h) => [h.role, h.userId])).toEqual([
        ['secondary', 41],
        ['subject', 40],
      ]);
    });

    it("keeps the first send's release date when the send is recorded again", async () => {
      const id = await sendReport('{}');
      const [first] = await holdsOf(id);
      await holder.db.exec(
        `UPDATE "CsamReport" SET "reportSentAt" = now() + interval '5 days' WHERE id = ${id}`
      );
      expect((await holdsOf(id))[0].releaseAt).toEqual(first.releaseAt);
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

// The account guards' marker leg, read through the real view: a released or lapsed marker drops
// that leg only, and never another hold on the same account.
describe('accountHoldSql over the real marker view', () => {
  const RELEASED_REPORTED_USER = 90; // released marker, unsent report
  const RELEASED_ONLY_USER = 91; // released marker, nothing else
  const LAPSED_MARKER_USER = 92; // marker past its end date, nothing else
  const RUNNING_MARKER_USER = 93; // marker with no end date, nothing else

  const held = async (userId: number) => {
    const q = Prisma.sql`SELECT ${accountHoldSql(Prisma.sql`${userId}::int`, true)} AS held`;
    return (await holder.db.query<{ held: boolean }>(q.text, q.values as unknown[])).rows[0].held;
  };

  beforeEach(() =>
    holder.db.exec(`
      INSERT INTO "EvidenceHold" ("userId", role, reason, "releaseAt", "releasedAt", "releasedById", "releaseReason") VALUES
        (${RELEASED_REPORTED_USER}, 'manual', 'review', NULL, now(), 1, 'done'),
        (${RELEASED_ONLY_USER}, 'manual', 'review', NULL, now(), 1, 'done'),
        (${LAPSED_MARKER_USER}, 'manual', 'review', now() - interval '1 day', NULL, NULL, NULL),
        (${RUNNING_MARKER_USER}, 'manual', 'review', NULL, NULL, NULL, NULL);
      INSERT INTO "CsamReport" ("userId", details) VALUES (${RELEASED_REPORTED_USER}, '{}');
    `)
  );

  it("still holds a released marker's owner through an unsent report", async () => {
    expect(await held(RELEASED_REPORTED_USER)).toBe(true);
    // The control: the same released marker with no report holds nothing.
    expect(await held(RELEASED_ONLY_USER)).toBe(false);
  });

  it('lets a marker go at its end date, and holds through one still running', async () => {
    expect(await held(LAPSED_MARKER_USER)).toBe(false);
    expect(await held(RUNNING_MARKER_USER)).toBe(true);
  });
});

describe('the migration functions', () => {
  it('each pin their search_path', async () => {
    const rows = (
      await holder.db.query<{ proname: string; pinned: boolean }>(
        `SELECT proname, COALESCE(array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%', false) AS pinned
         FROM pg_proc WHERE proname LIKE 'evidence_hold%' ORDER BY proname`
      )
    ).rows;
    // Every function the migration creates, so one added later is counted here too.
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => !r.pinned)).toEqual([]);
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
      { userId: BACKFILL_SECONDARY_USER, releasedById: null, releaseReason: null },
    ]);
    expect(backfill.held).toEqual([BACKFILL_RECENT_USER, BACKFILL_SECONDARY_USER]);
  });
});
