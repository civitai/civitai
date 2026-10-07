import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHandleLogError, mockAwardTrophyCosmetic, counterStub, poolStub, poolCounters, utils } =
  vi.hoisted(() => ({
    mockHandleLogError: vi.fn(),
    mockAwardTrophyCosmetic: vi.fn(),
    poolStub: { exists: vi.fn(), getCount: vi.fn(), increment: vi.fn() },
    poolCounters: {} as Record<string, unknown>,
    utils: {
      checkVotingRateLimit: vi.fn(),
      getImageRatingsCounter: vi.fn(),
      getVotingCooldownUntil: vi.fn(),
    },
    counterStub: {
      increment: vi.fn(),
      decrement: vi.fn(),
      reset: vi.fn(),
      getCount: vi.fn(),
      getCountBatch: vi.fn(),
      getAll: vi.fn(),
      exists: vi.fn(),
      key: 'stub',
    },
  }));

// Heavy transitive deps the service imports at module load — stub so importing
// the real service doesn't drag in db/redis/env/otel/signal machinery.
vi.mock('~/server/games/new-order/utils', () => ({
  acolyteFailedJudgments: counterStub,
  allJudgmentsCounter: counterStub,
  blessedBuzzCounter: counterStub,
  correctJudgmentsCounter: counterStub,
  expCounter: counterStub,
  fervorCounter: counterStub,
  pendingBuzzCounter: counterStub,
  recentlyGrantedBuzzCounter: counterStub,
  sanityCheckFailuresCounter: counterStub,
  smitesCounter: counterStub,
  poolCounters,
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: utils.checkVotingRateLimit,
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn(),
  getImageRatingsCounter: utils.getImageRatingsCounter,
  getVotingCooldownUntil: utils.getVotingCooldownUntil,
  getVotingRateLimitConfig: vi.fn(),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: mockHandleLogError,
  throwBadRequestError: vi.fn(),
  throwInternalServerError: vi.fn(),
  throwNotFoundError: vi.fn(),
  throwRateLimitError: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/utils/game-helpers', () => ({ getLevelProgression: () => ({ level: 1 }) }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: vi.fn(),
  updateImageNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({ createReport: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  awardTrophyCosmetic: mockAwardTrophyCosmetic,
  claimCosmetic: vi.fn(async () => null),
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { topicSend: vi.fn(), send: vi.fn(async () => undefined) },
}));

import { addImageRating, joinGame } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { newOrderConfig } from '~/server/common/constants';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { NewOrderRankType, NsfwLevel } from '~/shared/utils/prisma/enums';

const USER_ID = 42;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findUnique.mockResolvedValue({ playerInfo: null });
  dbMock.dbWrite.newOrderPlayer.create.mockResolvedValue({ user: { id: USER_ID } });
  mockAwardTrophyCosmetic.mockResolvedValue({ id: newOrderConfig.cosmetics.badgeIds.acolyte });
});

describe('joinGame', () => {
  it('awards the acolyte badge through the server-side award path', async () => {
    await joinGame({ userId: USER_ID });

    expect(mockAwardTrophyCosmetic).toHaveBeenCalledWith({
      id: newOrderConfig.cosmetics.badgeIds.acolyte,
      userId: USER_ID,
    });
  });

  it('still lets the player join when the award fails', async () => {
    mockAwardTrophyCosmetic.mockRejectedValue(new Error('already owned'));

    await expect(joinGame({ userId: USER_ID })).resolves.toMatchObject({ id: USER_ID });
  });
});

describe('addImageRating rank-up', () => {
  const KNIGHT_MIN_EXP = 100;

  beforeEach(() => {
    vi.mocked(withDistributedLock).mockImplementation((async (
      _opts: unknown,
      fn: () => Promise<unknown>
    ) => fn()) as never);
    vi.mocked(fetchThroughCache).mockResolvedValue([
      { type: NewOrderRankType.Knight, name: 'Knight', minExp: KNIGHT_MIN_EXP, iconUrl: '' },
    ] as never);
    dbMock.dbRead.newOrderPlayer.findUnique.mockResolvedValue({
      rankType: NewOrderRankType.Acolyte,
      rank: { name: 'Acolyte' },
      user: { id: USER_ID },
    });
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      id: 1,
      nsfwLevel: NsfwLevel.PG,
      metadata: {},
    });
    const multi = {
      sAdd: () => multi,
      expire: () => multi,
      exec: async () => [],
    };
    redisMock.redis.multi.mockReturnValue(multi);
    utils.checkVotingRateLimit.mockResolvedValue({ allowed: true });
    utils.getVotingCooldownUntil.mockResolvedValue(null);
    utils.getImageRatingsCounter.mockReturnValue(counterStub);
    counterStub.getCount.mockResolvedValue(0);
    poolStub.exists.mockResolvedValue(true);
    poolStub.getCount.mockResolvedValue(0);
    poolStub.increment.mockResolvedValue(1);
    poolCounters[NewOrderRankType.Acolyte] = { a: [poolStub], b: [] };
    mockAwardTrophyCosmetic.mockResolvedValue({ id: newOrderConfig.cosmetics.badgeIds.knight });
  });

  const rate = () =>
    addImageRating({ playerId: USER_ID, imageId: 1, rating: NsfwLevel.PG } as never);

  it('awards the knight badge through the server-side award path on promotion', async () => {
    counterStub.increment.mockResolvedValue(KNIGHT_MIN_EXP);

    await rate();

    expect(mockAwardTrophyCosmetic).toHaveBeenCalledWith({
      id: newOrderConfig.cosmetics.badgeIds.knight,
      userId: USER_ID,
    });
  });

  it('awards nothing when the rating does not promote', async () => {
    counterStub.increment.mockResolvedValue(KNIGHT_MIN_EXP - 1);

    await rate();

    expect(mockAwardTrophyCosmetic).not.toHaveBeenCalled();
  });
});
