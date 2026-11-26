import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import {
  deleteImageRows,
  deletePostRows,
  queueImageDeletes,
  releasePendingDeletes,
} from '@civitai/db-queries/content-deletion';
import { childSafetyImageCase, childSafetyPostCase } from '@civitai/db-queries/child-safety-case';
import {
  imageDeleteBlocked,
  imagesPendingDeletion,
  postsWithDeleteQueued,
  releaseModeratorPendingDeletes,
  settleDeletes,
  PENDING_DELETES_ACTOR,
} from '@civitai/db-queries/pending-deletes';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  csamReportListedImageIdsSql,
  csamReportNamedUserIdsSql,
} from '@civitai/shared/held-media';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { postUnpublishContextOf } from '~/server/utils/post-unpublish-context';

vi.setConfig({ hookTimeout: 60_000 });

const OWNER = 7;
const SOMEONE_ELSE = 8;
const PLAIN = 1;
const IMAGE = 2;

const KEPT_HIDE_TRIGGER_SQL = readFileSync(
  `${__dirname}/../../../../packages/civitai-db-schema/prisma/migrations/20271203120000_image_kept_hide_marker_drop/migration.sql`,
  'utf8'
);

let pg: PGlite;
const db = pgliteKysely(() => pg);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM (
      'PendingDelete', 'ImageStorageDelete', 'UpdateNsfwLevel', 'CdnAccessSync', 'BlockedImageDelete'
    );
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await pg.exec(imageUseTablesSql);
  // Returned by the deletes.
  await pg.exec(`ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS metadata jsonb`);
  await pg.exec(`ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS index int`);
  await pg.exec(KEPT_HIDE_TRIGGER_SQL);
  await pg.exec(
    `CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 0,
      "publishedAt" timestamp, metadata jsonb)`
  );
});
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`TRUNCATE "JobQueue", "Image", "Post", "Report", "ImageReport", "PostReport", "ModActivity", "User",
    "CsamReport", "CsamQueueSetAside", "ImageConnection", "ServiceDealReviewImage",
    "ServiceDealReviewReport", "Appeal"`);
  await pg.exec(`INSERT INTO "Image" (id, "userId") VALUES (${PLAIN}, ${OWNER})`);
});

const addImage = (over: Record<string, unknown> = {}) => {
  const image = { id: IMAGE, userId: OWNER, ...over };
  const columns = Object.keys(image);
  return pg.query(
    `INSERT INTO "Image" (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(image)
  );
};
const report = (id: number, over = `reason = 'CSAM'`) =>
  pg.exec(`INSERT INTO "Report" (id) VALUES (${id}); UPDATE "Report" SET ${over} WHERE id = ${id}`);

const inCase = async () =>
  (
    await sql<{
      id: number;
    }>`SELECT id FROM "Image" WHERE ${childSafetyImageCase()} ORDER BY id`.execute(db)
  ).rows.map((row) => row.id);

describe('childSafetyImageCase', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['under CSAM review', () => addImage({ needsReview: 'csam' })],
    ['blocked for CSAM, its CyberTip not yet filed', () => addImage({ blockedFor: 'CSAM' })],
    [
      'reported for CSAM',
      async () => {
        await addImage();
        await report(1);
        await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
      },
    ],
    [
      'reported as child abuse and exploitation',
      async () => {
        await addImage();
        await report(
          1,
          `reason = 'TOSViolation', details = '{"violation": "Child abuse and exploitation"}'`
        );
        await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
      },
    ],
    [
      'blocked for CSAM, its CyberTip verified but not yet sent',
      async () => {
        await addImage({ blockedFor: 'CSAM' });
        await pg.exec(`INSERT INTO "CsamReport" (images, details)
          VALUES ('[2]', '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')`);
      },
    ],
    [
      'under CSAM review, set aside but not dismissed',
      async () => {
        await addImage({ needsReview: 'csam' });
        await pg.exec(`INSERT INTO "CsamQueueSetAside" VALUES (${IMAGE}, 'Confirmed')`);
      },
    ],
    [
      'reported as a child-safety TOS violation, the report being processed',
      async () => {
        await addImage();
        await report(
          1,
          `reason = 'TOSViolation', status = 'Processing', details = '{"violation": "Photorealistic depiction of a minor"}'`
        );
        await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
      },
    ],
    [
      'in a post reported for CSAM',
      async () => {
        await addImage({ postId: 50 });
        await report(1);
        await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1)`);
      },
    ],
    // A child-safety report on a service review holds the delete of the images attached to it.
    [
      'attached to a service review reported as a minor',
      async () => {
        await addImage();
        await report(
          1,
          `reason = 'TOSViolation', details = '{"violation": "Photorealistic depiction of a minor"}'`
        );
        await pg.exec(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES (9, ${IMAGE});
          INSERT INTO "ServiceDealReviewReport" ("reportId", "serviceDealReviewId") VALUES (1, 9)`);
      },
    ],
  ])('holds an image %s', async (_, setup) => {
    await setup();

    expect(await inCase()).toEqual([IMAGE]);
  });

  it.each<[string, () => Promise<unknown>]>([
    [
      'the CSAM queue dismissed',
      async () => {
        await addImage({ needsReview: 'csam' });
        await pg.exec(`INSERT INTO "CsamQueueSetAside" VALUES (${IMAGE}, 'Dismissed')`);
      },
    ],
    ...['{"id": 2}', '2', '"2"'].map(
      (listed) =>
        [
          `blocked for CSAM, filed with its evidence verified (listed as ${listed})`,
          async () => {
            await addImage({ blockedFor: 'CSAM' });
            await pg.exec(`INSERT INTO "CsamReport" (images, "reportSentAt", details)
              VALUES ('[${listed}]', now(), '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')`);
          },
        ] as [string, () => Promise<unknown>]
    ),
    [
      'whose CSAM report was ruled on',
      async () => {
        await addImage();
        await report(1, `reason = 'CSAM', status = 'Actioned'`);
        await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
      },
    ],
    [
      'reported for another TOS violation',
      async () => {
        await addImage();
        await report(1, `reason = 'TOSViolation', details = '{"violation": "Spam"}'`);
        await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
      },
    ],
    ['awaiting another review', () => addImage({ needsReview: 'minor' })],
    [
      'removed as CSAM from review, filed with its evidence verified',
      async () => {
        await addImage({ needsReview: 'csam', blockedFor: 'CSAM' });
        await pg.exec(`INSERT INTO "CsamReport" (images, "reportSentAt", details)
          VALUES ('[2]', now(), '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')`);
      },
    ],
    [
      'in a post whose CSAM report was ruled on',
      async () => {
        await addImage({ postId: 50 });
        await report(1, `reason = 'CSAM', status = 'Actioned'`);
        await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1)`);
      },
    ],
    [
      'attached to a service review whose CSAM report was ruled on, or reported only as spam',
      async () => {
        await addImage();
        await report(1, `reason = 'CSAM', status = 'Actioned'`);
        await report(2, `reason = 'Spam'`);
        await pg.exec(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES (9, ${IMAGE});
          INSERT INTO "ServiceDealReviewReport" ("reportId", "serviceDealReviewId") VALUES (1, 9), (2, 9)`);
      },
    ],
  ])('releases an image %s', async (_, setup) => {
    await setup();
    // Sent but unverified: still blocked.
    await pg.exec(`INSERT INTO "CsamReport" (images, "reportSentAt") VALUES ('[1]', now())`);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${PLAIN}`);

    expect(await inCase()).toEqual([PLAIN]);
  });

  it('reads past a malformed CSAM report, which releases nothing', async () => {
    await addImage({ blockedFor: 'CSAM' });
    await pg.exec(`INSERT INTO "CsamReport" (images, "reportSentAt", details) VALUES
      ('{}', now(), '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}'),
      ('[null]', now(), '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}'),
      ('[2]', now(), '[]')`);

    expect(await inCase()).toEqual([IMAGE]);
  });

  it('holds a post under an open child-safety report, not one whose report was ruled on', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId") VALUES (50, ${OWNER}), (51, ${OWNER})`);
    await report(1);
    await report(2, `reason = 'CSAM', status = 'Unactioned'`);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1), (51, 2)`);

    const { rows } = await sql<{
      id: number;
    }>`SELECT id FROM "Post" WHERE ${childSafetyPostCase()}`.execute(db);

    expect(rows).toEqual([{ id: 50 }]);
  });
});

const pending = async () =>
  (
    await pg.query<{ entityId: number; entityType: string; data: unknown }>(
      // What the hide recorded is read on its own (`recorded`).
      `SELECT "entityId", "entityType"::text AS "entityType", data - 'prior' AS data FROM "JobQueue"
       WHERE type = 'PendingDelete' ORDER BY "entityType", "entityId"`
    )
  ).rows;
const owner = { id: OWNER, isModerator: false };
const ownDelete = async (ids: number[]) =>
  (await deleteImageRows(db, { ids, actor: owner })).deleted;

describe('deleteImageRows keeps a row in a child-safety case', () => {
  it('deletes what nothing blocks and queues the rest, in one statement', async () => {
    await addImage({ needsReview: 'csam' });

    const deleted = await ownDelete([PLAIN, IMAGE]);

    expect(deleted.map((row) => row.id)).toEqual([PLAIN]);
    expect(await pending()).toEqual([
      { entityId: IMAGE, entityType: 'Image', data: { ownerId: OWNER } },
    ]);
  });

  // What a moderator's CSAM hold on a service review leaves: its images flagged for CSAM review, and
  // the report ruled on. The flag, not the report, holds the buyer's delete.
  it('defers the delete of a review image a CSAM hold flagged, after the report is ruled on', async () => {
    const UNFLAGGED = 3;
    await addImage({ needsReview: 'csam' });
    await addImage({ id: UNFLAGGED });
    await report(1, `reason = 'CSAM', status = 'Actioned'`);
    await pg.exec(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId")
        VALUES (9, ${IMAGE}), (9, ${UNFLAGGED});
      INSERT INTO "ServiceDealReviewReport" ("reportId", "serviceDealReviewId") VALUES (1, 9)`);

    const deleted = await ownDelete([IMAGE, UNFLAGGED]);

    expect(deleted.map((row) => row.id)).toEqual([UNFLAGGED]);
    expect(await pending()).toEqual([
      { entityId: IMAGE, entityType: 'Image', data: { ownerId: OWNER } },
    ]);
  });

  it("neither deletes nor queues someone else's image", async () => {
    await addImage({ needsReview: 'csam', userId: SOMEONE_ELSE });

    expect(await ownDelete([IMAGE])).toEqual([]);

    expect(await pending()).toEqual([]);
  });

  it.each([
    [
      'a system delete, with what replaying it needs',
      { system: 'remove-deleted-user-images' },
      { moderatorDelete: true as const, keepStoredFiles: true as const },
      { deletedBy: 'remove-deleted-user-images', moderatorDelete: true, keepStoredFiles: true },
    ],
    [
      "a moderator's delete of someone else's",
      { id: SOMEONE_ELSE, isModerator: true },
      { moderatorDelete: true as const },
      { deletedBy: `moderator:${SOMEONE_ELSE}`, moderatorDelete: true },
    ],
    ["a moderator's delete of their own", { id: OWNER, isModerator: true }, {}, { ownerId: OWNER }],
  ])('queues %s', async (_, actor, replay, data) => {
    await addImage({ needsReview: 'csam' });

    const { deleted } = await deleteImageRows(db, {
      ids: [PLAIN, IMAGE],
      actor,
      replay,
      where: sql<boolean>`true`,
    });

    expect(deleted.map((row) => row.id)).toEqual([PLAIN]);
    expect(await pending()).toEqual([{ entityId: IMAGE, entityType: 'Image', data }]);
  });

  it("leaves a row the job's own delete already queued as it is, and queues one it reaches anew", async () => {
    await addImage({ needsReview: 'csam' });
    await ownDelete([IMAGE]);
    await pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${PLAIN}`);

    expect(
      (await deleteImageRows(db, { ids: [PLAIN, IMAGE], actor: PENDING_DELETES_ACTOR })).deleted
    ).toEqual([]);

    expect(await pending()).toEqual([
      { entityId: PLAIN, entityType: 'Image', data: { deletedBy: 'pending-deletes' } },
      { entityId: IMAGE, entityType: 'Image', data: { ownerId: OWNER } },
    ]);
  });

  it('reports each listed id: deleted, kept for its case, or gone', async () => {
    await addImage({ blockedFor: 'CSAM' });
    await pg.exec(`INSERT INTO "Image" (id, "userId", "needsReview") VALUES (3, ${OWNER}, 'csam')`);

    const { deleted, kept, gone } = await deleteImageRows(db, {
      ids: [PLAIN, IMAGE, 3, 404],
      actor: owner,
    });

    expect(deleted.map((row) => row.id)).toEqual([PLAIN]);
    expect(kept).toEqual([IMAGE, 3]);
    expect(gone).toEqual([404]);
  });

  it("blocks what a moderator's delete keeps, their own images included", async () => {
    const OWN = 3;
    const CSAM_BLOCKED = 4;
    await addImage({
      needsReview: 'csam',
      postId: 50,
      metadata: JSON.stringify({
        accountDeletionPriorIngestion: 'Scanned',
        accountDeletionPriorBlockedFor: null,
        accountDeletionPriorNeedsReview: 'csam',
        ruleId: 3,
        ruleReason: 'r',
        width: 1,
      }),
    });
    await pg.exec(`INSERT INTO "Image" (id, "userId", "needsReview") VALUES
      (${OWN}, ${SOMEONE_ELSE}, 'csam');
      INSERT INTO "Image" (id, "userId", "blockedFor", ingestion) VALUES
      (${CSAM_BLOCKED}, ${OWNER}, 'CSAM', 'Blocked')`);

    const { deleted, kept, hidden } = await deleteImageRows(db, {
      ids: [PLAIN, IMAGE, OWN, CSAM_BLOCKED],
      actor: { id: SOMEONE_ELSE, isModerator: true },
      replay: { moderatorDelete: true },
    });

    expect(deleted.map((row) => row.id)).toEqual([PLAIN]);
    expect(kept).toEqual([IMAGE, OWN, CSAM_BLOCKED]);
    expect(hidden).toEqual([
      { id: IMAGE, userId: OWNER, postId: 50 },
      { id: OWN, userId: SOMEONE_ELSE, postId: null },
      { id: CSAM_BLOCKED, userId: OWNER, postId: null },
    ]);
    const { rows } = await pg.query(
      `SELECT id, ingestion, "nsfwLevel", "blockedFor", metadata FROM "Image"
       ORDER BY id`
    );
    expect(rows).toEqual([
      // The account-deletion grace marker goes, so an account restore cannot lift the block.
      {
        id: IMAGE,
        ingestion: 'Blocked',
        nsfwLevel: 32,
        blockedFor: 'moderated',
        metadata: { width: 1, keptHide: expect.any(String) },
      },
      {
        id: OWN,
        ingestion: 'Blocked',
        nsfwLevel: 32,
        blockedFor: 'moderated',
        metadata: { keptHide: expect.any(String) },
      },
      {
        id: CSAM_BLOCKED,
        ingestion: 'Blocked',
        nsfwLevel: 32,
        blockedFor: 'CSAM',
        metadata: { keptHide: expect.any(String) },
      },
    ]);
    // The CSAM review flag stays, so the image stays in the CSAM queue.
    const flag = await pg.query(`SELECT "needsReview" FROM "Image" WHERE id = ${IMAGE}`);
    expect(flag.rows).toEqual([{ needsReview: 'csam' }]);
  });

  it('blocks what a system delete made for a moderator keeps, out of every review queue', async () => {
    await addImage({ needsReview: 'minor' });
    await report(70);
    await pg.exec(`INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${IMAGE}, 70)`);

    const { hidden } = await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'mod-delete-user-images' },
      replay: { moderatorDelete: true },
    });

    expect(hidden).toEqual([{ id: IMAGE, userId: OWNER, postId: null }]);
    const { rows } = await pg.query(`SELECT "needsReview" FROM "Image" WHERE id = ${IMAGE}`);
    expect(rows).toEqual([{ needsReview: null }]);
  });

  it('keeps the appeal flag of a hidden image whose appeal is still pending', async () => {
    await addImage({ needsReview: 'minor' });
    await report(70);
    await pg.exec(`INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${IMAGE}, 70);
      INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Image', ${IMAGE}, 'Pending')`);

    await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'mod-delete-user-images' },
      replay: { moderatorDelete: true },
    });

    const { rows } = await pg.query(`SELECT "needsReview" FROM "Image" WHERE id = ${IMAGE}`);
    expect(rows).toEqual([{ needsReview: 'appeal' }]);
  });

  it('gives a CSAM-blocked image no appeal flag, so it stays out of the appeals queue', async () => {
    await addImage({ blockedFor: 'CSAM', ingestion: 'Blocked' });
    await pg.exec(
      `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Image', ${IMAGE}, 'Pending')`
    );

    const { hidden } = await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'mod-delete-user-images' },
      replay: { moderatorDelete: true },
    });

    expect(hidden).toEqual([{ id: IMAGE, userId: OWNER, postId: null }]);
    const { rows } = await pg.query(`SELECT "needsReview" FROM "Image" WHERE id = ${IMAGE}`);
    expect(rows).toEqual([{ needsReview: null }]);
  });

  it('blocks nothing for a moderator purge that does not queue what it keeps', async () => {
    await addImage({ needsReview: 'csam', blockedFor: 'tos', ingestion: 'Blocked' });

    const { kept, hidden } = await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'image-ingestion' },
      replay: { moderatorDelete: true },
      queueKept: false,
    });

    expect(kept).toEqual([IMAGE]);
    expect(hidden).toEqual([]);
    const { rows } = await pg.query(`SELECT "blockedFor" FROM "Image" WHERE id = ${IMAGE}`);
    expect(rows).toEqual([{ blockedFor: 'tos' }]);
  });

  it.each<[string, { id: number; isModerator?: boolean } | { system: string }, object]>([
    ['a system delete', { system: 'remove-deleted-user-images' }, {}],
    ["the owner's delete", owner, {}],
    [
      "a moderator's delete of their own image",
      { id: OWNER, isModerator: true },
      { moderatorDelete: true },
    ],
  ])('blocks what %s keeps for its case, and queues it', async (_, actor, replay) => {
    await addImage({ needsReview: 'csam', postId: 50 });

    const { kept, hidden } = await deleteImageRows(db, { ids: [IMAGE], actor, replay });

    expect(kept).toEqual([IMAGE]);
    expect(hidden).toEqual([{ id: IMAGE, userId: OWNER, postId: 50 }]);
    const { rows } = await pg.query(
      `SELECT ingestion, "nsfwLevel", "blockedFor" FROM "Image" WHERE id = ${IMAGE}`
    );
    expect(rows).toEqual([{ ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated' }]);
    expect((await pending()).map((row) => row.entityId)).toEqual([IMAGE]);
  });

  it("blocks an owner's image kept for an unsent report", async () => {
    await pg.exec(
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (${OWNER}, '{}', '[]')`
    );

    const { kept, hidden } = await deleteImageRows(db, { ids: [PLAIN], actor: owner });

    expect(kept).toEqual([PLAIN]);
    expect(hidden).toEqual([{ id: PLAIN, userId: OWNER, postId: null }]);
    const { rows } = await pg.query(`SELECT ingestion FROM "Image" WHERE id = ${PLAIN}`);
    expect(rows).toEqual([{ ingestion: 'Blocked' }]);
    expect((await pending()).map((row) => row.entityId)).toEqual([PLAIN]);
  });

  it("leaves an image already blocked as it is for any delete but a moderator's", async () => {
    const grace = {
      accountDeletionPriorIngestion: 'Scanned',
      accountDeletionPriorBlockedFor: null,
    };
    await addImage({
      needsReview: 'csam',
      ingestion: 'Blocked',
      blockedFor: 'tos',
      metadata: JSON.stringify(grace),
    });

    const { kept, hidden } = await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'remove-deleted-user-images' },
    });

    expect(kept).toEqual([IMAGE]);
    expect(hidden).toEqual([]);
    const { rows } = await pg.query(
      `SELECT "blockedFor", metadata FROM "Image" WHERE id = ${IMAGE}`
    );
    // The grace markers stay, so an account restore can still lift its grace block.
    expect(rows).toEqual([{ blockedFor: 'tos', metadata: grace }]);
    expect((await pending()).map((row) => row.entityId)).toEqual([IMAGE]);
  });

  // A caller that retries from its own queue re-checks the row there (remove-replaced-images, which
  // drops one re-adopted meanwhile), so nothing is pending to hide it for.
  it.each([
    ['leaves what a caller that does not queue keeps as it was', false, []],
    [
      'control: hides the same image for a caller that queues it',
      undefined,
      [{ id: IMAGE, userId: OWNER, postId: null }],
    ],
  ])('%s', async (_, queueKept, hiddenRows) => {
    await addImage({ needsReview: 'tag', nsfwLevel: 4 });
    await report(1);
    await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
    const columns = `SELECT ingestion, "nsfwLevel", "blockedFor", "needsReview" FROM "Image" WHERE id = ${IMAGE}`;
    const { rows: before } = await pg.query(columns);

    const { kept, hidden } = await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'remove-replaced-images' },
      queueKept,
    });

    expect(kept).toEqual([IMAGE]);
    expect(hidden).toEqual(hiddenRows);
    const { rows } = await pg.query(columns);
    expect(rows).toEqual(
      queueKept === false
        ? before
        : [{ ingestion: 'Blocked', nsfwLevel: 32, blockedFor: 'moderated', needsReview: null }]
    );
  });

  it('keeps without queueing for a caller that retries from its own queue', async () => {
    await addImage({ needsReview: 'csam' });

    const { deleted } = await deleteImageRows(db, {
      ids: [PLAIN, IMAGE],
      actor: { system: 'image-ingestion' },
      queueKept: false,
    });

    expect(deleted.map((row) => row.id)).toEqual([PLAIN]);
    expect(await pending()).toEqual([]);
  });

  it('queues a delete once, however often it is kept', async () => {
    await addImage({ needsReview: 'csam' });

    await ownDelete([IMAGE]);
    await ownDelete([IMAGE]);

    expect(await pending()).toHaveLength(1);
  });

  it("keeps the stronger kind on one image: a moderator's cleanup, the owner's delete, an owner's cleanup", async () => {
    await addImage({ needsReview: 'csam' });
    await queueImageDeletes(db, [IMAGE], { ownerId: OWNER });
    await pg.exec(`UPDATE "JobQueue" SET "createdAt" = now() - interval '1 day'`);

    await ownDelete([IMAGE]);
    expect(await pending()).toEqual([
      { entityId: IMAGE, entityType: 'Image', data: { ownerId: OWNER } },
    ]);
    // Replaced, it keeps the earlier due time.
    const { rows } = await pg.query<{ old: boolean }>(
      `SELECT "createdAt" < now() - interval '1 hour' AS old FROM "JobQueue"`
    );
    expect(rows).toEqual([{ old: true }]);

    await queueImageDeletes(db, [IMAGE], { ownerId: OWNER });
    expect((await pending())[0].data).toEqual({ ownerId: OWNER });

    // A moderator's cleanup replaces it, and keeps the owner's ask.
    await queueImageDeletes(db, [IMAGE], { ownerId: OWNER, moderatorDelete: true });
    expect((await pending())[0].data).toEqual({
      cleanup: true,
      moderatorDelete: true,
      ownerId: OWNER,
    });
  });

  it("keeps an outright ask when a moderator's delete replaces the owner's", async () => {
    await addImage({ needsReview: 'csam' });
    await ownDelete([IMAGE]);

    await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { id: SOMEONE_ELSE, isModerator: true },
      replay: { moderatorDelete: true },
    });

    expect((await pending())[0].data).toEqual({
      deletedBy: `moderator:${SOMEONE_ELSE}`,
      moderatorDelete: true,
      ownerId: OWNER,
    });
  });

  it("adds a system delete's ask to an owner's cleanup already queued", async () => {
    await addImage({ needsReview: 'csam' });
    await queueImageDeletes(db, [IMAGE], { ownerId: OWNER });

    await deleteImageRows(db, { ids: [IMAGE], actor: { system: 'remove-all-content' } });

    expect((await pending())[0].data).toEqual({ deletedBy: 'remove-all-content' });
  });

  it("adds the owner's ask to a moderator's cleanup already queued", async () => {
    await addImage({ needsReview: 'csam' });
    await queueImageDeletes(db, [IMAGE], { ownerId: OWNER, moderatorDelete: true });

    await ownDelete([IMAGE]);

    expect((await pending())[0].data).toEqual({
      cleanup: true,
      moderatorDelete: true,
      ownerId: OWNER,
    });
  });
});

describe('a delete that blocks an image no moderator decided on', () => {
  const MIGRATIONS = `${__dirname}/../../../../packages/civitai-db-schema/prisma`;
  beforeAll(async () => {
    const queueFn = readFileSync(
      `${MIGRATIONS}/programmability/nsfw_level_update_triggers.sql`,
      'utf8'
    ).split('\n---')[0];
    await pg.exec(queueFn);
    // The real trigger that queues a newly blocked image for `remove-blocked-images`.
    const migration = readFileSync(
      `${MIGRATIONS}/migrations/20260806130000_blocked_image_delete_queue_completeness/migration.sql`,
      'utf8'
    );
    const between = (from: string, to: string) => {
      const start = migration.indexOf(from);
      return migration.slice(start, migration.indexOf(to, start) + to.length);
    };
    await pg.exec(
      between('CREATE OR REPLACE FUNCTION queue_blocked_image_for_delete', '$$ LANGUAGE plpgsql;')
    );
    await pg.exec(
      between(
        'CREATE TRIGGER trg_blocked_image_delete_queue',
        'EXECUTE FUNCTION queue_blocked_image_for_delete();'
      )
    );
  });
  afterAll(() => pg.exec(`DROP TRIGGER trg_blocked_image_delete_queue ON "Image"`));

  const blockQueue = async () =>
    (
      await pg.query<{ entityId: number }>(
        `SELECT "entityId" FROM "JobQueue" WHERE type = 'BlockedImageDelete' ORDER BY "entityId"`
      )
    ).rows.map((row) => row.entityId);

  it('leaves its queued delete, not the blocked-image purge, to delete it', async () => {
    await addImage({ needsReview: 'csam' });

    const { hidden } = await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'remove-deleted-user-images' },
    });

    expect(hidden.map((row) => row.id)).toEqual([IMAGE]);
    expect(await blockQueue()).toEqual([]);
    expect((await pending()).map((row) => row.entityId)).toEqual([IMAGE]);
  });

  it("keeps the purge's queue row of a moderator's delete", async () => {
    await addImage({ needsReview: 'csam' });

    await deleteImageRows(db, {
      ids: [IMAGE],
      actor: { system: 'mod-delete-user-images' },
      replay: { moderatorDelete: true },
    });

    expect(await blockQueue()).toEqual([IMAGE]);
  });

  it('drops only the queue row of the image it hid, not that of one blocked before', async () => {
    const BLOCKED_BEFORE = 3;
    await addImage({ needsReview: 'csam' });
    await addImage({
      id: BLOCKED_BEFORE,
      needsReview: 'csam',
      ingestion: 'Blocked',
      blockedFor: 'tos',
    });
    expect(await blockQueue()).toEqual([BLOCKED_BEFORE]);

    const { hidden } = await deleteImageRows(db, {
      ids: [IMAGE, BLOCKED_BEFORE],
      actor: { system: 'remove-deleted-user-images' },
    });

    expect(hidden.map((row) => row.id)).toEqual([IMAGE]);
    expect(await blockQueue()).toEqual([BLOCKED_BEFORE]);
  });
});

describe('deletePostRows keeps a post under a child-safety report', () => {
  it("queues the owner's post under an open child-safety report and deletes the others", async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId") VALUES
      (50, ${OWNER}), (51, ${OWNER}), (52, ${SOMEONE_ELSE})`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1), (52, 1)`);

    const { deleted } = await deletePostRows(db, { ids: [50, 51, 52], actor: owner });

    expect(deleted.map((row) => row.id)).toEqual([51]);
    expect(await pending()).toEqual([
      { entityId: 50, entityType: 'Post', data: { ownerId: OWNER } },
    ]);
  });

  it("queues a system delete's post as the system's", async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId") VALUES (50, ${OWNER}), (51, ${OWNER})`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1)`);

    const { deleted } = await deletePostRows(db, {
      ids: [50, 51],
      actor: { system: 'remove-deleted-user-images' },
    });

    expect(deleted.map((row) => row.id)).toEqual([51]);
    expect(await pending()).toEqual([
      { entityId: 50, entityType: 'Post', data: { deletedBy: 'remove-deleted-user-images' } },
    ]);
  });

  it('unpublishes a published post it keeps, as a moderator unpublish does, and queues it', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
      (50, ${OWNER}, '2026-11-01'), (51, ${OWNER}, '2026-11-01')`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1)`);

    const { kept, hidden } = await deletePostRows(db, { ids: [50], actor: owner });

    expect(kept).toEqual([50]);
    expect(hidden.map(({ id, userId }) => ({ id, userId }))).toEqual([{ id: 50, userId: OWNER }]);
    const { rows } = await pg.query<{
      publishedAt: Date | null;
      metadata: Record<string, unknown>;
    }>(`SELECT "publishedAt", metadata FROM "Post" WHERE id = 50`);
    expect(rows[0].publishedAt).toBeNull();
    expect(rows[0].metadata).toMatchObject({
      unpublishedReason: 'pending-delete',
      unpublishedBy: OWNER,
      prevPublishedAt: expect.stringContaining('2026-11-01'),
    });
    // Its owner is told only that it isn't available: not that its parent was unpublished.
    expect(postUnpublishContextOf(rows[0].metadata, 7, true)).toEqual({
      wasPublished: false,
      unavailable: true,
      unpublishedAt: null,
      unpublishedBy: null,
      parentModelId: null,
    });
    // Out of what a public read lists (`p."publishedAt" <= NOW()`).
    const visible = await pg.query(
      `SELECT id FROM "Post" WHERE "publishedAt" <= now() ORDER BY id`
    );
    expect(visible.rows).toEqual([{ id: 51 }]);
    expect(await pending()).toEqual([
      { entityId: 50, entityType: 'Post', data: { ownerId: OWNER } },
    ]);
  });

  it('stamps a kept draft too, and leaves a moderator unpublish its own reason', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt", metadata) VALUES
      (50, ${OWNER}, NULL, NULL),
      (51, ${OWNER}, NULL, '{"unpublishedReason": "tos", "prevPublishedAt": "2026-01-01"}')`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1), (51, 1)`);

    await deletePostRows(db, { ids: [50, 51], actor: owner });

    const { rows } = await pg.query(
      `SELECT id, metadata->>'unpublishedReason' AS reason, metadata->>'prevPublishedAt' AS prev
       FROM "Post" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 50, reason: 'pending-delete', prev: null },
      { id: 51, reason: 'tos', prev: '2026-01-01' },
    ]);
    // The moderator's unpublish keeps telling its owner to republish the parent.
    const { rows: meta } = await pg.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "Post" WHERE id = 51`
    );
    expect(postUnpublishContextOf(meta[0].metadata, 7, false)).toMatchObject({
      wasPublished: true,
      unavailable: false,
      parentModelId: 7,
    });
  });

  // The publish path undoes an unpublish by stripping its stamp keys (`scheduledPostsGoLiveSql`), so
  // the hide must write exactly those keys.
  it('stamps exactly the keys a publish strips', async () => {
    const { scheduledPostsGoLiveSql } = await import('~/server/jobs/process-scheduled-publishing');
    const stripped = [
      ...scheduledPostsGoLiveSql([{ postId: 1, versionId: 1 }], new Date()).sql.matchAll(
        /- '(\w+)'/g
      ),
    ].map((m) => m[1]);
    await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (50, ${OWNER}, now())`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1)`);

    await deletePostRows(db, { ids: [50], actor: owner });

    const { rows } = await pg.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "Post" WHERE id = 50`
    );
    expect(Object.keys(rows[0].metadata).sort()).toEqual(stripped.sort());
  });

  it('deletes the unpublished post once its case closes', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (50, ${OWNER}, now())`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1)`);
    await deletePostRows(db, { ids: [50], actor: owner });

    await pg.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    const { deleted } = await deletePostRows(db, { ids: [50], actor: owner });

    expect(deleted.map((row) => row.id)).toEqual([50]);
  });

  describe('publishing a post its delete keeps', () => {
    beforeAll(async () => {
      await pg.exec(
        readFileSync(
          `${__dirname}/../../../../packages/civitai-db-schema/prisma/migrations/20271126120000_post_pending_delete_publish_guard/migration.sql`,
          'utf8'
        )
      );
    });
    afterAll(() => pg.exec(`DROP TRIGGER trg_post_pending_delete_keep_unpublished ON "Post"`));

    const KEPT = 50;
    const OTHER = 51;
    beforeEach(async () => {
      await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
        (${KEPT}, ${OWNER}, '2026-11-01'), (${OTHER}, ${OWNER}, NULL)`);
      await report(1);
      await pg.exec(`INSERT INTO "PostReport" VALUES (${KEPT}, 1)`);
      await deletePostRows(db, { ids: [KEPT], actor: owner });
    });
    const posts = async () =>
      (
        await pg.query<{ id: number; published: boolean; reason: string | null }>(
          `SELECT id, "publishedAt" IS NOT NULL AS published, metadata->>'unpublishedReason' AS reason
           FROM "Post" ORDER BY id`
        )
      ).rows;

    it.each([
      ["the owner's publish", `UPDATE "Post" SET "publishedAt" = now() WHERE id = ${KEPT}`],
      [
        'scheduled publishing, which strips the unpublish stamps',
        `UPDATE "Post" p SET
           "publishedAt" = CASE WHEN p.metadata->>'prevPublishedAt' IS NOT NULL
             THEN (p.metadata->>'prevPublishedAt')::timestamptz ELSE now() END,
           metadata = p.metadata - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt' - 'unpublishedReason'
         WHERE p.id = ${KEPT}`,
      ],
    ])('leaves it unpublished with its stamp after %s', async (_, publish) => {
      await pg.exec(publish);

      expect(await posts()).toEqual([
        { id: KEPT, published: false, reason: 'pending-delete' },
        { id: OTHER, published: false, reason: null },
      ]);
    });

    // What its owner is told: unavailable while the delete is queued; once it is released, a plain
    // unpublished post they can publish, not one whose parent was unpublished.
    const ownerContext = async () => {
      const { rows } = await pg.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM "Post" WHERE id = ${KEPT}`
      );
      const queued = await postsWithDeleteQueued(db, [KEPT]);
      return postUnpublishContextOf(rows[0].metadata, 7, queued.has(KEPT));
    };

    it('lets its owner publish it again once its queued delete is released, dropping the stamp', async () => {
      expect(await ownerContext()).toMatchObject({ unavailable: true, wasPublished: false });

      await settleDeletes(db, 'Post', { done: [KEPT] });
      expect(await ownerContext()).toEqual({
        wasPublished: false,
        unavailable: false,
        unpublishedAt: null,
        unpublishedBy: null,
        parentModelId: null,
      });

      await pg.exec(`UPDATE "Post" SET "publishedAt" = now() WHERE id = ${KEPT}`);

      expect(await posts()).toEqual([
        { id: KEPT, published: true, reason: null },
        { id: OTHER, published: false, reason: null },
      ]);
    });

    // Its queue re-checks it, so nothing is pending to hide it for (job-queue-clean-if-empty).
    it.each([
      ['leaves a post a caller that retries itself keeps as it was', false, true],
      ['control: unpublishes the same post for a caller that queues it', undefined, false],
    ])('%s', async (_, queueKept, published) => {
      await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (52, ${OWNER}, now());
        INSERT INTO "PostReport" VALUES (52, 1)`);
      const { kept } = await deletePostRows(db, {
        ids: [52],
        actor: { system: 'job-queue-clean-if-empty' },
        queueKept,
      });

      expect(kept).toEqual([52]);
      expect((await posts()).find((p) => p.id === 52)).toEqual({
        id: 52,
        published,
        reason: published ? null : 'pending-delete',
      });
    });

    it("refuses the owner's publish of a post a moderator unpublished, kept with its delete queued", async () => {
      await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt", metadata)
          VALUES (53, ${OWNER}, NULL, '{"unpublishedReason": "tos"}');
        INSERT INTO "PostReport" VALUES (53, 1)`);
      await deletePostRows(db, { ids: [53], actor: owner });

      await pg.exec(`UPDATE "Post" SET "publishedAt" = now() WHERE id = 53`);

      expect((await posts()).find((p) => p.id === 53)).toEqual({
        id: 53,
        published: false,
        reason: 'tos',
      });
    });

    it('still publishes the other posts of a bulk publish', async () => {
      await pg.exec(`UPDATE "Post" SET "publishedAt" = now() WHERE id IN (${KEPT}, ${OTHER})`);

      expect(await posts()).toEqual([
        { id: KEPT, published: false, reason: 'pending-delete' },
        { id: OTHER, published: true, reason: null },
      ]);
    });
  });
});

describe('releaseModeratorPendingDeletes', () => {
  it("takes a moderator's delete off a lifted image, and leaves every other ask", async () => {
    const queue = (rows: [number, object][]) =>
      pg.query(
        `INSERT INTO "JobQueue" ("entityId", "entityType", type, data)
         SELECT (r->>0)::int, 'Image', 'PendingDelete', r->1 FROM jsonb_array_elements($1::jsonb) r`,
        [JSON.stringify(rows)]
      );
    await queue([
      [1, { deletedBy: 'moderator:8', moderatorDelete: true }],
      [
        2,
        { deletedBy: 'moderator:8', moderatorDelete: true, keepStoredFiles: true, ownerId: OWNER },
      ],
      [3, { cleanup: true, moderatorDelete: true, deletedBy: 'moderator:8' }],
      [4, { deletedBy: 'remove-deleted-user-images' }],
      [5, { deletedBy: 'moderator:8', moderatorDelete: true }],
    ]);

    await releaseModeratorPendingDeletes(db, [1, 2, 3, 4]);

    expect(await pending()).toEqual([
      { entityId: 2, entityType: 'Image', data: { ownerId: OWNER } },
      {
        entityId: 3,
        entityType: 'Image',
        data: { cleanup: true, moderatorDelete: true },
      },
      { entityId: 4, entityType: 'Image', data: { deletedBy: 'remove-deleted-user-images' } },
      // Not lifted.
      {
        entityId: 5,
        entityType: 'Image',
        data: { deletedBy: 'moderator:8', moderatorDelete: true },
      },
    ]);
  });
});

describe('imagesPendingDeletion', () => {
  it('names an image with a pending delete whose case its owner can see', async () => {
    await addImage({ blockedFor: 'CSAM' });
    await ownDelete([IMAGE]);

    expect([...(await imagesPendingDeletion(db, [PLAIN, IMAGE]))]).toEqual([IMAGE]);
  });

  // Not a case the owner can see: no notice.
  it.each([
    ['under CSAM review', { needsReview: 'csam' }],
    ['blocked for CSAM while still held for review', { blockedFor: 'CSAM', needsReview: 'csam' }],
  ])('does not name one %s', async (_, over) => {
    await addImage(over);
    await ownDelete([IMAGE]);

    expect(await pending()).toHaveLength(1);
    expect(await imagesPendingDeletion(db, [IMAGE])).toEqual(new Set());
  });

  it('names it the same whatever the state of the review behind the block', async () => {
    await addImage({ blockedFor: 'CSAM' });
    await pg.exec(`INSERT INTO "CsamReport" (images, details)
      VALUES ('[{"id": ${IMAGE}}]', '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')`);
    await ownDelete([IMAGE]);
    const before = await imagesPendingDeletion(db, [IMAGE]);

    await pg.exec(`UPDATE "CsamReport" SET "reportSentAt" = now()`);

    expect(before).toEqual(new Set([IMAGE]));
    expect(await imagesPendingDeletion(db, [IMAGE])).toEqual(before);
  });

  it.each(OWNER_HIDDEN_REVIEWS)(
    'does not name one still held for a %s review, whatever the state of the review',
    async (needsReview) => {
      await addImage({ blockedFor: 'CSAM' });
      await pg.exec(`INSERT INTO "CsamReport" (images, details)
        VALUES ('[{"id": ${IMAGE}}]', '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')`);
      await ownDelete([IMAGE]);
      // After the delete, which takes the image out of every review queue but one.
      await pg.query(`UPDATE "Image" SET "needsReview" = $1 WHERE id = ${IMAGE}`, [needsReview]);
      expect(await imagesPendingDeletion(db, [IMAGE])).toEqual(new Set());

      await pg.exec(`UPDATE "CsamReport" SET "reportSentAt" = now()`);

      expect(await imagesPendingDeletion(db, [IMAGE])).toEqual(new Set());
    }
  );

  it('does not name a blocked image nothing is pending for', async () => {
    await addImage({ blockedFor: 'CSAM' });

    expect(await imagesPendingDeletion(db, [IMAGE])).toEqual(new Set());
  });
});

// Until a CSAM report is sent, the sender still reads the named account and the images it lists, so
// an owner's delete of those waits for the send. Once sent, it runs as any owner delete under a sent
// report does today.
describe('a CSAM report not yet sent', () => {
  const OTHER_IMAGE = 3;
  const unsent = (values: string) =>
    pg.exec(`INSERT INTO "CsamReport" ("userId", details, images) VALUES ${values}`);
  const sendReports = () => pg.exec(`UPDATE "CsamReport" SET "reportSentAt" = now()`);
  /** Whether the drain (`pending-deletes`) would still keep each queued image delete. */
  const drainKeeps = async () =>
    (
      await sql<{ id: number; blocked: boolean }>`
        SELECT "Image".id, ${imageDeleteBlocked(sql.ref('q.data'), sql<boolean>`false`)} AS blocked
        FROM "JobQueue" q JOIN "Image" ON "Image".id = q."entityId"
        WHERE q.type = 'PendingDelete' AND q."entityType" = 'Image' ORDER BY "Image".id
      `.execute(db)
    ).rows;

  // The named account is held whole: an unflagged image the report does not list waits too.
  it.each([
    ['naming them as its subject', `(${OWNER}, '{}', '[]')`],
    ['naming them as its secondary user', `(NULL, '{"secondaryUserId": ${OWNER}}', '[]')`],
  ])('keeps every image of an owner %s', async (_, values) => {
    await unsent(values);

    expect(await ownDelete([PLAIN])).toEqual([]);

    expect(await pending()).toEqual([
      { entityId: PLAIN, entityType: 'Image', data: { ownerId: OWNER } },
    ]);
  });

  // An owner the report does not name: only what it lists is held.
  it.each([
    ['as an object', `(${SOMEONE_ELSE}, '{}', '[{"id": ${IMAGE}}]')`],
    ['by bare id', `(NULL, '{}', '["${IMAGE}"]')`],
  ])('keeps only the listed image of an owner it does not name, listed %s', async (_, values) => {
    await addImage();
    await unsent(values);

    expect((await ownDelete([PLAIN, IMAGE])).map((row) => row.id)).toEqual([PLAIN]);

    expect(await pending()).toEqual([
      { entityId: IMAGE, entityType: 'Image', data: { ownerId: OWNER } },
    ]);
  });

  it('lets the drain run it once the report is sent', async () => {
    await unsent(`(${OWNER}, '{}', '[]')`);
    await ownDelete([PLAIN]);
    expect(await drainKeeps()).toEqual([{ id: PLAIN, blocked: true }]);

    await sendReports();

    expect(await drainKeeps()).toEqual([{ id: PLAIN, blocked: false }]);
  });

  it('deletes at once under a report already sent, as before', async () => {
    await unsent(`(${OWNER}, '{}', '[{"id": ${PLAIN}}]')`);
    await sendReports();

    expect((await ownDelete([PLAIN])).map((row) => row.id)).toEqual([PLAIN]);
    expect(await pending()).toEqual([]);
  });

  // Each must delete at once: a NULL id would make the IN-set NULL on a miss, so the row is
  // neither deleted nor queued, and a non-array `images` would throw for every owner's delete.
  it.each([
    [
      'a sent report naming them as its secondary user',
      `(NULL, '{"secondaryUserId": ${OWNER}}', '[]')`,
      true,
    ],
    [
      'an unsent report listing an entry with no id',
      `(${SOMEONE_ELSE}, '{}', '[{}, null]')`,
      false,
    ],
    [
      'an unsent report whose images is not an array',
      `(${SOMEONE_ELSE}, '{}', '{"id": ${PLAIN}}')`,
      false,
    ],
  ])('deletes an image at once under %s', async (_, values, sent) => {
    await unsent(values);
    if (sent) await sendReports();

    expect((await ownDelete([PLAIN])).map((row) => row.id)).toEqual([PLAIN]);
    expect(await pending()).toEqual([]);
  });

  it("does not keep an owner's image for a report about someone else", async () => {
    await pg.exec(`INSERT INTO "Image" (id, "userId") VALUES (${OTHER_IMAGE}, ${SOMEONE_ELSE})`);
    await unsent(`(${SOMEONE_ELSE}, '{"secondaryUserId": 9}', '[{"id": ${OTHER_IMAGE}}]')`);

    expect((await ownDelete([PLAIN])).map((row) => row.id)).toEqual([PLAIN]);
  });

  const ownPostDelete = async (ids: number[]) =>
    (await deletePostRows(db, { ids, actor: owner })).deleted;

  it('keeps every post of an owner it names, until it is sent', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId") VALUES (50, ${OWNER})`);
    await unsent(`(${OWNER}, '{}', '[]')`);

    expect(await ownPostDelete([50])).toEqual([]);
    await sendReports();
    expect((await ownPostDelete([50])).map((row) => row.id)).toEqual([50]);
  });

  it('keeps only the post holding a listed image of an owner it does not name', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId") VALUES (50, ${OWNER}), (51, ${OWNER})`);
    await addImage({ postId: 50 });
    await unsent(`(${SOMEONE_ELSE}, '{}', '[{"id": ${IMAGE}}]')`);

    expect((await ownPostDelete([50, 51])).map((row) => row.id)).toEqual([51]);
    expect(await pending()).toEqual([
      { entityId: 50, entityType: 'Post', data: { ownerId: OWNER } },
    ]);
  });
});

// The report predicates have one copy, read by every caller: a fix to how ids are parsed, or to who
// counts as named, must reach all of them. Pins the any-report and unsent variants.
describe('the shared CSAM report sets', () => {
  const unsentOnly = (report: string) => `${report}."reportSentAt" IS NULL`;
  const rows = async (text: string) =>
    (
      (await pg.query<{ id: string | null }>(text)).rows.map(
        (row) => Object.values(row)[0]
      ) as string[]
    ).sort();

  beforeEach(() =>
    pg.exec(`INSERT INTO "CsamReport" ("userId", "reportSentAt", details, images) VALUES
      (10, NULL, '{"secondaryUserId": 11}', '[{"id": 100}, "101", {}, null]'),
      (12, now(), '{"secondaryUserId": 13}', '[{"id": 102}]'),
      (NULL, NULL, '{}', '{"id": 103}')`)
  );

  it('lists the image ids of every report, or of the unsent ones only', async () => {
    expect(await rows(CSAM_REPORT_LISTED_IMAGE_IDS_SQL)).toEqual(['100', '101', '102']);
    expect(await rows(csamReportListedImageIdsSql(unsentOnly))).toEqual(['100', '101']);
  });

  it('names the subject and secondary user of the reports the filter passes', async () => {
    expect(await rows(csamReportNamedUserIdsSql(() => 'true'))).toEqual(['10', '11', '12', '13']);
    expect(await rows(csamReportNamedUserIdsSql(unsentOnly))).toEqual(['10', '11']);
  });
});

// What a kept delete's hide took, put back when its queued delete is let go (an account restore, a
// case closed with nothing found, a cleanup that no longer applies).
describe('releasePendingDeletes', () => {
  const state = `SELECT ingestion, "nsfwLevel", "blockedFor", "needsReview" FROM "Image" WHERE id = ${IMAGE}`;
  const imageState = async () => (await pg.query(state)).rows[0];
  const drain = { system: 'remove-deleted-user-images' };
  /** The image as it was, kept for an open report and hidden by `actor`'s delete. */
  const hideFor = async (
    actor: Parameters<typeof deleteImageRows>[1]['actor'] = drain,
    replay?: { moderatorDelete: true }
  ) => {
    await addImage({ ingestion: 'Pending', nsfwLevel: 4, needsReview: 'tag' });
    await report(1);
    await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
    const before = await imageState();
    const { hidden } = await deleteImageRows(db, { ids: [IMAGE], actor, replay });
    expect(hidden.map(({ id }) => id)).toEqual([IMAGE]);
    expect(await imageState()).not.toEqual(before);
    await closeCase();
    return before;
  };
  const release = () =>
    db.transaction().execute((tx) => releasePendingDeletes(tx, 'Image', [IMAGE]));
  /** Its case closed with nothing found, as when a queued delete is let go. */
  const closeCase = () => pg.exec(`UPDATE "Report" SET status = 'Unactioned'`);

  it('puts back what the hide recorded, and drops the queued delete', async () => {
    const before = await hideFor();

    const lifted = await release();

    expect(lifted.images).toEqual([{ id: IMAGE, userId: OWNER, postId: null }]);
    expect(await imageState()).toEqual(before);
    expect(await pending()).toEqual([]);
  });

  it.each([
    ['a recorded review', 'minor', null, 'minor'],
    ['the appeal flag the hide kept', 'tag', 'appeal', 'appeal'],
    ['a recorded review that outranks the kept appeal', 'minor', 'appeal', 'minor'],
    ['no appeal once the appeal was decided', 'appeal', null, null],
  ])('puts back %s', async (_, recorded, afterHide, expected) => {
    await addImage({ ingestion: 'Pending', nsfwLevel: 4, needsReview: recorded });
    await report(1);
    await pg.exec(`INSERT INTO "ImageReport" VALUES (${IMAGE}, 1)`);
    // The hide keeps the appeal flag only for a pending appeal.
    if (afterHide === 'appeal')
      await pg.exec(
        `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Image', ${IMAGE}, 'Pending')`
      );
    await deleteImageRows(db, { ids: [IMAGE], actor: drain });
    expect(await imageState()).toMatchObject({ needsReview: afterHide });
    await closeCase();

    await release();

    expect(await imageState()).toMatchObject({ ingestion: 'Pending', needsReview: expected });
  });

  it('keeps the record of the first hide when a later ask finds the image already hidden', async () => {
    const before = await hideFor();
    await pg.exec(`UPDATE "Report" SET status = 'Pending'`);
    await deleteImageRows(db, { ids: [IMAGE], actor: owner });
    await closeCase();

    await release();

    expect(await imageState()).toEqual(before);
  });

  it('leaves the image hidden once a moderator has acted on it since', async () => {
    await hideFor();
    const hidden = await imageState();
    await pg.exec(`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
      VALUES (99, 'review', 'image', ${IMAGE})`);

    const lifted = await release();

    expect(lifted.images).toEqual([]);
    expect(await imageState()).toEqual(hidden);
  });

  it('counts only moderator activity since the hide', async () => {
    const before = await hideFor();
    await pg.exec(`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
      VALUES (99, 'review', 'image', ${IMAGE}, now() - interval '1 day')`);

    await release();

    expect(await imageState()).toEqual(before);
  });

  it.each([
    ['whose case is open again', `UPDATE "Report" SET status = 'Pending'`],
    ['whose case found something', `UPDATE "Report" SET status = 'Actioned'`],
    ['of a banned owner', `INSERT INTO "User" (id, "bannedAt") VALUES (${OWNER}, now())`],
    ['of a deleted owner', `INSERT INTO "User" (id, "deletedAt") VALUES (${OWNER}, now())`],
    [
      'whose owner a moderator acted on since',
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
        VALUES (99, 'removeContent', 'user', ${OWNER})`,
    ],
    [
      'scanned again since the hide',
      `UPDATE "Image" SET "scannedAt" = now() + interval '1 second' WHERE id = ${IMAGE}`,
    ],
    [
      "a moderator's ask replaced",
      `UPDATE "JobQueue" SET data = jsonb_set(data, '{deletedBy}', '"moderator:99"')
        WHERE "entityId" = ${IMAGE}`,
    ],
    // A block written since with the hide's own columns, which logs no moderator activity: the
    // table drops the marker.
    [
      'blocked again since, by a write that names the block columns',
      `UPDATE "Image" SET ingestion = 'Blocked', "nsfwLevel" = 32, "blockedFor" = 'moderated'
        WHERE id = ${IMAGE}`,
    ],
    [
      'whose review a write named since, unchanged',
      `UPDATE "Image" SET "needsReview" = "needsReview" WHERE id = ${IMAGE}`,
    ],
    [
      'whose marker a write dropped',
      `UPDATE "Image" SET metadata = metadata - 'keptHide' WHERE id = ${IMAGE}`,
    ],
    [
      "marked by another hide's id",
      `UPDATE "Image" SET metadata = jsonb_set(metadata, '{keptHide}', '"other"') WHERE id = ${IMAGE}`,
    ],
  ])('leaves hidden an image %s', async (_, change) => {
    await hideFor();
    await pg.exec(change);
    const hidden = await imageState();

    const lifted = await release();

    expect(lifted.images).toEqual([]);
    expect(await imageState()).toEqual(hidden);
  });

  it('lifts an image a write since the hide left the block columns out of, as a post reorder', async () => {
    const before = await hideFor();
    await pg.exec(`UPDATE "Image" SET index = 3, "updatedAt" = now() + interval '1 second'
      WHERE id = ${IMAGE}`);

    const lifted = await release();

    expect(lifted.images).toEqual([{ id: IMAGE, userId: OWNER, postId: null }]);
    expect(await imageState()).toEqual(before);
    const { rows } = await pg.query<{ marker: string | null }>(
      `SELECT metadata->>'keptHide' AS marker FROM "Image" WHERE id = ${IMAGE}`
    );
    expect(rows).toEqual([{ marker: null }]);
  });

  it.each([
    ['dropped', `DROP TRIGGER trg_image_kept_hide_drop_marker ON "Image"`],
    ['disabled', `ALTER TABLE "Image" DISABLE TRIGGER trg_image_kept_hide_drop_marker`],
  ])('lifts nothing while the marker trigger is %s', async (_, change) => {
    await hideFor();
    const hidden = await imageState();
    await pg.exec(change);
    try {
      const lifted = await release();

      expect(lifted.images).toEqual([]);
      expect(await imageState()).toEqual(hidden);
    } finally {
      await pg.exec(KEPT_HIDE_TRIGGER_SQL);
      await pg.exec(`ALTER TABLE "Image" ENABLE TRIGGER trg_image_kept_hide_drop_marker`);
    }
  });

  it('never lifts a hide written while the marker trigger was missing, once it is applied', async () => {
    await pg.exec(`DROP TRIGGER trg_image_kept_hide_drop_marker ON "Image"`);
    try {
      await hideFor();
    } finally {
      await pg.exec(KEPT_HIDE_TRIGGER_SQL);
    }
    const hidden = await imageState();
    const { rows } = await pg.query<{ marker: string | null; prior: unknown }>(
      `SELECT i.metadata->>'keptHide' AS marker, q.data->'prior' AS prior
       FROM "Image" i JOIN "JobQueue" q ON q."entityId" = i.id WHERE i.id = ${IMAGE}`
    );
    expect(rows).toEqual([{ marker: null, prior: null }]);
    expect(hidden).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });

    const lifted = await release();

    expect(lifted.images).toEqual([]);
    expect(await imageState()).toEqual(hidden);
  });

  // One connection, so "committed while the release waited for its lock" is a change run right after
  // the lock statement returns, inside the release's transaction.
  it.each([
    [
      'a moderator acted on it',
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
        VALUES (99, 'review', 'image', ${IMAGE})`,
    ],
    ['its case opened again', `UPDATE "Report" SET status = 'Pending'`],
  ])('leaves hidden an image when, while the release waits for its lock, %s', async (_, change) => {
    await hideFor();
    const hidden = await imageState();
    let statements = 0;
    const afterLock = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        if (++statements === 1) await pg.exec(change);
        return result;
      },
    });

    const lifted = await afterLock
      .transaction()
      .execute((tx) => releasePendingDeletes(tx, 'Image', [IMAGE]));

    expect(statements).toBe(2);
    expect(lifted.images).toEqual([]);
    expect(await imageState()).toEqual(hidden);
  });

  it.each([
    [
      'blocked for CSAM since the hide',
      `UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${IMAGE}`,
    ],
    [
      'under CSAM review since the hide',
      `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${IMAGE}`,
    ],
    [
      'recorded under CSAM review',
      `UPDATE "JobQueue" SET data = jsonb_set(data, '{prior,needsReview}', '"csam"') WHERE "entityId" = ${IMAGE}`,
    ],
    [
      'recorded blocked for CSAM',
      `UPDATE "JobQueue" SET data = jsonb_set(data, '{prior,blockedFor}', '"CSAM"') WHERE "entityId" = ${IMAGE}`,
    ],
  ])('never lifts an image %s', async (_, change) => {
    await hideFor();
    await pg.exec(change);
    const now = await imageState();

    const lifted = await release();

    expect(lifted.images).toEqual([]);
    expect(await imageState()).toEqual(now);
  });

  it('never lifts an image kept under CSAM review when it was hidden', async () => {
    await addImage({ needsReview: 'csam', nsfwLevel: 4 });
    await deleteImageRows(db, { ids: [IMAGE], actor: drain });
    const hidden = await imageState();
    expect(hidden).toMatchObject({ ingestion: 'Blocked', needsReview: 'csam' });

    const lifted = await release();

    expect(lifted.images).toEqual([]);
    expect(await imageState()).toEqual(hidden);
  });

  it("leaves a moderator's delete to the moderator", async () => {
    await hideFor({ id: 99, isModerator: true }, { moderatorDelete: true });
    const hidden = await imageState();

    await release();

    expect(await imageState()).toEqual(hidden);
  });

  it('takes the stamp off a released post, which stays unpublished', async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (60, ${OWNER}, now());
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM'); INSERT INTO "PostReport" VALUES (60, 1)`);
    await deletePostRows(db, { ids: [60], actor: drain });
    await closeCase();

    const lifted = await db.transaction().execute((tx) => releasePendingDeletes(tx, 'Post', [60]));

    expect(lifted.postIds).toEqual([60]);
    const { rows } = await pg.query(
      `SELECT "publishedAt", metadata->>'unpublishedReason' AS reason FROM "Post" WHERE id = 60`
    );
    expect(rows).toEqual([{ publishedAt: null, reason: null }]);
  });

  it("leaves a released post's stamp once a moderator has acted on it since", async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (60, ${OWNER}, now());
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM'); INSERT INTO "PostReport" VALUES (60, 1);`);
    await deletePostRows(db, { ids: [60], actor: drain });
    await pg.exec(`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
      VALUES (99, 'unpublish', 'post', 60)`);

    const lifted = await db.transaction().execute((tx) => releasePendingDeletes(tx, 'Post', [60]));

    expect(lifted.postIds).toEqual([]);
    const { rows } = await pg.query(
      `SELECT metadata->>'unpublishedReason' AS reason FROM "Post" WHERE id = 60`
    );
    expect(rows).toEqual([{ reason: 'pending-delete' }]);
  });
});
