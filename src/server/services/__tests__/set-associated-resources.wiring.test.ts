import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wiring tests for setAssociatedResources — specifically the reciprocal ("link both ways")
// write, whose safety property lives in how its inputs are DERIVED, not in the planner that
// consumes them. planReciprocalAssociations is tested separately and thoroughly; every one of
// its callers could still be wrong without a single assertion moving, which is what this file
// closes. model.service.ts has a very large import graph, so its transitive service/search
// dependencies are stubbed below to keep this a unit test.

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

import { setAssociatedResources } from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { SessionUser } from '~/types/session';

const SOURCE = 1;
const OWNER = 100;
const MODERATOR = 900;

const owner = { id: OWNER, isModerator: false } as SessionUser;
const moderator = { id: MODERATOR, isModerator: true } as SessionUser;

/**
 * The model being edited, and what it currently points at: `[associationRowId, toModelId]`
 * pairs, matching the shape the service selects.
 */
function givenSourceModel(associations: Array<[number, number | null]> = []) {
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    userId: OWNER,
    associations: associations.map(([id, toModelId]) => ({ id, toModelId })),
  });
}

/**
 * What the writer reports for the reciprocal targets and their current lists.
 *
 * Honours the `where.id.in` the service passes. A fake that returns every row regardless of
 * the query would let a test pass while the service asked for the wrong ids — which is the
 * decision these tests exist to check.
 */
function givenTargets(targets: Array<{ id: number; userId: number }>) {
  dbMock.dbWrite.model.findMany.mockImplementation(async (args: unknown) => {
    const ids = (args as { where?: { id?: { in?: number[] } } })?.where?.id?.in;
    if (!ids) throw new Error('model.findMany called without where.id.in');
    return targets.filter((target) => ids.includes(target.id));
  });
  dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([]);
}

/** Rows the targets' own suggested-resource lists already hold. */
function givenTargetLists(rows: Array<{ fromModelId: number; toModelId: number | null }>) {
  dbMock.dbWrite.modelAssociations.findMany.mockImplementation(async (args: unknown) => {
    const ids = (args as { where?: { fromModelId?: { in?: number[] } } })?.where?.fromModelId?.in;
    if (!ids) throw new Error('modelAssociations.findMany called without where.fromModelId.in');
    return rows.filter((row) => ids.includes(row.fromModelId));
  });
}

const save = (
  associations: Array<{ resourceId: number; resourceType: 'model' | 'article'; id?: number }>,
  { reciprocal, user = owner }: { reciprocal?: boolean; user?: SessionUser } = {}
) => setAssociatedResources({ fromId: SOURCE, type: 'Suggested', associations, reciprocal }, user);

const createdRows = () =>
  (dbMock.dbWrite.modelAssociations.createMany.mock.calls[0]?.[0]?.data ?? []) as Array<{
    fromModelId: number;
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  givenSourceModel();
  givenTargets([]);
});

describe('setAssociatedResources — reciprocal wiring', () => {
  // The opt-in itself. Deleting the `reciprocal` ternary in model.service.ts makes every
  // Suggested-Resources save on the site rewrite other models' lists; before this test, that
  // mutation turned nothing red. If you are removing the flag, you are removing the opt-in.
  it('writes no back-link at all when the checkbox was not ticked', async () => {
    givenTargets([{ id: 2, userId: OWNER }]);

    await save([{ resourceId: 2, resourceType: 'model' }]);

    expect(dbMock.dbWrite.modelAssociations.createMany).not.toHaveBeenCalled();
  });

  it('writes the back-link when it was ticked', async () => {
    givenTargets([{ id: 2, userId: OWNER }]);

    await save([{ resourceId: 2, resourceType: 'model' }], { reciprocal: true });

    expect(dbMock.dbWrite.modelAssociations.createMany).toHaveBeenCalledTimes(1);
    expect(createdRows()).toEqual([
      { fromModelId: 2, toModelId: SOURCE, index: 0, type: 'Suggested', associatedById: OWNER },
    ]);
  });

  // Ownership is scoped to the OWNER of the edited model, never to whoever is clicking. A
  // moderator may edit someone else's model; the back-links belong to that creator's models,
  // not to the moderator's. Swapping `fromModel.userId` for `user?.id` at the call site is a
  // one-identifier change that this is the only assertion standing in front of.
  it('scopes ownership to the model owner, not the acting moderator', async () => {
    givenTargets([
      { id: 2, userId: OWNER },
      { id: 3, userId: MODERATOR },
    ]);

    await save(
      [
        { resourceId: 2, resourceType: 'model' },
        { resourceId: 3, resourceType: 'model' },
      ],
      { reciprocal: true, user: moderator }
    );

    expect(createdRows()).toEqual([
      { fromModelId: 2, toModelId: SOURCE, index: 0, type: 'Suggested', associatedById: MODERATOR },
    ]);
  });

  it('asks the database for each target owner', async () => {
    givenTargets([{ id: 2, userId: 555 }]);

    await save([{ resourceId: 2, resourceType: 'model' }], { reciprocal: true });

    expect(dbMock.dbWrite.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, userId: true } })
    );
    expect(dbMock.dbWrite.modelAssociations.createMany).not.toHaveBeenCalled();
  });

  // Ownership and existing-link reads must not go to a replica: a model that just changed
  // hands would report its previous owner, and a back-link committed moments earlier would be
  // invisible and written twice.
  it('reads ownership from the writer, never the replica', async () => {
    givenTargets([{ id: 2, userId: OWNER }]);

    await save([{ resourceId: 2, resourceType: 'model' }], { reciprocal: true });

    expect(dbMock.dbRead.model.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelAssociations.findMany).not.toHaveBeenCalled();
  });

  // The target's OWN list is what decides both of these, and both were previously derived
  // from a read the suite never populated — every test ran with it empty, so a mutation that
  // counted the wrong column, or inverted the already-linked check, shipped green and wrote a
  // second back-link into someone else's model on every repeat save.
  it('does not write a back-link the target already holds', async () => {
    givenTargets([{ id: 2, userId: OWNER }]);
    givenTargetLists([{ fromModelId: 2, toModelId: SOURCE }]);

    await save([{ resourceId: 2, resourceType: 'model' }], { reciprocal: true });

    expect(dbMock.dbWrite.modelAssociations.createMany).not.toHaveBeenCalled();
  });

  it('appends after the rows the target already holds', async () => {
    givenTargets([{ id: 2, userId: OWNER }]);
    givenTargetLists([
      { fromModelId: 2, toModelId: 71 },
      { fromModelId: 2, toModelId: 72 },
      { fromModelId: 2, toModelId: null },
      { fromModelId: 99, toModelId: 73 },
    ]);

    await save([{ resourceId: 2, resourceType: 'model' }], { reciprocal: true });

    expect(createdRows()).toEqual([
      { fromModelId: 2, toModelId: SOURCE, index: 3, type: 'Suggested', associatedById: OWNER },
    ]);
  });

  // Scope decided by Justin on 2026-09-11: the checkbox acts on what you just added, not on
  // the whole saved list. Our modal saves the entire list, so without this a user who ticks
  // the box while changing something unrelated retroactively back-links resources they linked
  // months ago and never touched this session. If you widen this to every association, that is
  // the behaviour you are bringing back.
  it('back-links only resources added in this edit, never ones already on the list', async () => {
    givenSourceModel([[11, 2]]);
    givenTargets([
      { id: 2, userId: OWNER },
      { id: 3, userId: OWNER },
    ]);

    await save(
      [
        { resourceId: 2, resourceType: 'model', id: 11 },
        { resourceId: 3, resourceType: 'model' },
      ],
      { reciprocal: true }
    );

    expect(createdRows().map((row) => row.fromModelId)).toEqual([3]);
  });

  // The reachable version of the same bug, and the reason the rule is derived from model ids
  // rather than from association ids. The component used to write its own id-less rows into a
  // query cache with staleTime Infinity, so on a second open every saved row presented itself
  // as new. The client is fixed, but the server must not depend on the client being right:
  // an association id is a claim, and the model ids the database holds are not.
  it('ignores a claim of newness when the model is already on the list', async () => {
    givenSourceModel([[11, 2]]);
    givenTargets([{ id: 2, userId: OWNER }]);

    await save([{ resourceId: 2, resourceType: 'model' }], { reciprocal: true });

    expect(dbMock.dbWrite.modelAssociations.createMany).not.toHaveBeenCalled();
  });

  it('ignores articles when choosing reciprocal targets', async () => {
    givenTargets([{ id: 2, userId: OWNER }]);

    await save(
      [
        { resourceId: 2, resourceType: 'model' },
        { resourceId: 7, resourceType: 'article' },
      ],
      { reciprocal: true }
    );

    expect(dbMock.dbWrite.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [2] } } })
    );
  });

  // Removal is deliberately NOT symmetric: once written, a back-link is an entry in the other
  // model's own list and is removed from there. Justin decided this on 2026-09-11 rather than
  // match MNeMiC's RelatedContentBidirectionalTest, because symmetric removal means a delete
  // that reaches into a model the request never named — the one thing this feature keeps shut.
  // If you are here to add symmetric removal, that is the tradeoff you are re-opening, and it
  // needs a marker column to tell which rows were safe to delete.
  it('deletes only from the edited model, never from a model it links to', async () => {
    givenSourceModel([
      [11, 2],
      [12, 5],
    ]);
    givenTargets([{ id: 2, userId: OWNER }]);

    await save([{ resourceId: 2, resourceType: 'model', id: 11 }], { reciprocal: true });

    expect(dbMock.dbWrite.modelAssociations.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.modelAssociations.deleteMany).toHaveBeenCalledWith({
      where: { fromModelId: SOURCE, type: 'Suggested', id: { in: [12] } },
    });
  });
});
