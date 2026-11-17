import { describe, it, expect, vi, beforeEach } from 'vitest';

// processFinalRatings settles a batch with the SQL from buildFinalRatingsInsert, over the window
// since the last batch it processed. The SQL itself is pinned in final-ratings-sql.test.ts.

const { counterStub, poolStub, mockQuery, mockExec } = vi.hoisted(() => {
  const counter = () => ({
    increment: vi.fn(),
    decrement: vi.fn(),
    reset: vi.fn(),
    getCount: vi.fn().mockResolvedValue(0),
    getCountBatch: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    exists: vi.fn(),
    key: 'stub',
  });
  return { counterStub: counter(), poolStub: counter(), mockQuery: vi.fn(), mockExec: vi.fn() };
});

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
  poolCounters: { Knight: { a: [poolStub] } },
  DEFAULT_POOL_QUOTAS: {},
  checkVotingRateLimit: vi.fn(),
  computePoolTargets: vi.fn(),
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  getImageRatingsCounter: vi.fn(),
  getVotingCooldownUntil: vi.fn().mockResolvedValue(null),
  getVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: mockQuery, $exec: mockExec },
}));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: vi.fn(),
  throwBadRequestError: vi.fn(),
  throwInternalServerError: vi.fn(),
  throwNotFoundError: vi.fn(),
  throwRateLimitError: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({ withSpan: (_n: string, fn: any) => fn() }));
vi.mock('~/server/utils/game-helpers', () => ({ getLevelProgression: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: vi.fn(),
  updateImageNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({ createReport: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ awardTrophyCosmetic: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));

import { processFinalRatings } from '~/server/services/games/new-order.service';
import { buildFinalRatingsInsert } from '~/server/games/new-order/final-ratings-sql';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

const END = '2026-11-02T10:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  const chain: any = {};
  for (const m of ['setNX', 'expire', 'set', 'del']) chain[m] = () => chain;
  chain.exec = async () => [true];
  redisMock.sysRedis.multi.mockReturnValue(chain);
  redisMock.sysRedis.incr.mockResolvedValue(1000); // enough queued decisions to process now
  redisMock.sysRedis.get.mockImplementation(async (key: string) =>
    key === REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.BATCH_CUTOFF ? '1762000000000' : null
  );
  mockQuery.mockResolvedValue([{ updateEnd: END }]);
  mockExec.mockResolvedValue(undefined);
});

describe('processFinalRatings', () => {
  it('runs the pending-only settle SQL over the window since the last batch', async () => {
    const result = await processFinalRatings();

    expect(result).toMatchObject({ status: 'processed' });
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      buildFinalRatingsInsert({ updateStart: new Date(1762000000000), updateEnd: new Date(END) })
    );
  });
});
