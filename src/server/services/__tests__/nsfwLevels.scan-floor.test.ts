import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  articleModerationFloorText,
  collectionTextFloorBucketText,
  ratedEntityContentNsfwLevelText,
  ratedEntityDerivedNsfwLevelText,
} from '@civitai/shared/rated-entity-sql';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Hand-listed, as in challenge-moderation-adapter.test.ts: article-rating-review.helpers imports it.
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

const {
  updateArticleNsfwLevels,
  updateBountyEntryNsfwLevels,
  updateBountyNsfwLevels,
  updateCollectionsNsfwLevels,
  updatePostNsfwLevels,
} = await import('~/server/services/nsfwLevels.service');
const { computeArticleDerivedNsfwLevel } = await import(
  '~/server/services/article-rating-review.helpers'
);
const { computeRatedEntityDerivedNsfwLevel } = await import(
  '~/server/services/text-scan/derived-level'
);
const { VISIBLE_COLLECTION_WHERE, isVisibleCollection } = await import(
  '~/server/services/text-scan/collection-visibility'
);

const squash = (sql: string) => sql.replace(/\s+/g, ' ');
const sentText = (client: 'dbRead' | 'dbWrite' = 'dbWrite') =>
  squash((dbMock[client].$queryRaw.mock.calls[0][0] as Prisma.Sql).text);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
});

describe.each([
  ['Post', updatePostNsfwLevels, 'p', 'EXISTS (SELECT 1 FROM "Image" i WHERE i."postId" = p.id)'],
  [
    'BountyEntry',
    updateBountyEntryNsfwLevels,
    'be',
    `EXISTS (SELECT 1 FROM "ImageConnection" ic WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" = be.id)`,
  ],
  [
    'Bounty',
    updateBountyNsfwLevels,
    'b',
    `EXISTS (SELECT 1 FROM "ImageConnection" ic WHERE ic."entityType" = 'Bounty' AND ic."entityId" = b.id)`,
  ],
] as const)('%s recompute', (entityType, fn, alias, imageGuard) => {
  it('is the moderator override, else the shared derived level', async () => {
    await fn([1, 2]);
    expect(sentText()).toContain(
      `COALESCE(${alias}."moderatorNsfwLevel", ${squash(
        ratedEntityDerivedNsfwLevelText(entityType, alias)
      )})`
    );
  });

  it('touches only entities that have images, as the old inner join did', async () => {
    await fn([1, 2]);
    expect(sentText()).toContain(imageGuard);
  });

  it('writes only when the final value differs', async () => {
    await fn([1, 2]);
    expect(sentText()).toContain(`next."nsfwLevel" != ${alias}."nsfwLevel"`);
  });

  it('binds the ids as parameters', async () => {
    await fn([1, 2]);
    expect(sentText()).toMatch(/IN \(\$1,\$2\)/);
  });
});

describe('Article floor', () => {
  const floor = squash(articleModerationFloorText('a.id'));

  it('uses the shared floor in the recompute', async () => {
    await updateArticleNsfwLevels([1]);
    expect(sentText()).toContain(floor);
  });

  it('uses the same floor in the auto-approve derivation', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ derived: 4 }]);
    await computeArticleDerivedNsfwLevel(1);
    expect(sentText('dbRead')).toContain(floor);
  });
});

describe('Collection text floor', () => {
  const floor = squash(collectionTextFloorBucketText('c', 28));
  const sent = async () => {
    await updateCollectionsNsfwLevels([1]);
    const text = sentText();
    const forced = text.indexOf(`WHEN (c.metadata->>'forcedBrowsingLevel') IS NOT NULL`);
    // The outer ELSE; the forced branch has its own inner `ELSE 0 END`s.
    const unforced = text.indexOf('ELSE ( (CASE WHEN EXISTS (', forced);
    const end = text.indexOf('END ) AS "nsfwLevel"', unforced);
    expect(forced).toBeGreaterThan(-1);
    expect(unforced).toBeGreaterThan(forced);
    expect(end).toBeGreaterThan(unforced);
    return {
      forcedBranch: text.slice(forced, unforced),
      unforcedBranch: text.slice(unforced, end),
      text,
    };
  };

  it('rates exactly the collections VISIBLE_COLLECTION_WHERE and isVisibleCollection call visible', async () => {
    const { text } = await sent();
    expect(text).toContain(`c."availability" = 'Public'`);
    expect(text).toContain(`c."read" IN ('Public', 'Unlisted')`);
    expect(VISIBLE_COLLECTION_WHERE).toEqual({
      availability: 'Public',
      read: { in: ['Public', 'Unlisted'] },
    });
    expect(isVisibleCollection({ availability: 'Public', read: 'Unlisted' })).toBe(true);
    expect(isVisibleCollection({ availability: 'Public', read: 'Private' })).toBe(false);
    expect(isVisibleCollection({ availability: 'Private', read: 'Public' })).toBe(false);
  });

  it('collection: text floor joins the item probes, never the forced branch', async () => {
    const { forcedBranch, unforcedBranch, text } = await sent();
    expect(forcedBranch).not.toContain('moderatorNsfwLevel');
    expect(forcedBranch).not.toContain('EntityModeration');
    expect(unforcedBranch).toContain(floor);
    expect(text.split('moderatorNsfwLevel')).toHaveLength(2);
  });

  it('is its own OR operand, so a PG override clears only the floor, not an NSFW item', async () => {
    const { unforcedBranch } = await sent();
    expect(floor).not.toContain('CollectionItem');
    expect(unforcedBranch).toContain(`END) | ${floor} )`);
    expect(unforcedBranch.split('"CollectionItem" ci')).toHaveLength(3);
  });
});

describe('computeRatedEntityDerivedNsfwLevel', () => {
  it('renders the content derivation for one row on the primary', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ derived: 8 }]);
    expect(await computeRatedEntityDerivedNsfwLevel('Post', 7)).toBe(8);
    const text = sentText();
    expect(text).toContain(squash(ratedEntityContentNsfwLevelText('Post', 'e')));
    expect(text).toContain('FROM "Post" e WHERE e.id = $1');
  });

  it("leaves a bounty's nsfw flag out of the basis", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ derived: 1 }]);
    await computeRatedEntityDerivedNsfwLevel('Bounty', 7);
    expect(sentText()).not.toContain('nsfw = TRUE');
  });

  it('is null for a missing row', async () => {
    expect(await computeRatedEntityDerivedNsfwLevel('Bounty', 7)).toBeNull();
  });

  it('derives a challenge from its allowed mask', async () => {
    dbMock.dbWrite.challenge.findUnique.mockResolvedValue({ allowedNsfwLevel: 7 });
    expect(await computeRatedEntityDerivedNsfwLevel('Challenge', 3)).toBe(4);
    dbMock.dbWrite.challenge.findUnique.mockResolvedValue(null);
    expect(await computeRatedEntityDerivedNsfwLevel('Challenge', 3)).toBeNull();
  });

  it('derives a crucible from the highest bit of its mask', async () => {
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue({ nsfwLevel: 1 | 8 });
    expect(await computeRatedEntityDerivedNsfwLevel('Crucible', 3)).toBe(8);
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue({ nsfwLevel: 0 });
    expect(await computeRatedEntityDerivedNsfwLevel('Crucible', 3)).toBe(1);
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue(null);
    expect(await computeRatedEntityDerivedNsfwLevel('Crucible', 3)).toBeNull();
  });

  it('derives a collection from its bucket as PG or R', async () => {
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({ nsfwLevel: 28 });
    expect(await computeRatedEntityDerivedNsfwLevel('Collection', 3)).toBe(4);
    dbMock.dbWrite.collection.findUnique.mockResolvedValue({ nsfwLevel: 1 });
    expect(await computeRatedEntityDerivedNsfwLevel('Collection', 3)).toBe(1);
    dbMock.dbWrite.collection.findUnique.mockResolvedValue(null);
    expect(await computeRatedEntityDerivedNsfwLevel('Collection', 3)).toBeNull();
  });
});
