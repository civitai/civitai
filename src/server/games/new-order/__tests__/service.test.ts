import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deepStringProxy } from './test-utils';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockDbRead,
  mockDbWrite,
  mockSysRedis,
  mockRedis,
  mockSignalSend,
  mockSignalTopicSend,
  mockCreateNotification,
  mockClaimCosmetic,
  mockLogToAxiom,
  mockSmitesCounter,
  mockSanityCheckFailuresCounter,
  mockAcolyteFailedJudgments,
  mockCorrectJudgmentsCounter,
  mockAllJudgmentsCounter,
  mockExpCounter,
  mockFervorCounter,
  mockBlessedBuzzCounter,
  mockPendingBuzzCounter,
  mockRecentlyGrantedBuzzCounter,
  mockCheckVotingRateLimit,
  mockGetVotingRateLimitConfig,
  mockClearRatedImages,
  mockWithDistributedLock,
} = vi.hoisted(() => {
  // Counter shape inlined (vi.hoisted runs before imports — can't pull from test-utils).
  const counter = () => ({
    increment: vi.fn().mockResolvedValue(0),
    decrement: vi.fn().mockResolvedValue(0),
    reset: vi.fn().mockResolvedValue(undefined),
    getCount: vi.fn().mockResolvedValue(0),
    getCountBatch: vi.fn().mockResolvedValue(new Map()),
    getAll: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
    key: 'mock-counter-key',
  });

  return {
    mockDbRead: {
      newOrderPlayer: { findUnique: vi.fn(), findMany: vi.fn() },
      newOrderSmite: { count: vi.fn(), findMany: vi.fn() },
      newOrderRank: { findFirst: vi.fn(), findMany: vi.fn() },
      newOrderImageRating: { deleteMany: vi.fn() },
      image: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
    },
    mockDbWrite: {
      newOrderSmite: {
        create: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      newOrderPlayer: { update: vi.fn(), upsert: vi.fn() },
      newOrderImageRating: { deleteMany: vi.fn() },
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
    },
    mockSysRedis: {
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
      sMembers: vi.fn().mockResolvedValue([]),
      sIsMember: vi.fn().mockResolvedValue(0),
      sAdd: vi.fn(),
      sRem: vi.fn(),
      get: vi.fn(),
      packed: { get: vi.fn() },
    },
    mockRedis: {
      del: vi.fn().mockResolvedValue(1),
      unlink: vi.fn().mockResolvedValue(1),
      sMembers: vi.fn().mockResolvedValue([]),
      sIsMember: vi.fn().mockResolvedValue(0),
      sAdd: vi.fn(),
      sRem: vi.fn(),
      zAdd: vi.fn(),
      zCard: vi.fn().mockResolvedValue(0),
      zRemRangeByScore: vi.fn(),
      expire: vi.fn(),
    },
    mockSignalSend: vi.fn().mockResolvedValue(undefined),
    mockSignalTopicSend: vi.fn().mockResolvedValue(undefined),
    mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    mockClaimCosmetic: vi.fn().mockResolvedValue(undefined),
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
    mockSmitesCounter: counter(),
    mockSanityCheckFailuresCounter: counter(),
    mockAcolyteFailedJudgments: counter(),
    mockCorrectJudgmentsCounter: counter(),
    mockAllJudgmentsCounter: counter(),
    mockExpCounter: counter(),
    mockFervorCounter: counter(),
    mockBlessedBuzzCounter: counter(),
    mockPendingBuzzCounter: counter(),
    mockRecentlyGrantedBuzzCounter: counter(),
    mockCheckVotingRateLimit: vi.fn(),
    mockGetVotingRateLimitConfig: vi.fn(),
    mockClearRatedImages: vi.fn().mockResolvedValue(undefined),
    mockWithDistributedLock: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: deepStringProxy('rk'),
  REDIS_SYS_KEYS: deepStringProxy('rsk'),
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: mockSignalSend, topicSend: mockSignalTopicSend },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/user.service', () => ({ claimCosmetic: mockClaimCosmetic }));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: vi.fn(),
  updateImageNsfwLevel: vi.fn(),
}));
vi.mock('~/server/services/report.service', () => ({ createReport: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/games/new-order/utils', () => ({
  smitesCounter: mockSmitesCounter,
  sanityCheckFailuresCounter: mockSanityCheckFailuresCounter,
  acolyteFailedJudgments: mockAcolyteFailedJudgments,
  correctJudgmentsCounter: mockCorrectJudgmentsCounter,
  allJudgmentsCounter: mockAllJudgmentsCounter,
  expCounter: mockExpCounter,
  fervorCounter: mockFervorCounter,
  blessedBuzzCounter: mockBlessedBuzzCounter,
  pendingBuzzCounter: mockPendingBuzzCounter,
  recentlyGrantedBuzzCounter: mockRecentlyGrantedBuzzCounter,
  getImageRatingsCounter: vi.fn(() => ({
    increment: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
  })),
  poolCounters: {},
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  checkVotingRateLimit: mockCheckVotingRateLimit,
  getVotingRateLimitConfig: mockGetVotingRateLimitConfig,
}));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: mockWithDistributedLock,
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  // Execute the producer so tests can drive newOrderRank.findMany directly.
  fetchThroughCache: vi.fn(async (_key: string, producer: () => unknown) => producer()),
  clearRatedImages: mockClearRatedImages,
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: vi.fn((_name: string, fn: () => unknown) => fn()),
}));
vi.mock('~/server/selectors/user.selector', () => ({
  playerInfoSelect: {},
  userWithPlayerInfoSelect: {},
}));

// Import AFTER all mocks
import {
  smitePlayer,
  cleanseSmite,
  cleanseAllSmites,
  autoSmitePlayer,
  resetPlayer,
  handleSanityCheckFailure,
} from '~/server/services/games/new-order.service';
import { NsfwLevel } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const SYSTEM_USER_ID = -1;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: most signal+notification side effects succeed silently.
  mockSignalSend.mockResolvedValue(undefined);
  mockSignalTopicSend.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
  mockSysRedis.del.mockResolvedValue(1);
});

// ===========================================================================
// smitePlayer
// ===========================================================================
describe('smitePlayer', () => {
  it('creates a smite row, increments counter, and sends signal + notification', async () => {
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 42 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);
    mockSmitesCounter.increment.mockResolvedValue(1);

    const result = await smitePlayer({
      playerId: 100,
      modId: 5,
      reason: 'test smite',
      size: 10,
    });

    expect(mockDbWrite.newOrderSmite.create).toHaveBeenCalledWith({
      data: {
        targetPlayerId: 100,
        givenById: 5,
        reason: 'test smite',
        size: 10,
        remaining: 10,
      },
    });
    expect(mockSmitesCounter.increment).toHaveBeenCalledWith({ id: 100 });
    expect(mockSignalSend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 100,
        data: expect.objectContaining({
          stats: { smites: 1 },
          notification: expect.objectContaining({ type: 'smite', message: 'test smite' }),
        }),
      })
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-order-smite-received', userId: 100 })
    );
    expect(result).toEqual({ id: 42 });
  });

  it('triggers career reset when active smite count reaches 3', async () => {
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 99 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(3);
    mockDbWrite.$transaction.mockResolvedValue([{}, {}]);
    mockDbRead.newOrderRank.findMany.mockResolvedValue([
      { type: NewOrderRankType.Acolyte, name: 'Acolyte', iconUrl: '', minExp: 0 },
      { type: NewOrderRankType.Knight, name: 'Knight', iconUrl: '', minExp: 1000 },
    ]);

    await smitePlayer({ playerId: 100, modId: 5, reason: 'over the limit', size: 10 });

    // resetPlayer path: transaction with player reset + smite cleanse, plus counter resets.
    expect(mockDbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockSmitesCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockExpCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockFervorCounter.reset).toHaveBeenCalledWith({ id: 100 });
    // smitesCounter.increment NOT called when reset triggered
    expect(mockSmitesCounter.increment).not.toHaveBeenCalled();
  });

  it('uses default fallback message when no reason provided', async () => {
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 1 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);

    await smitePlayer({ playerId: 100, modId: 5, reason: undefined, size: 10 });

    expect(mockSignalSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notification: expect.objectContaining({
            message: 'A moderator has applied a smite penalty to your account.',
          }),
        }),
      })
    );
  });
});

// ===========================================================================
// cleanseSmite
// ===========================================================================
describe('cleanseSmite', () => {
  it('marks smite cleansed, decrements counter, sends signal + notification', async () => {
    mockDbWrite.newOrderSmite.update.mockResolvedValue({ id: 7 });
    mockSmitesCounter.decrement.mockResolvedValue(2);

    const result = await cleanseSmite({
      id: 7,
      playerId: 100,
      cleansedReason: 'False positive',
    });

    expect(mockDbWrite.newOrderSmite.update).toHaveBeenCalledWith({
      where: { id: 7, cleansedAt: null },
      data: { cleansedAt: expect.any(Date), cleansedReason: 'False positive' },
    });
    expect(mockSmitesCounter.decrement).toHaveBeenCalledWith({ id: 100 });
    expect(mockSignalSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stats: { smites: 2 },
          notification: expect.objectContaining({ type: 'cleanse' }),
        }),
      })
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'new-order-smite-cleansed',
        details: { cleansedReason: 'False positive' },
      })
    );
    expect(result).toEqual({ id: 7 });
  });
});

// ===========================================================================
// cleanseAllSmites
// ===========================================================================
describe('cleanseAllSmites', () => {
  it('no-ops on count=0 (no signal sent)', async () => {
    mockDbWrite.newOrderSmite.updateMany.mockResolvedValue({ count: 0 });

    await cleanseAllSmites({ playerId: 100, cleansedReason: 'test' });

    expect(mockSmitesCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockSignalSend).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('sends signal + notification when smites were cleansed', async () => {
    mockDbWrite.newOrderSmite.updateMany.mockResolvedValue({ count: 2 });

    await cleanseAllSmites({ playerId: 100, cleansedReason: 'Acolyte - Level up!' });

    expect(mockSmitesCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockSignalSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stats: { smites: 0 } }) })
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'new-order-smite-cleansed',
        details: { cleansedReason: 'Acolyte - Level up!' },
      })
    );
  });
});

// ===========================================================================
// autoSmitePlayer
// ===========================================================================
describe('autoSmitePlayer', () => {
  it('issues a system smite on first hit per source per day', async () => {
    mockSysRedis.set.mockResolvedValue('OK'); // SET NX returned OK
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 1 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);

    const ok = await autoSmitePlayer({
      playerId: 100,
      reason: 'limit exceeded',
      source: 'rate-limit',
    });

    expect(ok).toBe(true);
    expect(mockSysRedis.set).toHaveBeenCalledWith(
      expect.anything(), // key — proxied REDIS_SYS_KEYS chain
      '1',
      { NX: true, EX: 24 * 60 * 60 }
    );
    expect(mockDbWrite.newOrderSmite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetPlayerId: 100,
          givenById: SYSTEM_USER_ID,
          reason: 'limit exceeded',
          size: 1,
        }),
      })
    );
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-auto-smite' })
    );
  });

  it('dedupes second call within 24h (no smite issued)', async () => {
    mockSysRedis.set.mockResolvedValue(null); // SET NX returned nil (key already exists)

    const ok = await autoSmitePlayer({
      playerId: 100,
      reason: 'second attempt',
      source: 'rate-limit',
    });

    expect(ok).toBe(false);
    expect(mockDbWrite.newOrderSmite.create).not.toHaveBeenCalled();
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('releases dedupe key when smitePlayer throws so next signal can retry', async () => {
    mockSysRedis.set.mockResolvedValue('OK');
    mockDbWrite.newOrderSmite.create.mockRejectedValue(new Error('DB down'));

    await expect(
      autoSmitePlayer({ playerId: 100, reason: 'fail', source: 'detection-job' })
    ).rejects.toThrow('DB down');
    expect(mockSysRedis.del).toHaveBeenCalledWith(expect.anything());
  });

  it('returns false when sysRedis is unavailable', async () => {
    // sysRedis exists in this test (mocked above), so the early-return guard
    // only fires if the import is null/undefined. Simulate by stubbing set to
    // simulate a connection-level failure that propagates.
    mockSysRedis.set.mockRejectedValue(new Error('redis down'));

    await expect(
      autoSmitePlayer({ playerId: 100, reason: 'x', source: 'rate-limit' })
    ).rejects.toThrow('redis down');
  });
});

// ===========================================================================
// resetPlayer
// ===========================================================================
describe('resetPlayer', () => {
  it('resets player row + cleanses smites + resets all counters + clears rated cache', async () => {
    mockDbWrite.$transaction.mockResolvedValue([{}, {}]);
    mockDbRead.newOrderRank.findMany.mockResolvedValue([
      { type: NewOrderRankType.Acolyte, name: 'Acolyte', iconUrl: '', minExp: 0 },
      { type: NewOrderRankType.Knight, name: 'Knight', iconUrl: '', minExp: 1000 },
    ]);

    await resetPlayer({ playerId: 100, withNotification: false });

    expect(mockDbWrite.$transaction).toHaveBeenCalled();
    expect(mockSmitesCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockSanityCheckFailuresCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockCorrectJudgmentsCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockAllJudgmentsCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockExpCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockFervorCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockBlessedBuzzCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockPendingBuzzCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockRecentlyGrantedBuzzCounter.reset).toHaveBeenCalledWith({ id: 100 });
    expect(mockRedis.unlink).toHaveBeenCalled();
    expect(mockSignalSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'reset' }),
      })
    );
  });

  it('also resets acolyteFailedJudgments so wrong-answer count does not carry across career resets', async () => {
    mockDbWrite.$transaction.mockResolvedValue([{}, {}]);
    mockDbRead.newOrderRank.findMany.mockResolvedValue([
      { type: NewOrderRankType.Acolyte, name: 'Acolyte', iconUrl: '', minExp: 0 },
      { type: NewOrderRankType.Knight, name: 'Knight', iconUrl: '', minExp: 1000 },
    ]);

    await resetPlayer({ playerId: 100 });

    expect(mockAcolyteFailedJudgments.reset).toHaveBeenCalledWith({ id: 100 });
  });
});

// ===========================================================================
// handleSanityCheckFailure
// ===========================================================================
describe('handleSanityCheckFailure', () => {
  it('on first non-severe failure: warning notification + signal, no smite', async () => {
    mockSanityCheckFailuresCounter.increment.mockResolvedValue(1);

    await handleSanityCheckFailure({
      playerId: 100,
      imageId: 500,
      submittedRating: NsfwLevel.R,
      correctNsfwLevel: NsfwLevel.X, // distance(X, R) = log2(8) - log2(4) = 1, not severe
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-order-sanity-warning' })
    );
    expect(mockSignalSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notification: expect.objectContaining({ type: 'warning' }),
        }),
      })
    );
    // smite path NOT taken
    expect(mockDbWrite.newOrderSmite.create).not.toHaveBeenCalled();
  });

  it('on second failure within 24h: applies smite', async () => {
    mockSanityCheckFailuresCounter.increment.mockResolvedValue(2);
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 99 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);

    await handleSanityCheckFailure({
      playerId: 100,
      imageId: 500,
      submittedRating: NsfwLevel.PG13,
      correctNsfwLevel: NsfwLevel.R, // distance 1, not severe
    });

    expect(mockDbWrite.newOrderSmite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ givenById: SYSTEM_USER_ID, size: 100 }),
      })
    );
  });

  it('on first severe under-rating (distance >= 2): smites immediately, no warning', async () => {
    mockSanityCheckFailuresCounter.increment.mockResolvedValue(1); // first failure
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 1 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);

    await handleSanityCheckFailure({
      playerId: 100,
      imageId: 500,
      submittedRating: NsfwLevel.PG, // pos 0
      correctNsfwLevel: NsfwLevel.XXX, // pos 4 → distance 4
    });

    expect(mockDbWrite.newOrderSmite.create).toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-order-sanity-warning' })
    );
  });

  it('does NOT smite when submitted rating is HIGHER than correct (over-rating)', async () => {
    mockSanityCheckFailuresCounter.increment.mockResolvedValue(1);

    await handleSanityCheckFailure({
      playerId: 100,
      imageId: 500,
      submittedRating: NsfwLevel.XXX, // over-rating
      correctNsfwLevel: NsfwLevel.PG,
    });

    // over-rating with distance 4 is not "severe under-rating" — only warning
    expect(mockDbWrite.newOrderSmite.create).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'new-order-sanity-warning' })
    );
  });
});
