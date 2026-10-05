import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus, ModelUploadType } from '~/shared/utils/prisma/enums';

/**
 * `getDraftModelsByUserId` backs the models Drafts tab. It was a model-status-only
 * query: a Published model stays Published when a new version is scheduled
 * (version status Scheduled, publishedAt in the future) or drafted, so that pending
 * version never appeared in Drafts — the one place creators go to manage pending
 * work (189 Scheduled versions under Published models were invisible to their
 * owners). The fix adds a version-level OR branch so a non-Deleted model with a
 * Scheduled/Draft child version surfaces regardless of the parent model's status.
 *
 * Same import-the-real-model.service scaffold as
 * `restore-model-updated-at.service.test.ts`; only load-time I/O surfaces are
 * stubbed and `~/server/db/client` uses the canonical `dbMock`.
 */

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: vi.fn() },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: vi.fn(),
  deleteFilesForModelVersionCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn().mockResolvedValue({}),
  queueImageSearchIndexUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  bustPaidAccessCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn(), refresh: vi.fn() },
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {},
  Tracker: class {
    modelEvent = vi.fn();
  },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import { getDraftModelsByUserId } from '~/server/services/model.service';

const findMany = dbMock.dbRead.model.findMany;
const count = dbMock.dbRead.model.count;

const USER_ID = 170862;

type WhereBranch = {
  status?: unknown;
  uploadType?: unknown;
  modelVersions?: { some?: { status?: { in?: unknown } } };
};

/** The `where` object the list read was issued with. */
function listWhere() {
  expect(findMany, 'expected exactly one model.findMany').toHaveBeenCalledTimes(1);
  return findMany.mock.calls[0][0].where;
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe('getDraftModelsByUserId', () => {
  it('scopes the query to the requesting user', async () => {
    await getDraftModelsByUserId({ userId: USER_ID, select: { id: true }, page: 1, limit: 10 });
    expect(listWhere().userId).toBe(USER_ID);
  });

  it('surfaces non-Deleted models with a Scheduled or Draft child version (the fix)', async () => {
    await getDraftModelsByUserId({ userId: USER_ID, select: { id: true }, page: 1, limit: 10 });

    const or = listWhere().OR as WhereBranch[];
    const versionBranch = or.find((branch) => 'modelVersions' in branch);
    expect(
      versionBranch,
      'the drafts query must include a version-level branch so a scheduled/drafted version on a Published model appears'
    ).toBeDefined();
    expect(versionBranch?.modelVersions?.some?.status?.in).toEqual([
      ModelStatus.Scheduled,
      ModelStatus.Draft,
    ]);
    // A Published model must not be excluded by this branch — that is the whole
    // point — but a Deleted one must never resurface.
    expect(versionBranch?.status).toEqual({ not: ModelStatus.Deleted });
  });

  it('keeps the original model-status branches (fix is additive)', async () => {
    await getDraftModelsByUserId({ userId: USER_ID, select: { id: true }, page: 1, limit: 10 });

    const or = listWhere().OR as WhereBranch[];
    expect(or).toEqual(
      expect.arrayContaining([
        {
          status: { notIn: [ModelStatus.Published, ModelStatus.Deleted] },
          uploadType: ModelUploadType.Created,
        },
        {
          uploadType: ModelUploadType.Trained,
          status: { in: [ModelStatus.Unpublished, ModelStatus.UnpublishedViolation] },
        },
      ])
    );
  });

  it('counts against the same where clause it lists with', async () => {
    await getDraftModelsByUserId({ userId: USER_ID, select: { id: true }, page: 1, limit: 10 });
    expect(count.mock.calls[0][0].where).toEqual(listWhere());
  });
});
