import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AuctionService from '~/server/services/auction.service';
import type * as ModelVersionService from '~/server/services/model-version.service';

/**
 * Model write paths that drop the shared model-row cache. The first group busts explicitly, because
 * those paths neither mark the model in the replication-lag helpers nor reach `bustMvCache`; the
 * second runs real writers that reach it through the lag helpers and `bustPublicModelResponseCache`.
 * Each runs the real service function, the real lag helpers and the real bust; only I/O is stubbed.
 * The assertion is on the key that reaches the cache client, so a path that stopped busting, or
 * busted another model, goes red.
 *
 * Scaffold copied from `restore-model-updated-at.service.test.ts`, hand-listed mocks included: an
 * `importOriginal` spread of these modules loads the graph the scaffold exists to keep out.
 */

const MODEL_ID = 5821;
const OWNER_USER_ID = 5934;

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
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustMvCache: vi.fn(),
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

vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AuctionService>()),
  deleteBidsForModel: vi.fn(),
}));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));

import { env } from '~/env/server';
import {
  deleteModelById,
  permaDeleteModelById,
  restoreModelById,
  toggleLockComments,
  toggleLockModel,
  updateModelById,
} from '~/server/services/model.service';
import { modelDetailPublicCacheKey } from '~/server/utils/model-detail-cache-key';

const mockDbWrite = dbMock.dbWrite;
const KEY = modelDetailPublicCacheKey(MODEL_ID);
const deletedKeys = () => redisMock.redis.del.mock.calls.flatMap(([keys]) => [keys].flat());

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.del.mockResolvedValue(1 as never);
  mockDbWrite.$queryRaw.mockResolvedValue([{ userId: OWNER_USER_ID }] as never);
  mockDbWrite.$executeRaw.mockResolvedValue(1 as never);
  mockDbWrite.model.update.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_USER_ID,
    modelVersions: [],
  } as never);
  mockDbWrite.modelFile.findMany.mockResolvedValue([] as never);
  mockDbWrite.model.findUnique.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_USER_ID,
    nsfwLevel: 1,
    modelVersions: [{ id: 5999 }],
  } as never);
  mockDbWrite.post.findMany.mockResolvedValue([] as never);
  mockDbWrite.model.delete.mockResolvedValue({ id: MODEL_ID, userId: OWNER_USER_ID } as never);
});

const modelRowKeysDeleted = () => [
  ...new Set(deletedKeys().filter((k) => String(k).includes('model-detail-public'))),
];

describe('model-row cache busts on model writes', () => {
  // The model-row bust must not sit behind the public API's environment gate, which is off here.
  it('runs with the public API response cache disabled', () => {
    expect(env.IS_DATAPACKET).toBeFalsy();
  });

  it.each([
    ['restoreModelById', () => restoreModelById({ id: MODEL_ID })],
    [
      'permaDeleteModelById',
      () => permaDeleteModelById({ id: MODEL_ID, userId: OWNER_USER_ID } as never),
    ],
    ['toggleLockModel', () => toggleLockModel({ id: MODEL_ID, locked: true })],
    ['toggleLockComments', () => toggleLockComments({ id: MODEL_ID, locked: true })],
    ['updateModelById', () => updateModelById({ id: MODEL_ID, data: { name: 'renamed' } })],
    ['deleteModelById', () => deleteModelById({ id: MODEL_ID, userId: OWNER_USER_ID } as never)],
  ])('%s drops the cached row for that model, and only that model', async (_, write) => {
    await write();
    expect(modelRowKeysDeleted()).toEqual([KEY]);
  });
});
