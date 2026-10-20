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
const LAPSED_USER = 11; // report sent a year and a day ago
const LAPSED = 25;
const LIVE_HELD = 26; // a held owner's image still on the site
const POST_NEIGHBOUR = 27; // an unheld owner's image in the same post
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
    if (!flat.text.includes('DELETE FROM "Image"') && !flat.text.includes('"EvidenceHoldImage"'))
      return [];
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);

  await holder.db.exec(`
    TRUNCATE "Image", "CsamReport", "AppealDecisionRecord", "EvidenceHold", "EvidenceHoldImage";
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

  // An unsent report writes no hold marker, so the run's ceiling still reaches its owner.
  it('purges an unsent open report the run judged past the ceiling', async () => {
    await imageService.deleteImages(ALL, true, {
      onlyWhere: purgeHoldGuard([OPEN_REPORT_USER], NO_COPY),
    });

    expect(await remaining()).not.toContain(REPORTED);
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
        INSERT INTO "Image" (id, "userId", ingestion) VALUES (${LAPSED}, ${LAPSED_USER}, 'Blocked');
        INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES
          (${LAPSED_USER}, now() - interval '366 days', now() - interval '366 days');
      `);

      await imageService.deleteImages([LAPSED], true, { onlyWhere: purgeHoldGuard([], NO_COPY) });

      expect(await remaining()).not.toContain(LAPSED);
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
        SECONDARY,
        MANUAL,
        EXTENDED,
      ]);
      const deindexed = vi
        .mocked(imagesSearchIndex.queueUpdate)
        .mock.calls.flatMap(([items]) => (items as { id: number }[]).map((i) => i.id));
      expect(deindexed.sort((a, b) => a - b)).toEqual([PLAIN, ...MARKED].sort((a, b) => a - b));
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

    it("leaves a held owner's already removed image exactly as it was", async () => {
      await holder.db.exec(`
        INSERT INTO "Image" (id, "userId", ingestion, "nsfwLevel", "blockedFor")
        VALUES (${LIVE_HELD}, ${MANUAL_USER}, 'Blocked', ${NsfwLevel.Blocked}, 'AiNotVerified');
      `);

      await imageService.deleteImages([LIVE_HELD], true);

      const row = (
        await holder.db.query<Record<string, unknown>>(
          `SELECT ingestion, "blockedFor", "updatedAt" FROM "Image" WHERE id = ${LIVE_HELD}`
        )
      ).rows[0];
      expect(row).toEqual({ ingestion: 'Blocked', blockedFor: 'AiNotVerified', updatedAt: null });
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
      ['clearing an extension that is still running', `"extendedUntil" = NULL`, EXTENDED_USER],
      ['moving the hold to another owner', `"userId" = 999`, MANUAL_USER],
    ])('refuses %s without a recorded release', async (_name, set, userId) => {
      const id = await holdIdOf(userId);
      await expect(
        holder.db.exec(`UPDATE "EvidenceHold" SET ${set} WHERE id = ${id}`)
      ).rejects.toThrow(/recorded release/);
    });

    it('refuses to delete a hold that was never released, and allows it once released', async () => {
      const id = await holdIdOf(MANUAL_USER);
      await expect(holder.db.exec(`DELETE FROM "EvidenceHold" WHERE id = ${id}`)).rejects.toThrow(
        /must be released/
      );

      await holder.db.exec(`
        UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = 1, "releaseReason" = 'r'
        WHERE id = ${id};
        DELETE FROM "EvidenceHold" WHERE id = ${id};
      `);
      expect((await holder.db.query(`SELECT 1 FROM "EvidenceHold" WHERE id = ${id}`)).rows).toEqual(
        []
      );
    });

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

  describe('the report trigger', () => {
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
