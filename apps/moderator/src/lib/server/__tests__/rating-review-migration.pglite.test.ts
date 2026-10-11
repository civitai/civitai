import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRatingReviewMigration,
  countRows,
  freshPreMigrationDb,
  rows,
  seedArticle,
  seedArticleReview,
  seedUser,
} from './rating-review-pglite.harness';

type Copied = {
  entityId: number;
  status: string;
  appliedLevel: number | null;
  modComment: string | null;
};

const copied = (db: PGlite) =>
  rows<Copied>(
    db,
    `SELECT "entityId", "status"::text AS status, "appliedLevel", "modComment"
     FROM "RatingReview" WHERE "entityType" = 'Article' ORDER BY "entityId", "createdAt"`
  );

let db: PGlite;
let owner: number;
let mod: number;

beforeEach(async () => {
  db = await freshPreMigrationDb();
  owner = await seedUser(db, 'owner');
  mod = await seedUser(db, 'mod');
});

afterEach(async () => {
  await db.close();
});

describe('20260928000000_rating_review', () => {
  it('copies every ArticleRatingReview once, and a re-run adds nothing', async () => {
    const a1 = await seedArticle(db, { userId: owner });
    const a2 = await seedArticle(db, { userId: owner });
    await seedArticleReview(db, {
      articleId: a1,
      userId: owner,
      status: 'Actioned',
      appliedLevel: 2,
      resolvedBy: mod,
    });
    await seedArticleReview(db, { articleId: a2, userId: owner });

    await applyRatingReviewMigration(db);
    await applyRatingReviewMigration(db);

    expect(await countRows(db, 'RatingReview')).toBe(2);
    expect(await copied(db)).toEqual([
      { entityId: a1, status: 'Actioned', appliedLevel: 2, modComment: null },
      { entityId: a2, status: 'Pending', appliedLevel: null, modComment: null },
    ]);
  });

  it('a re-run copies a dispute filed on the old table after the first run', async () => {
    const a1 = await seedArticle(db, { userId: owner });
    await applyRatingReviewMigration(db);
    await seedArticleReview(db, { articleId: a1, userId: owner });

    await applyRatingReviewMigration(db);

    expect(await copied(db)).toEqual([
      { entityId: a1, status: 'Pending', appliedLevel: null, modComment: null },
    ]);
  });

  it('a re-run carries a resolution made on the old table onto the copied Pending row', async () => {
    const a1 = await seedArticle(db, { userId: owner });
    const oldId = await seedArticleReview(db, { articleId: a1, userId: owner });
    await applyRatingReviewMigration(db);
    await db.query(
      `UPDATE "ArticleRatingReview" SET "status" = 'Unactioned', "appliedLevel" = 4, "resolvedBy" = $2,
         "resolvedAt" = '2026-09-03T00:00:00.000Z', "modComment" = 'kept' WHERE "id" = $1`,
      [oldId, mod]
    );

    await applyRatingReviewMigration(db);

    expect(await copied(db)).toEqual([
      { entityId: a1, status: 'Unactioned', appliedLevel: 4, modComment: 'kept' },
    ]);
  });

  it('never overwrites a resolution the new queue already made', async () => {
    const a1 = await seedArticle(db, { userId: owner });
    await seedArticleReview(db, { articleId: a1, userId: owner });
    await applyRatingReviewMigration(db);
    await db.query(
      `UPDATE "RatingReview" SET "status" = 'Actioned', "appliedLevel" = 2, "resolvedAt" = now()
       WHERE "entityId" = $1`,
      [a1]
    );

    await applyRatingReviewMigration(db);

    expect((await copied(db))[0]).toMatchObject({ status: 'Actioned', appliedLevel: 2 });
  });

  it('skips, reports and never fails on a Pending old row whose article already has a Pending RatingReview', async () => {
    const a1 = await seedArticle(db, { userId: owner });
    await applyRatingReviewMigration(db);
    await db.query(
      `INSERT INTO "RatingReview" ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel", "createdAt")
       VALUES ('Article', $1, $2, 4, 1, '2026-09-05T00:00:00.000Z')`,
      [a1, owner]
    );
    const oldId = await seedArticleReview(db, {
      articleId: a1,
      userId: owner,
      createdAt: '2026-09-04T00:00:00.000Z',
    });

    await expect(applyRatingReviewMigration(db)).resolves.toBeUndefined();

    expect(await countRows(db, 'RatingReview')).toBe(1);
    const skipped = await rows<{ id: number }>(
      db,
      `SELECT arr."id" FROM "ArticleRatingReview" arr WHERE NOT EXISTS (
         SELECT 1 FROM "RatingReview" rr WHERE rr."entityType" = 'Article' AND rr."entityId" = arr."articleId"
           AND rr."userId" = arr."userId" AND rr."createdAt" = arr."createdAt")`
    );
    expect(skipped.map((r) => r.id)).toEqual([oldId]);
  });

  it('copies the /articles/ratings grant to /ratings without overwriting an edited one', async () => {
    await db.query(
      `INSERT INTO "AppPageAccess" ("app", "path", "roles") VALUES ('moderator', '/articles/ratings', '{moderator:tier1}')`
    );
    await applyRatingReviewMigration(db);
    await db.query(
      `UPDATE "AppPageAccess" SET "roles" = '{moderator:tier2}' WHERE "app" = 'moderator' AND "path" = '/ratings'`
    );

    await applyRatingReviewMigration(db);

    const [grant] = await rows<{ roles: string[] }>(
      db,
      `SELECT "roles" FROM "AppPageAccess" WHERE "app" = 'moderator' AND "path" = '/ratings'`
    );
    expect(grant.roles).toEqual(['moderator:tier2']);
  });

  it('reports a dispute resolved in both queues with different outcomes', async () => {
    const a1 = await seedArticle(db, { userId: owner });
    const oldId = await seedArticleReview(db, { articleId: a1, userId: owner });
    await applyRatingReviewMigration(db);
    await db.query(
      `UPDATE "RatingReview" SET "status" = 'Actioned', "appliedLevel" = 2, "resolvedAt" = now() WHERE "entityId" = $1`,
      [a1]
    );
    await db.query(
      `UPDATE "ArticleRatingReview" SET "status" = 'Unactioned', "appliedLevel" = 8, "resolvedAt" = now() WHERE "id" = $1`,
      [oldId]
    );

    await applyRatingReviewMigration(db);

    const both = await rows<{ oldAppliedLevel: number; newAppliedLevel: number }>(
      db,
      `SELECT arr."appliedLevel" AS "oldAppliedLevel", rr."appliedLevel" AS "newAppliedLevel"
       FROM "ArticleRatingReview" arr JOIN "RatingReview" rr
         ON rr."entityType" = 'Article' AND rr."entityId" = arr."articleId"
        AND rr."userId" = arr."userId" AND rr."createdAt" = arr."createdAt"
       WHERE arr."status" <> 'Pending' AND rr."status" <> 'Pending'
         AND arr."appliedLevel" IS DISTINCT FROM rr."appliedLevel"`
    );
    expect(both).toEqual([{ oldAppliedLevel: 8, newAppliedLevel: 2 }]);
    expect((await copied(db))[0]).toMatchObject({ status: 'Actioned', appliedLevel: 2 });
  });

  it('enforces one Pending review per entity', async () => {
    await applyRatingReviewMigration(db);
    const insert = () =>
      db.query(
        `INSERT INTO "RatingReview" ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel")
         VALUES ('Post', 7, $1, 4, 1)`,
        [owner]
      );
    await insert();
    await expect(insert()).rejects.toThrow(/RatingReview_pending_per_entity/);
  });
});
