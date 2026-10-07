import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHandleLogError, mockAwardTrophyCosmetic, counterStub } = vi.hoisted(() => ({
  mockHandleLogError: vi.fn(),
  mockAwardTrophyCosmetic: vi.fn(),
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
  poolCounters: {},
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: vi.fn(),
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn(),
  getImageRatingsCounter: vi.fn(),
  getVotingCooldownUntil: vi.fn(),
  getVotingRateLimitConfig: vi.fn(),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
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
vi.mock('~/server/utils/game-helpers', () => ({ getLevelProgression: vi.fn() }));
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
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));

import { joinGame } from '~/server/services/games/new-order.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { newOrderConfig } from '~/server/common/constants';

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
