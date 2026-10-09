import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRatedEntityDerivedNsfwLevel as computeDerivedNsfwLevel } from '../rated-entity-derivation';
import {
  freshRatingReviewDb,
  ratingReviewKysely,
  rows,
  seedEm,
  seedEntity,
} from './rating-review-pglite.harness';

let db: PGlite;
beforeEach(async () => {
  db = await freshRatingReviewDb();
});
afterEach(async () => {
  await db.close();
});

const image = async (
  nsfwLevel: number,
  link: { postId?: number; entityType?: string; entityId?: number }
) => {
  const [i] = await rows<{ id: number }>(
    db,
    `INSERT INTO "Image" ("nsfwLevel", "postId") VALUES ($1, $2) RETURNING "id"`,
    [nsfwLevel, link.postId ?? null]
  );
  if (link.entityType)
    await db.query(
      `INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES ($1, $2, $3)`,
      [i.id, link.entityId, link.entityType]
    );
};
const derived = (t: Parameters<typeof computeDerivedNsfwLevel>[1], id: number) =>
  computeDerivedNsfwLevel(ratingReviewKysely(db), t, id);

describe('computeDerivedNsfwLevel', () => {
  it('raises a post image mask by the live text-scan floor, keeping only bits at or above it', async () => {
    const postId = await seedEntity(db, 'Post', { nsfwLevel: 9 });
    await image(1, { postId });
    await image(8, { postId });
    await seedEm(db, { entityType: 'Post', entityId: postId, nsfwLevel: 4 });
    expect(await derived('Post', postId)).toBe(8);
  });

  it('ignores a shadow row and an XGuard row', async () => {
    const postId = await seedEntity(db, 'Post', { nsfwLevel: 1 });
    await image(1, { postId });
    await seedEm(db, { entityType: 'Post:shadow', entityId: postId, nsfwLevel: 16 });
    expect(await derived('Post', postId)).toBe(1);
    await seedEm(db, {
      entityType: 'Post',
      entityId: postId,
      nsfwLevel: 16,
      result: { labels: [] },
    });
    expect(await derived('Post', postId)).toBe(1);
  });

  it('leaves the bounty nsfw flag out of the derivation', async () => {
    const bountyId = await seedEntity(db, 'Bounty', { nsfw: true, nsfwLevel: 28 });
    await image(1, { entityType: 'Bounty', entityId: bountyId });
    expect(await derived('Bounty', bountyId)).toBe(1);
  });

  it('reads a bounty entry through ImageConnection', async () => {
    const entryId = await seedEntity(db, 'BountyEntry', { nsfwLevel: 2 });
    await image(2, { entityType: 'BountyEntry', entityId: entryId });
    await seedEm(db, { entityType: 'BountyEntry', entityId: entryId, nsfwLevel: 4 });
    expect(await derived('BountyEntry', entryId)).toBe(4);
  });

  it("derives a challenge from its allowed mask's highest bit, PG without one", async () => {
    const challengeId = await seedEntity(db, 'Challenge', { nsfwLevel: 4, allowedNsfwLevel: 7 });
    expect(await derived('Challenge', challengeId)).toBe(4);
    const empty = await seedEntity(db, 'Challenge', { nsfwLevel: 1, allowedNsfwLevel: 0 });
    expect(await derived('Challenge', empty)).toBe(1);
  });

  it("derives a crucible from its mask's highest bit and a collection from its bucket", async () => {
    const crucibleId = await seedEntity(db, 'Crucible', { nsfwLevel: 1 | 4 });
    expect(await derived('Crucible', crucibleId)).toBe(4);
    const emptyCrucible = await seedEntity(db, 'Crucible', { nsfwLevel: 0 });
    expect(await derived('Crucible', emptyCrucible)).toBe(1);
    const nsfwCollection = await seedEntity(db, 'Collection', { nsfwLevel: 29 });
    expect(await derived('Collection', nsfwCollection)).toBe(4);
    const sfwCollection = await seedEntity(db, 'Collection', { nsfwLevel: 1 });
    expect(await derived('Collection', sfwCollection)).toBe(1);
    expect(await derived('Collection', 404)).toBeNull();
  });

  it("uses the article moderation floor: flat R for XGuard, the verdict's level for text-scan", async () => {
    const xguard = await seedEntity(db, 'Article', { nsfwLevel: 4 });
    await seedEm(db, {
      entityType: 'Article',
      entityId: xguard,
      triggeredLabels: ['nsfw'],
      nsfwLevel: null,
      result: { labels: [] },
    });
    expect(await derived('Article', xguard)).toBe(4);
    const textScan = await seedEntity(db, 'Article', { nsfwLevel: 8 });
    await seedEm(db, { entityType: 'Article', entityId: textScan, nsfwLevel: 8 });
    expect(await derived('Article', textScan)).toBe(8);
  });

  it('is null for a missing article, as the main app returns', async () => {
    expect(await derived('Article', 404)).toBeNull();
  });
});
