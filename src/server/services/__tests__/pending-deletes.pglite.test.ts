import { PGlite } from '@electric-sql/pglite';
import {
  childSafetyImageCase,
  childSafetyPostCase,
  deleteImageRows,
  deletePostRows,
  imageDeleteBlocked,
  imagesPendingDeletion,
  ownImageDeleteBlocked,
  ownPostDeleteBlocked,
  queueImageDeletes,
} from '@civitai/db-queries/content-deletion';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  csamReportListedImageIdsSql,
  csamReportNamedUserIdsSql,
} from '@civitai/shared/held-media';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

vi.setConfig({ hookTimeout: 60_000 });

const OWNER = 7;
const SOMEONE_ELSE = 8;
const PLAIN = 1;
const IMAGE = 2;

let pg: PGlite;
const db = pgliteKysely(() => pg);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM (
      'PendingDelete', 'ImageStorageDelete', 'UpdateNsfwLevel', 'CdnAccessSync'
    );
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await pg.exec(imageUseTablesSql);
  // Returned by the deletes.
  await pg.exec(`ALTER TABLE "Image" ADD COLUMN metadata jsonb`);
  await pg.exec(
    `CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 0)`
  );
});
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`TRUNCATE "JobQueue", "Image", "Post", "Report", "ImageReport", "PostReport",
    "CsamReport", "CsamQueueSetAside", "ImageConnection", "ServiceDealReviewImage",
    "ServiceDealReviewReport"`);
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
      `SELECT "entityId", "entityType"::text AS "entityType", data FROM "JobQueue"
       WHERE type = 'PendingDelete' ORDER BY "entityType", "entityId"`
    )
  ).rows;
const owner = { id: OWNER, isModerator: false };
const ownDelete = (ids: number[]) =>
  deleteImageRows(db, {
    ids,
    actor: owner,
    pending: { blocked: ownImageDeleteBlocked(OWNER), data: { ownerId: OWNER } },
  });

describe("deleteImageRows' pending option", () => {
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

describe("deletePostRows' pending option", () => {
  it("queues the owner's post under an open child-safety report and deletes the others", async () => {
    await pg.exec(`INSERT INTO "Post" (id, "userId") VALUES
      (50, ${OWNER}), (51, ${OWNER}), (52, ${SOMEONE_ELSE})`);
    await report(1);
    await pg.exec(`INSERT INTO "PostReport" VALUES (50, 1), (52, 1)`);

    const deleted = await deletePostRows(db, {
      ids: [50, 51, 52],
      actor: owner,
      pending: { blocked: ownPostDeleteBlocked(OWNER), data: { ownerId: OWNER } },
    });

    expect(deleted.map((row) => row.id)).toEqual([51]);
    expect(await pending()).toEqual([
      { entityId: 50, entityType: 'Post', data: { ownerId: OWNER } },
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

  const ownPostDelete = (ids: number[]) =>
    deletePostRows(db, {
      ids,
      actor: owner,
      pending: { blocked: ownPostDeleteBlocked(OWNER), data: { ownerId: OWNER } },
    });

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

// The delete hold and the account holds read one copy of each report predicate: a fix to how ids
// are parsed, or to who counts as named, must reach both. Pins the any-report and unsent variants.
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
