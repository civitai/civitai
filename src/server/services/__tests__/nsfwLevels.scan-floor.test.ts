import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  articleModerationFloorText,
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
  updatePostNsfwLevels,
} = await import('~/server/services/nsfwLevels.service');
const { computeArticleDerivedNsfwLevel } = await import(
  '~/server/services/article-rating-review.helpers'
);
const { computeRatedEntityDerivedNsfwLevel } = await import(
  '~/server/services/text-scan/derived-level'
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
});
