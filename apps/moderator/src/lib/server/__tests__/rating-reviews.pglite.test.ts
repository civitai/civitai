import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countRows,
  freshRatingReviewDb,
  ratingReviewKysely,
  rows,
  seedEm,
  seedEntity,
  seedUser,
} from './rating-review-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const service = await import('../rating-reviews.service');

let db: PGlite;
let owner: number;
let mod: number;

beforeEach(async () => {
  db = await freshRatingReviewDb();
  dbHandle.current = ratingReviewKysely(db);
  owner = await seedUser(db, 'owner');
  mod = await seedUser(db, 'mod');
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

async function fileReview(
  entityType: string,
  entityId: number,
  currentLevel = 4,
  suggestedLevel = 2
) {
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "RatingReview" ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel")
     VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
    [entityType, entityId, owner, currentLevel, suggestedLevel]
  );
  return r.id;
}

const review = async (id: number) =>
  (
    await rows<{
      status: string;
      appliedLevel: number | null;
      resolvedBy: number | null;
      resolvedTextHash: string | null;
    }>(
      db,
      `SELECT "status"::text AS status, "appliedLevel", "resolvedBy", "resolvedTextHash" FROM "RatingReview" WHERE "id" = $1`,
      [id]
    )
  )[0];

const updatedAtText = async (table: string, id: number) =>
  (
    await rows<{ t: string }>(db, `SELECT "updatedAt"::text AS t FROM "${table}" WHERE "id" = $1`, [
      id,
    ])
  )[0].t;

const jobs = () =>
  rows<{ entityType: string; entityId: number }>(
    db,
    `SELECT "entityType"::text AS "entityType", "entityId" FROM "JobQueue" WHERE "type" = 'UpdateNsfwLevel' ORDER BY 1, 2`
  );

const scanned = (textHash: string) => ({ version: 1, labels: {}, textHash });

describe('resolveRatingReview', () => {
  it('writes the override pair on a post, stamps the scanned text hash, queues the cascade, leaves updatedAt alone', async () => {
    const postId = await seedEntity(db, 'Post', { userId: owner, nsfwLevel: 8 });
    await db.query(`INSERT INTO "Image" ("postId", "nsfwLevel") VALUES ($1, 1), ($1, 4)`, [postId]);
    // The request hash rotates with prompts and models; only the scanned text's hash gates a re-file.
    await seedEm(db, {
      entityType: 'Post',
      entityId: postId,
      nsfwLevel: 8,
      contentHash: 'request-hash',
      result: scanned('h-post'),
    });
    const id = await fileReview('Post', postId, 8, 2);
    const before = await updatedAtText('Post', postId);

    const res = await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 2,
      moderatorId: mod,
    });

    expect(res).toMatchObject({
      status: 'Actioned',
      entityMissing: false,
      ownerUserId: owner,
      previousLevel: 8,
      modelVersionIds: [],
    });
    expect(await review(id)).toEqual({
      status: 'Actioned',
      appliedLevel: 2,
      resolvedBy: mod,
      resolvedTextHash: 'h-post',
    });
    const [post] = await rows<{
      nsfwLevel: number;
      moderatorNsfwLevel: number;
      moderatorNsfwLevelBasis: number;
    }>(
      db,
      `SELECT "nsfwLevel", "moderatorNsfwLevel", "moderatorNsfwLevelBasis" FROM "Post" WHERE "id" = $1`,
      [postId]
    );
    // basis = raise(1|4, floor 8) = 8: the content-derived level, not the level being replaced.
    expect(post).toEqual({ nsfwLevel: 2, moderatorNsfwLevel: 2, moderatorNsfwLevelBasis: 8 });
    expect(await jobs()).toEqual([{ entityType: 'Post', entityId: postId }]);
    expect(await updatedAtText('Post', postId)).toBe(before);
  });

  it('marks an override to a different level Unactioned', async () => {
    const id = await fileReview(
      'Bounty',
      await seedEntity(db, 'Bounty', { userId: owner, nsfwLevel: 4 })
    );
    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod })
    ).resolves.toMatchObject({
      status: 'Unactioned',
    });
  });

  it('lets only the first of two resolutions write', async () => {
    const postId = await seedEntity(db, 'Post', { userId: owner, nsfwLevel: 4 });
    const id = await fileReview('Post', postId);
    await service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod });

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 8, moderatorId: mod })
    ).rejects.toThrow('Review already resolved');
    const [post] = await rows<{ moderatorNsfwLevel: number }>(
      db,
      `SELECT "moderatorNsfwLevel" FROM "Post" WHERE "id" = $1`,
      [postId]
    );
    expect(post.moderatorNsfwLevel).toBe(2);
  });

  it('closes a review whose entity is gone without writing anything else', async () => {
    const id = await fileReview('Post', 999);

    const res = await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 2,
      moderatorId: mod,
    });

    expect(res).toMatchObject({ entityMissing: true, status: 'Unactioned' });
    expect(await review(id)).toEqual({
      status: 'Unactioned',
      appliedLevel: null,
      resolvedBy: mod,
      resolvedTextHash: null,
    });
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it('rolls the claim back when the entity write updates nothing', async () => {
    const postId = await seedEntity(db, 'Post', { userId: owner, nsfwLevel: 4 });
    const id = await fileReview('Post', postId);
    // Stands in for a row deleted between the existence check and the write: the UPDATE matches nothing.
    await db.exec(`
      CREATE FUNCTION skip_update() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER skip_post_update BEFORE UPDATE ON "Post" FOR EACH ROW EXECUTE FUNCTION skip_update();
    `);

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod })
    ).rejects.toThrow(/no longer exists/);
    expect((await review(id)).status).toBe('Pending');
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it('flips a model to SFW, keeps exactly one nsfw lock, and hands back its versions for the cache bust', async () => {
    const modelId = await seedEntity(db, 'Model', {
      userId: owner,
      nsfw: true,
      nsfwLevel: 28,
      lockedProperties: ['nsfw'],
    });
    await db.query(`INSERT INTO "ModelVersion" ("modelId") VALUES ($1), ($1)`, [modelId]);
    const id = await fileReview('Model', modelId, 4, 1);

    const res = await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 1,
      moderatorId: mod,
    });

    const [m] = await rows<{ nsfw: boolean; lockedProperties: string[] }>(
      db,
      `SELECT "nsfw", "lockedProperties" FROM "Model" WHERE "id" = $1`,
      [modelId]
    );
    expect(m).toEqual({ nsfw: false, lockedProperties: ['nsfw'] });
    expect(await jobs()).toEqual([{ entityType: 'Model', entityId: modelId }]);
    expect(res.modelVersionIds).toHaveLength(2);
  });

  it('refuses to mark a poi, minor or sfwOnly model NSFW and leaves the review Pending', async () => {
    for (const flag of ['poi', 'minor', 'sfwOnly'] as const) {
      const modelId = await seedEntity(db, 'Model', {
        userId: owner,
        nsfw: false,
        nsfwLevel: 1,
        [flag]: true,
      });
      const id = await fileReview('Model', modelId, 1, 1);

      await expect(
        service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod })
      ).rejects.toThrow('A model flagged as POI, minor or SFW-only cannot be marked NSFW');
      expect((await review(id)).status).toBe('Pending');
      const [m] = await rows<{ nsfw: boolean }>(db, `SELECT "nsfw" FROM "Model" WHERE "id" = $1`, [
        modelId,
      ]);
      expect(m.nsfw).toBe(false);
    }
    expect(await countRows(db, 'JobQueue')).toBe(0);

    const poiModel = await seedEntity(db, 'Model', {
      userId: owner,
      nsfw: true,
      nsfwLevel: 28,
      poi: true,
    });
    const sfw = await fileReview('Model', poiModel, 4, 1);
    await expect(
      service.resolveRatingReview({ reviewId: sfw, appliedLevel: 1, moderatorId: mod })
    ).resolves.toMatchObject({
      status: 'Actioned',
    });
  });

  it('keeps a bounty nsfw flag in step with the applied level, locks it, and snapshots a content-only basis', async () => {
    const bountyId = await seedEntity(db, 'Bounty', { userId: owner, nsfw: true, nsfwLevel: 28 });
    await db.query(`INSERT INTO "Image" ("nsfwLevel") VALUES (2)`);
    await db.query(
      `INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") SELECT max(id), $1, 'Bounty' FROM "Image"`,
      [bountyId]
    );
    const id = await fileReview('Bounty', bountyId, 16, 2);

    await service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod });

    const [b] = await rows<{
      nsfw: boolean;
      nsfwLevel: number;
      lockedProperties: string[];
      moderatorNsfwLevelBasis: number;
    }>(
      db,
      `SELECT "nsfw", "nsfwLevel", "lockedProperties", "moderatorNsfwLevelBasis" FROM "Bounty" WHERE "id" = $1`,
      [bountyId]
    );
    expect(b).toEqual({
      nsfw: false,
      nsfwLevel: 2,
      lockedProperties: ['nsfw'],
      moderatorNsfwLevelBasis: 2,
    });
  });

  it('lowers a challenge with its allowed mask and collection gate, and stamps the basis from the new mask', async () => {
    const collectionId = await seedEntity(db, 'Collection', {
      metadata: JSON.stringify({ forcedBrowsingLevel: 7 }),
    });
    const challengeId = await seedEntity(db, 'Challenge', {
      createdById: owner,
      nsfwLevel: 4,
      allowedNsfwLevel: 7,
      collectionId,
    });
    await seedEm(db, { entityType: 'Challenge', entityId: challengeId, nsfwLevel: 4 });
    const id = await fileReview('Challenge', challengeId, 4, 2);

    await service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod });

    const [c] = await rows<{
      nsfwLevel: number;
      allowedNsfwLevel: number;
      moderatorNsfwLevel: number;
      moderatorNsfwLevelBasis: number;
    }>(
      db,
      `SELECT "nsfwLevel", "allowedNsfwLevel", "moderatorNsfwLevel", "moderatorNsfwLevelBasis" FROM "Challenge" WHERE "id" = $1`,
      [challengeId]
    );
    // The basis is the narrowed mask's level, so a later read of the same mask is not a "drop".
    expect(c).toEqual({
      nsfwLevel: 2,
      allowedNsfwLevel: 3,
      moderatorNsfwLevel: 2,
      moderatorNsfwLevelBasis: 2,
    });
    const [col] = await rows<{ f: number }>(
      db,
      `SELECT ("metadata"->>'forcedBrowsingLevel')::int AS f FROM "Collection" WHERE "id" = $1`,
      [collectionId]
    );
    expect(col.f).toBe(3);
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it("refuses to raise a challenge, judged against its live level rather than the review's snapshot", async () => {
    const raise = await fileReview(
      'Challenge',
      await seedEntity(db, 'Challenge', { createdById: owner, nsfwLevel: 2, allowedNsfwLevel: 3 }),
      2,
      1
    );
    await expect(
      service.resolveRatingReview({ reviewId: raise, appliedLevel: 4, moderatorId: mod })
    ).rejects.toThrow(/cannot be applied/);
    expect((await review(raise)).status).toBe('Pending');

    // Filed at R, lowered to PG-13 since: R would now be a raise.
    const lowered = await seedEntity(db, 'Challenge', {
      createdById: owner,
      nsfwLevel: 2,
      allowedNsfwLevel: 3,
    });
    const stale = await fileReview('Challenge', lowered, 4, 1);
    await expect(
      service.resolveRatingReview({ reviewId: stale, appliedLevel: 4, moderatorId: mod })
    ).rejects.toThrow(/cannot be applied/);
    const [c] = await rows<{ nsfwLevel: number; allowedNsfwLevel: number }>(
      db,
      `SELECT "nsfwLevel", "allowedNsfwLevel" FROM "Challenge" WHERE "id" = $1`,
      [lowered]
    );
    expect(c).toEqual({ nsfwLevel: 2, allowedNsfwLevel: 3 });
    expect((await review(stale)).status).toBe('Pending');
  });

  const crucible = async (id: number) =>
    (
      await rows<{
        nsfwLevel: number;
        textNsfw: boolean;
        moderatorNsfwLevel: number | null;
        moderatorNsfwLevelBasis: number | null;
      }>(
        db,
        `SELECT "nsfwLevel", "textNsfw", "moderatorNsfwLevel", "moderatorNsfwLevelBasis" FROM "Crucible" WHERE "id" = $1`,
        [id]
      )
    )[0];

  it('resolving a Crucible dispute lowers its mask and clears textNsfw', async () => {
    const crucibleId = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4,
      textNsfw: true,
    });
    const id = await fileReview('Crucible', crucibleId, 4, 1);

    const res = await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 1,
      moderatorId: mod,
    });

    expect(res).toMatchObject({ status: 'Actioned', entityMissing: false, title: 'cr' });
    expect(await crucible(crucibleId)).toEqual({
      nsfwLevel: 1,
      textNsfw: false,
      moderatorNsfwLevel: 1,
      moderatorNsfwLevelBasis: 1,
    });
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it('keeps textNsfw on a crucible lowered to a level that is still R or above', async () => {
    const crucibleId = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4 | 8,
      textNsfw: true,
    });
    const id = await fileReview('Crucible', crucibleId, 8, 4);

    await service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod });

    expect(await crucible(crucibleId)).toEqual({
      nsfwLevel: 1 | 4,
      textNsfw: true,
      moderatorNsfwLevel: 4,
      moderatorNsfwLevelBasis: 4,
    });
  });

  it("refuses to raise a crucible, judged against its live level rather than the review's snapshot", async () => {
    // Filed at R, lowered to PG-13 since: R would now be a raise.
    const lowered = await seedEntity(db, 'Crucible', { userId: owner, nsfwLevel: 1 | 2 });
    const stale = await fileReview('Crucible', lowered, 4, 1);
    await expect(
      service.resolveRatingReview({ reviewId: stale, appliedLevel: 4, moderatorId: mod })
    ).rejects.toThrow(/cannot be applied/);
    expect(await crucible(lowered)).toEqual({
      nsfwLevel: 1 | 2,
      textNsfw: false,
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    });
    expect((await review(stale)).status).toBe('Pending');
  });

  it('refuses to change the mask of a crucible that has started, and writes nothing', async () => {
    const active = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4,
      textNsfw: true,
      status: 'Active',
    });
    // Still Pending, but its start time has passed: the activation job can lag.
    const lagging = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4,
      textNsfw: true,
      startAt: '2020-01-01T00:00:00.000Z',
    });
    for (const crucibleId of [active, lagging]) {
      const id = await fileReview('Crucible', crucibleId, 4, 1);
      await expect(
        service.resolveRatingReview({ reviewId: id, appliedLevel: 1, moderatorId: mod })
      ).rejects.toThrow("This crucible has started; its allowed levels can't change.");
      expect((await review(id)).status).toBe('Pending');
      expect(await crucible(crucibleId)).toEqual({
        nsfwLevel: 1 | 4,
        textNsfw: true,
        moderatorNsfwLevel: null,
        moderatorNsfwLevelBasis: null,
      });
    }
  });

  it('still lets a started crucible dispute be declined at its current level', async () => {
    const crucibleId = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4,
      textNsfw: true,
      status: 'Active',
    });
    const id = await fileReview('Crucible', crucibleId, 4, 1);

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod })
    ).resolves.toMatchObject({ status: 'Unactioned' });
    expect((await crucible(crucibleId)).nsfwLevel).toBe(1 | 4);
  });

  it('offers and accepts the live level of a crucible widened before it started', async () => {
    const all = 1 | 2 | 4 | 8 | 16;
    const crucibleId = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: all,
      textNsfw: true,
      status: 'Active',
    });
    // Filed while the mask still topped out at R.
    const id = await fileReview('Crucible', crucibleId, 4, 1);

    const { items } = await service.getRatingReviews({ status: 'Pending' });
    expect(items.find((i) => i.id === id)?.levelOptions).toEqual([1, 2, 4, 8, 16]);
    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 16, moderatorId: mod })
    ).resolves.toMatchObject({ status: 'Unactioned' });
    expect((await crucible(crucibleId)).nsfwLevel).toBe(all);
  });

  it('reads a crucible mask carrying the Blocked bit by its rating bits only', async () => {
    const crucibleId = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4 | 32,
      textNsfw: true,
      status: 'Active',
    });
    const id = await fileReview('Crucible', crucibleId, 4, 1);

    const { items } = await service.getRatingReviews({ status: 'Pending' });
    expect(items.find((i) => i.id === id)?.levelOptions).toEqual([1, 2, 4]);
    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 8, moderatorId: mod })
    ).rejects.toThrow(/cannot be applied/);
    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 1, moderatorId: mod })
    ).rejects.toThrow(/has started/);
    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod })
    ).resolves.toMatchObject({ status: 'Unactioned' });
    expect((await crucible(crucibleId)).nsfwLevel).toBe(1 | 4 | 32);
  });

  it('lowers the mask of a crucible scheduled to start later', async () => {
    const crucibleId = await seedEntity(db, 'Crucible', {
      userId: owner,
      nsfwLevel: 1 | 4,
      textNsfw: true,
      startAt: '2099-01-01T00:00:00.000Z',
    });
    const id = await fileReview('Crucible', crucibleId, 4, 1);

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 1, moderatorId: mod })
    ).resolves.toMatchObject({ status: 'Actioned' });
    expect((await crucible(crucibleId)).nsfwLevel).toBe(1);
  });

  it('closes a Collection review whose collection is gone without writing an override', async () => {
    const id = await fileReview('Collection', 999, 4, 1);

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 1, moderatorId: mod })
    ).resolves.toMatchObject({ entityMissing: true, status: 'Unactioned' });
    expect((await review(id)).appliedLevel).toBeNull();
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it('refuses a Collection level that is not SFW or NSFW', async () => {
    const collectionId = await seedEntity(db, 'Collection', { userId: owner, nsfwLevel: 28 });
    const id = await fileReview('Collection', collectionId, 4, 1);

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod })
    ).rejects.toThrow(/cannot be applied/);
    expect((await review(id)).status).toBe('Pending');
    const [c] = await rows<{ moderatorNsfwLevel: number | null }>(
      db,
      `SELECT "moderatorNsfwLevel" FROM "Collection" WHERE "id" = $1`,
      [collectionId]
    );
    expect(c.moderatorNsfwLevel).toBeNull();
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it('resolving a Collection dispute sets the override and queues a recompute', async () => {
    const collectionId = await seedEntity(db, 'Collection', { userId: owner, nsfwLevel: 28 });
    const id = await fileReview('Collection', collectionId, 4, 1);

    const res = await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 1,
      moderatorId: mod,
    });

    expect(res).toMatchObject({ status: 'Actioned', entityMissing: false, title: 'col' });
    const [c] = await rows<{
      nsfwLevel: number;
      moderatorNsfwLevel: number;
      moderatorNsfwLevelBasis: number;
    }>(
      db,
      `SELECT "nsfwLevel", "moderatorNsfwLevel", "moderatorNsfwLevelBasis" FROM "Collection" WHERE "id" = $1`,
      [collectionId]
    );
    // The bucket itself is the recompute job's to write.
    expect(c).toEqual({ nsfwLevel: 28, moderatorNsfwLevel: 1, moderatorNsfwLevelBasis: 1 });
    expect(await jobs()).toEqual([{ entityType: 'Collection', entityId: collectionId }]);
  });

  it('keeps the Article behaviour: userNsfwLevel lock, floor-aware basis, text hash, no JobQueue row', async () => {
    const articleId = await seedEntity(db, 'Article', {
      userId: owner,
      nsfwLevel: 8,
      userNsfwLevel: 1,
    });
    await seedEm(db, {
      entityType: 'Article',
      entityId: articleId,
      nsfwLevel: 8,
      contentHash: 'request-hash',
      result: scanned('h-art'),
    });
    const id = await fileReview('Article', articleId, 8, 2);

    await service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod });

    const [a] = await rows<{
      nsfwLevel: number;
      moderatorNsfwLevel: number;
      moderatorNsfwLevelBasis: number;
      lockedProperties: string[];
    }>(
      db,
      `SELECT "nsfwLevel", "moderatorNsfwLevel", "moderatorNsfwLevelBasis", "lockedProperties" FROM "Article" WHERE "id" = $1`,
      [articleId]
    );
    expect(a).toEqual({
      nsfwLevel: 2,
      moderatorNsfwLevel: 2,
      moderatorNsfwLevelBasis: 8,
      lockedProperties: ['userNsfwLevel'],
    });
    expect((await review(id)).resolvedTextHash).toBe('h-art');
    expect(await countRows(db, 'JobQueue')).toBe(0);
  });

  it('stamps no text hash for an XGuard-era row, even with a request hash on it', async () => {
    const articleId = await seedEntity(db, 'Article', { userId: owner, nsfwLevel: 4 });
    await seedEm(db, {
      entityType: 'Article',
      entityId: articleId,
      triggeredLabels: ['nsfw'],
      nsfwLevel: null,
      contentHash: 'request-hash',
      result: { labels: [] },
    });
    const id = await fileReview('Article', articleId, 4, 2);

    await service.resolveRatingReview({ reviewId: id, appliedLevel: 2, moderatorId: mod });

    expect((await review(id)).resolvedTextHash).toBeNull();
  });
});

describe('getRatingReviews', () => {
  it('summarises a crucible by its mask level and a collection by its SFW/NSFW bucket', async () => {
    const crucibleId = await seedEntity(db, 'Crucible', { userId: owner, nsfwLevel: 1 | 4 });
    const collectionId = await seedEntity(db, 'Collection', {
      userId: owner,
      nsfwLevel: 28,
      moderatorNsfwLevel: 4,
    });
    await fileReview('Crucible', crucibleId);
    await fileReview('Collection', collectionId);

    const { items } = await service.getRatingReviews({ status: 'Pending' });
    const byType = Object.fromEntries(items.map((i) => [i.entityType, i]));

    expect(byType.Crucible.entity).toMatchObject({
      title: 'cr',
      path: `/crucibles/${crucibleId}`,
      nsfwLevel: 1 | 4,
      override: null,
    });
    expect(byType.Collection.entity).toMatchObject({
      title: 'col',
      path: `/collections/${collectionId}`,
      nsfwLevel: 4,
      override: 4,
    });
  });

  it('joins each entity, shows only a text-scan raise, and filters by type', async () => {
    const postId = await seedEntity(db, 'Post', { userId: owner, nsfwLevel: 4, title: 'hello' });
    const entryId = await seedEntity(db, 'BountyEntry', {
      userId: owner,
      bountyId: 12,
      nsfwLevel: 4,
    });
    await seedEm(db, {
      entityType: 'Post',
      entityId: postId,
      nsfwLevel: 8,
      result: { version: 1, labels: { nsfw: { level: 'x', reason: 'fake reason' } } },
    });
    await seedEm(db, {
      entityType: 'BountyEntry',
      entityId: entryId,
      triggeredLabels: ['nsfw'],
      result: { labels: [{ label: 'nsfw' }] },
    });
    await fileReview('Post', postId);
    await fileReview('BountyEntry', entryId);
    await fileReview('Model', 404);

    const all = await service.getRatingReviews({ status: 'Pending' });
    const byType = Object.fromEntries(all.items.map((i) => [i.entityType, i]));

    expect(byType.Post.entity).toMatchObject({
      id: postId,
      title: 'hello',
      path: `/posts/${postId}`,
    });
    expect(byType.Post.scan).toEqual({ level: 8, reason: 'fake reason' });
    expect(byType.BountyEntry.entity?.path).toBe(`/bounties/12/entries/${entryId}`);
    expect(byType.BountyEntry.scan).toBeNull();
    expect(byType.Model.entity).toBeNull();

    const posts = await service.getRatingReviews({ status: 'Pending', entityType: 'Post' });
    expect(posts.items.map((i) => i.entityType)).toEqual(['Post']);
    expect(await service.getRatingReviewCounts('Post')).toEqual({
      Pending: 1,
      Actioned: 0,
      Unactioned: 0,
    });
    expect(await service.getRatingReviewCounts()).toEqual({
      Pending: 3,
      Actioned: 0,
      Unactioned: 0,
    });
  });
});
