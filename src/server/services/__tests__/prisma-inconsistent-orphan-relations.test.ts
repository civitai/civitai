import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Regression tests for the "Inconsistent query result" 500s on
 * `model.getRecentlyManuallyAdded` and `article.getById`.
 *
 * Root cause (both): a Prisma `select` materialised a *required* to-one
 * relation on a row whose related record had been hard-deleted (orphaned FK).
 * Prisma cannot return `null` for a required relation, so it throws
 * "Inconsistent query result: Field <X> is required to return data, got null"
 * at query-execution time → HTTP 500. Measured in prod: ~1.2M orphaned
 * `ImageResourceNew.modelVersion` rows and 40 orphaned `TagsOnArticle.tag`
 * rows.
 *
 * Fix (both): add a relation-existence filter (`{ is: {} }`) so the DB drops
 * the orphan rows server-side and the query degrades gracefully (returns the
 * resolvable rows / empty) instead of erroring.
 */

// model.service.ts has a very large import graph and only one thin handler on it
// is exercised here, so its transitive service/db/search dependencies are stubbed.
// Mirrors the scaffold in set-model-minor.service.test.ts.
const findManyMock = dbMock.dbRead.imageResourceNew.findMany;

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: {},
  modelTagCache: { refresh: vi.fn() },
  modelVotableTagsCache: { bust: vi.fn() },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: vi.fn(),
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/collection.service', () => ({
  getAvailableCollectionItemsFilterForUser: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  saveItemInCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getUnavailableResources: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: {},
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/subscriptions.service', () => ({ getHighestTierSubscription: vi.fn() }));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustFetchThroughCache: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));

import { getBountyDetailsSelect } from '~/server/selectors/bounty.selector';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { postSelect } from '~/server/selectors/post.selector';
import { getRecentlyManuallyAdded } from '~/server/services/model.service';

// --- model.getRecentlyManuallyAdded ----------------------------------------

describe('getRecentlyManuallyAdded — orphaned ImageResourceNew.modelVersion', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('passes a relation-existence filter so orphaned modelVersion rows are excluded at the DB', async () => {
    findManyMock.mockResolvedValue([{ modelVersion: { modelId: 11 } }]);

    await getRecentlyManuallyAdded({ take: 10, userId: 42 });

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0][0];
    // The load-bearing fix: a required-relation existence filter. Without it,
    // a row whose modelVersionId points at a deleted ModelVersion makes Prisma
    // throw and the whole query 500s.
    expect(args.where.modelVersion).toEqual({ is: {} });
  });

  it('returns the surviving modelIds (no throw) when the DB filters out the orphan rows', async () => {
    // Simulate the post-fix DB behaviour: the orphaned row (whose modelVersion
    // would be null) is excluded by the `{ is: {} }` filter, so findMany only
    // ever yields rows with a real modelVersion. The handler returns those.
    findManyMock.mockResolvedValue([
      { modelVersion: { modelId: 7 } },
      { modelVersion: { modelId: 7 } }, // dup → uniq
      { modelVersion: { modelId: 9 } },
    ]);

    const result = await getRecentlyManuallyAdded({ take: 10, userId: 42 });
    expect(result).toEqual([7, 9]);
  });

  it('returns [] when the user has only orphaned resources (all filtered out)', async () => {
    // With the fix, an all-orphan result set comes back empty from the DB
    // instead of throwing "Inconsistent query result".
    findManyMock.mockResolvedValue([]);

    const result = await getRecentlyManuallyAdded({ take: 10, userId: 42 });
    expect(result).toEqual([]);
  });
});

// --- article.getById (shared articleDetailSelect) --------------------------
// The article 500 comes from the `tags.tag` required relation in the shared
// `articleDetailSelect`, reused by getArticleById, the search indexer, and the
// outbound webhook. The fix lives in the selector, so
// we assert the selector shape directly.

describe('articleDetailSelect — orphaned TagsOnArticle.tag', () => {
  it('filters the tags relation on tag existence so orphaned join rows are excluded', () => {
    // tags must carry a where-clause requiring the related Tag to exist; a
    // bare `{ select: { tag: ... } }` (no where) re-introduces the 500 because
    // TagsOnArticle.tag is a required relation with orphaned rows in prod.
    expect(articleDetailSelect.tags).toMatchObject({
      where: { tag: { is: {} } },
      select: { tag: { select: expect.anything() } },
    });
  });
});

// --- sibling selectors with the SAME deleted-Tag orphan source --------------
// TagsOnPost.tag and TagsOnBounty.tag are the same required-relation class:
// whatever hard-deleted the Tags that orphaned TagsOnArticle also orphaned these,
// so they need the identical existence filter or they 500 the same way.

describe('postSelect — orphaned TagsOnPost.tag', () => {
  it('filters the tags relation on tag existence', () => {
    expect(postSelect.tags).toMatchObject({
      where: { tag: { is: {} } },
      select: { tag: { select: expect.anything() } },
    });
  });
});

describe('getBountyDetailsSelect — orphaned TagsOnBounty.tag', () => {
  it('filters the tags relation on tag existence', () => {
    expect(getBountyDetailsSelect.tags).toMatchObject({
      where: { tag: { is: {} } },
      select: { tag: { select: expect.anything() } },
    });
  });
});
