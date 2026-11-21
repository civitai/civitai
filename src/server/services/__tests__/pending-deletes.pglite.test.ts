import { PGlite } from '@electric-sql/pglite';
import {
  deleteImageRows,
  deletePostRows,
  queueImageDeletes,
} from '@civitai/db-queries/content-deletion';
import { childSafetyImageCase, childSafetyPostCase } from '@civitai/db-queries/child-safety-case';
import { imagesPendingDeletion, PENDING_DELETES_ACTOR } from '@civitai/db-queries/pending-deletes';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
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
    "CsamReport", "CsamQueueSetAside", "ImageConnection"`);
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

  it('reports each listed id: deleted, kept for its case (and whether its owner is told), or gone', async () => {
    await addImage({ blockedFor: 'CSAM' });
    await pg.exec(`INSERT INTO "Image" (id, "userId", "needsReview") VALUES (3, ${OWNER}, 'csam')`);

    const { deleted, kept, gone } = await deleteImageRows(db, {
      ids: [PLAIN, IMAGE, 3, 404],
      actor: owner,
    });

    expect(deleted.map((row) => row.id)).toEqual([PLAIN]);
    expect(kept).toEqual([
      { id: IMAGE, ownerTold: true },
      { id: 3, ownerTold: false },
    ]);
    expect(gone).toEqual([404]);
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
