import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { CosmeticSource } from '~/shared/utils/prisma/enums';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import type * as Caches from '~/server/redis/caches';
import type * as SearchIndex from '~/server/search-index';

const { mockIsCosmeticAvailable, mockRefreshOwnedStickerCache, mockQueueUpdate } = vi.hoisted(
  () => ({
    mockIsCosmeticAvailable: vi.fn(),
    mockRefreshOwnedStickerCache: vi.fn(async () => undefined),
    mockQueueUpdate: vi.fn(async () => undefined),
  })
);

vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  isCosmeticAvailable: mockIsCosmeticAvailable,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  refreshOwnedStickerCache: mockRefreshOwnedStickerCache,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  usersSearchIndex: { queueUpdate: mockQueueUpdate },
}));
vi.mock('~/server/search-index/users.search-index', () => ({
  usersSearchIndex: { queueUpdate: mockQueueUpdate },
}));

import { userRouter } from '~/server/routers/user.router';
import { awardTrophyCosmetic } from '~/server/services/user.service';

const USER_ID = 42;
const CLAIM_ID = 100;
const TROPHY_ID = 200;

const COSMETICS: Record<number, { source: CosmeticSource }> = {
  [CLAIM_ID]: { source: CosmeticSource.Claim },
  [TROPHY_ID]: { source: CosmeticSource.Trophy },
};

// The shared Prisma mock ignores `where`, so this fake applies the `source`
// filter itself; without it the source restriction under test is invisible.
function findCosmetic({ where }: { where: { id: number; source?: unknown } }) {
  const row = COSMETICS[where.id];
  if (!row) return null;
  const { source } = where;
  if (source !== undefined) {
    const allowed =
      typeof source === 'object' && source !== null && 'in' in source
        ? (source as { in: CosmeticSource[] }).in
        : [source as CosmeticSource];
    if (!allowed.includes(row.source)) return null;
  }
  return { id: where.id, availableStart: null, availableEnd: null, source: row.source };
}

const caller = () =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user: { id: USER_ID, tier: 'free', username: 'u', muted: false, onboarding: 0xff },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { userActivity: vi.fn() },
  } as never);

const createUserCosmetic = dbMock.dbWrite.userCosmetic.create;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.cosmetic.findUnique.mockImplementation(findCosmetic as never);
  dbMock.dbRead.userCosmetic.findFirst.mockResolvedValue(null);
  createUserCosmetic.mockResolvedValue({});
  mockIsCosmeticAvailable.mockResolvedValue(true);
});

describe('user.claimCosmetic', () => {
  it('grants an available Claim-source cosmetic', async () => {
    await expect(caller().claimCosmetic({ id: CLAIM_ID })).resolves.toMatchObject({
      id: CLAIM_ID,
    });

    expect(mockIsCosmeticAvailable).toHaveBeenCalledWith(CLAIM_ID, USER_ID);
    expect(createUserCosmetic).toHaveBeenCalledWith({
      data: { userId: USER_ID, cosmeticId: CLAIM_ID },
    });
    expect(mockRefreshOwnedStickerCache).toHaveBeenCalledWith([USER_ID]);
    expect(mockQueueUpdate).toHaveBeenCalledWith([{ id: USER_ID, action: 'Update' }]);
  });

  it('refuses a cosmetic the caller already owns', async () => {
    dbMock.dbRead.userCosmetic.findFirst.mockResolvedValue({
      userId: USER_ID,
      cosmeticId: CLAIM_ID,
    });

    await expect(caller().claimCosmetic({ id: CLAIM_ID })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(createUserCosmetic).not.toHaveBeenCalled();
  });

  it('refuses a Claim-source cosmetic the caller is not eligible for', async () => {
    mockIsCosmeticAvailable.mockResolvedValue(false);

    await expect(caller().claimCosmetic({ id: CLAIM_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(createUserCosmetic).not.toHaveBeenCalled();
  });

  it('grants only Claim-source cosmetics', async () => {
    // Availability says yes, so the refusal can only come from the source filter.
    await expect(caller().claimCosmetic({ id: TROPHY_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(createUserCosmetic).not.toHaveBeenCalled();
  });
});

describe('awardTrophyCosmetic', () => {
  it('grants a Trophy-source cosmetic without an availability check', async () => {
    await expect(awardTrophyCosmetic({ id: TROPHY_ID, userId: USER_ID })).resolves.toMatchObject({
      id: TROPHY_ID,
    });

    expect(mockIsCosmeticAvailable).not.toHaveBeenCalled();
    expect(createUserCosmetic).toHaveBeenCalledWith({
      data: { userId: USER_ID, cosmeticId: TROPHY_ID },
    });
  });

  it('does not grant a Claim-source cosmetic', async () => {
    await expect(awardTrophyCosmetic({ id: CLAIM_ID, userId: USER_ID })).resolves.toBeNull();
    expect(createUserCosmetic).not.toHaveBeenCalled();
  });
});
