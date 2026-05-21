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
  mockClickhouse,
  mockSignalSend,
  mockSignalTopicSend,
  mockCreateNotification,
  mockUpdateImageNsfwLevel,
  mockHandleBlockImages,
  mockCreateReport,
  mockCounters,
  mockCheckVotingRateLimit,
  mockGetVotingRateLimitConfig,
  mockAutoSmitePlayer,
  mockPool,
  mockInquisitorPool,
  mockRatingsCounter,
} = vi.hoisted(() => {
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
  // A single shared Knight pool used by isImageInQueue + increment.
  const pool = counter();
  // Separate Inquisitor pool so escalation writes are detectable independently.
  const inquisitorPool = counter();
  const ratingsCounter = counter();
  return {
    mockDbRead: {
      newOrderPlayer: { findUnique: vi.fn() },
      newOrderRank: { findMany: vi.fn().mockResolvedValue([]) },
      image: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      report: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    mockDbWrite: {
      newOrderSmite: {
        create: vi.fn(),
        count: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      newOrderPlayer: { update: vi.fn() },
      $transaction: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([]),
    },
    mockSysRedis: {
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
      sIsMember: vi.fn().mockResolvedValue(0),
      sAdd: vi.fn(),
      sRem: vi.fn(),
      sMembers: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      incr: vi.fn().mockResolvedValue(0),
      decr: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
      hSet: vi.fn().mockResolvedValue(0),
      hGet: vi.fn().mockResolvedValue(null),
      hDel: vi.fn().mockResolvedValue(0),
      hIncrBy: vi.fn().mockResolvedValue(0),
      hmGet: vi.fn().mockResolvedValue([]),
      hGetAll: vi.fn().mockResolvedValue({}),
      hExpire: vi.fn().mockResolvedValue(1),
      zAdd: vi.fn().mockResolvedValue(1),
      zRem: vi.fn().mockResolvedValue(0),
      zScore: vi.fn().mockResolvedValue(null),
      zIncrBy: vi.fn().mockResolvedValue(0),
      zRangeWithScores: vi.fn().mockResolvedValue([]),
      // multi/exec used by processFinalRatings lock acquire path
      multi: vi.fn(() => {
        const chain: any = {};
        chain.setNX = vi.fn(() => chain);
        chain.expire = vi.fn(() => chain);
        chain.exec = vi.fn().mockResolvedValue([0, 1]); // setNX=0 (lock NOT acquired)
        return chain;
      }),
      packed: { get: vi.fn() },
    },
    mockRedis: {
      del: vi.fn(),
      unlink: vi.fn().mockResolvedValue(1),
      sMembers: vi.fn().mockResolvedValue([]),
      sIsMember: vi.fn().mockResolvedValue(0),
      sAdd: vi.fn(),
      zCard: vi.fn().mockResolvedValue(0),
      zAdd: vi.fn(),
      zRemRangeByScore: vi.fn(),
      expire: vi.fn(),
    },
    mockClickhouse: {
      $query: vi.fn().mockResolvedValue([]),
      $exec: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
    },
    mockSignalSend: vi.fn().mockResolvedValue(undefined),
    mockSignalTopicSend: vi.fn().mockResolvedValue(undefined),
    mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    mockUpdateImageNsfwLevel: vi.fn().mockResolvedValue(8),
    mockHandleBlockImages: vi.fn().mockResolvedValue(undefined),
    mockCreateReport: vi.fn().mockResolvedValue(undefined),
    mockCounters: {
      smites: counter(),
      sanityCheckFailures: counter(),
      acolyteFailedJudgments: counter(),
      correctJudgments: counter(),
      allJudgments: counter(),
      exp: counter(),
      fervor: counter(),
      blessedBuzz: counter(),
      pendingBuzz: counter(),
      recentlyGrantedBuzz: counter(),
    },
    mockCheckVotingRateLimit: vi.fn(),
    mockGetVotingRateLimitConfig: vi.fn().mockResolvedValue(null),
    mockAutoSmitePlayer: vi.fn().mockResolvedValue(true),
    mockPool: pool,
    mockInquisitorPool: inquisitorPool,
    mockRatingsCounter: ratingsCounter,
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));
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
vi.mock('~/server/services/user.service', () => ({ claimCosmetic: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages: mockHandleBlockImages,
  updateImageNsfwLevel: mockUpdateImageNsfwLevel,
}));
vi.mock('~/server/services/report.service', () => ({ createReport: mockCreateReport }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/games/new-order/utils', () => ({
  smitesCounter: mockCounters.smites,
  sanityCheckFailuresCounter: mockCounters.sanityCheckFailures,
  acolyteFailedJudgments: mockCounters.acolyteFailedJudgments,
  correctJudgmentsCounter: mockCounters.correctJudgments,
  allJudgmentsCounter: mockCounters.allJudgments,
  expCounter: mockCounters.exp,
  fervorCounter: mockCounters.fervor,
  blessedBuzzCounter: mockCounters.blessedBuzz,
  pendingBuzzCounter: mockCounters.pendingBuzz,
  recentlyGrantedBuzzCounter: mockCounters.recentlyGrantedBuzz,
  getImageRatingsCounter: vi.fn(() => mockRatingsCounter),
  // Single shared pool covers both Acolyte and Knight ranks; isImageInQueue
  // iterates a/b slots of the relevant rank.
  poolCounters: {
    Acolyte: { a: [mockPool, mockPool, mockPool], b: [mockPool, mockPool, mockPool] },
    Knight: { a: [mockPool, mockPool, mockPool], b: [mockPool, mockPool, mockPool] },
    Templar: { a: [mockPool, mockPool, mockPool], b: [mockPool, mockPool, mockPool] },
    Inquisitor: { a: [mockInquisitorPool], b: [mockInquisitorPool] },
  },
  getActiveSlot: vi.fn().mockResolvedValue('a'),
  setActiveSlot: vi.fn(),
  checkVotingRateLimit: mockCheckVotingRateLimit,
  getVotingRateLimitConfig: mockGetVotingRateLimitConfig,
}));
// Pass-through: execute the inner fn directly so we exercise processImageRating.
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: vi.fn((_name: string, fn: () => unknown) => fn()),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(async (_k: string, producer: () => unknown) => producer()),
  clearRatedImages: vi.fn(),
}));
vi.mock('~/server/selectors/user.selector', () => ({
  playerInfoSelect: {},
  userWithPlayerInfoSelect: {},
}));

// Import AFTER all mocks
import { addImageRating } from '~/server/services/games/new-order.service';
import { NsfwLevel } from '~/server/common/enums';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

// Fake Tracker that satisfies the chTracker parameter shape.
const fakeTracker = {
  newOrderImageRating: vi.fn().mockResolvedValue(undefined),
} as any;

const ALLOWED = {
  allowed: true,
  remaining: 100,
  resetTime: Date.now() + 60_000,
  dayLimitExceeded: false,
};

// Setup helpers
function setKnightPlayer(opts?: { exp?: number; smites?: number }) {
  const player = {
    userId: 100,
    rankType: NewOrderRankType.Knight,
    rank: { type: NewOrderRankType.Knight, name: 'Knight', iconUrl: '' },
    startAt: new Date('2025-01-01'),
    user: {},
  };
  mockDbRead.newOrderPlayer.findUnique.mockResolvedValue(player);
  // getPlayerStats counters
  mockCounters.exp.getCount.mockResolvedValue(opts?.exp ?? 5000);
  mockCounters.fervor.getCount.mockResolvedValue(0);
  mockCounters.smites.getCount.mockResolvedValue(opts?.smites ?? 0);
  mockCounters.blessedBuzz.getCount.mockResolvedValue(0);
  mockCounters.pendingBuzz.getCount.mockResolvedValue(0);
  mockCounters.recentlyGrantedBuzz.getCount.mockResolvedValue(0);
}

function setAcolytePlayer(opts?: { exp?: number; smites?: number }) {
  const player = {
    userId: 100,
    rankType: NewOrderRankType.Acolyte,
    rank: { type: NewOrderRankType.Acolyte, name: 'Acolyte', iconUrl: '' },
    startAt: new Date('2025-01-01'),
    user: {},
  };
  mockDbRead.newOrderPlayer.findUnique.mockResolvedValue(player);
  mockCounters.exp.getCount.mockResolvedValue(opts?.exp ?? 500);
  mockCounters.fervor.getCount.mockResolvedValue(0);
  mockCounters.smites.getCount.mockResolvedValue(opts?.smites ?? 0);
  mockCounters.blessedBuzz.getCount.mockResolvedValue(0);
  mockCounters.pendingBuzz.getCount.mockResolvedValue(0);
  mockCounters.recentlyGrantedBuzz.getCount.mockResolvedValue(0);
}

function setImage(opts?: { id?: number; nsfwLevel?: NsfwLevel }) {
  mockDbRead.image.findUnique.mockResolvedValue({
    id: opts?.id ?? 500,
    nsfwLevel: opts?.nsfwLevel ?? NsfwLevel.R,
    metadata: {},
  });
}

function setImageInPool(value: number) {
  // Make isImageInQueue return a hit on first slot/pool checked.
  mockPool.exists.mockResolvedValue(true);
  mockPool.getCount.mockResolvedValue(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: rate limit allows, image not in pool, no sanity match.
  mockCheckVotingRateLimit.mockResolvedValue(ALLOWED);
  mockSysRedis.sIsMember.mockResolvedValue(0);
  mockPool.exists.mockResolvedValue(false);
  mockPool.getCount.mockResolvedValue(0);
  mockPool.increment.mockResolvedValue(1);
  // Default rank list — Knight + Acolyte. Tests can override per case.
  mockDbRead.newOrderRank.findMany.mockResolvedValue([
    { type: NewOrderRankType.Acolyte, name: 'Acolyte', iconUrl: '', minExp: 0 },
    { type: NewOrderRankType.Knight, name: 'Knight', iconUrl: '', minExp: 1000 },
  ]);
});

// ===========================================================================
// addImageRating — rate limiting
// ===========================================================================
describe('addImageRating: rate limiting', () => {
  it('throws when rate limit exceeded for non-mod', async () => {
    setKnightPlayer();
    setImage();
    mockCheckVotingRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetTime: Date.now() + 30_000,
      dayLimitExceeded: false,
    });

    await expect(
      addImageRating({
        playerId: 100,
        imageId: 500,
        rating: NsfwLevel.R,
        chTracker: fakeTracker,
        isModerator: false,
      })
    ).rejects.toThrow(/Rate limit exceeded/);

    // No vote should have been written
    expect(mockPool.increment).not.toHaveBeenCalled();
    expect(mockRatingsCounter.increment).not.toHaveBeenCalled();
  });

  it('skips rate limit check for moderators', async () => {
    setKnightPlayer();
    setImage();
    setImageInPool(0);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: true,
    });

    expect(mockCheckVotingRateLimit).not.toHaveBeenCalled();
  });

  it('triggers autoSmitePlayer when day-cap exceeded AND autoSmiteEnabled', async () => {
    setKnightPlayer();
    setImage();
    mockCheckVotingRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetTime: Date.now() + 30_000,
      dayLimitExceeded: true,
    });
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteEnabled: true,
    });
    // autoSmitePlayer is co-located in the service module, so it is NOT mocked
    // via vi.mock — but the SET NX (sysRedis.set) and smitePlayer call chain ARE.
    // Make SET NX appear deduped to short-circuit the smite write.
    mockSysRedis.set.mockResolvedValue('OK');
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 1 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);

    await expect(
      addImageRating({
        playerId: 100,
        imageId: 500,
        rating: NsfwLevel.R,
        chTracker: fakeTracker,
        isModerator: false,
      })
    ).rejects.toThrow(/daily voting limit/);

    expect(mockDbWrite.newOrderSmite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetPlayerId: 100, givenById: -1 }),
      })
    );
  });

  it('does NOT auto-smite when day-cap exceeded but autoSmiteEnabled is false', async () => {
    setKnightPlayer();
    setImage();
    mockCheckVotingRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetTime: Date.now() + 30_000,
      dayLimitExceeded: true,
    });
    mockGetVotingRateLimitConfig.mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
      autoSmiteEnabled: false,
    });

    await expect(
      addImageRating({
        playerId: 100,
        imageId: 500,
        rating: NsfwLevel.R,
        chTracker: fakeTracker,
        isModerator: false,
      })
    ).rejects.toThrow(/Rate limit exceeded/);

    expect(mockDbWrite.newOrderSmite.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// addImageRating — sanity check intercept
// ===========================================================================
describe('addImageRating: sanity check intercept', () => {
  it('routes to addSanityCheckRating when image+rating is in the sanity pool', async () => {
    setKnightPlayer();
    setImage({ id: 500 });
    // Exact match for `500:${rating}` — first sIsMember call returns 1
    mockSysRedis.sIsMember.mockImplementationOnce(async () => 1);

    const result = await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: false,
    });

    // No queue write happens — sanity path returns early with stats.
    expect(mockPool.increment).not.toHaveBeenCalled();
    expect(mockRatingsCounter.increment).not.toHaveBeenCalled();
    expect(result.stats).toBeDefined();
  });

  it('detects sanity image even when the player submits the wrong rating', async () => {
    setKnightPlayer();
    setImage({ id: 500 });
    // Exact match for `500:rating` fails, but a later level matches (sanity image
    // is in the pool with a DIFFERENT correct level).
    mockSysRedis.sIsMember
      .mockResolvedValueOnce(0) // exact `500:R`
      .mockResolvedValueOnce(0) // `500:PG`
      .mockResolvedValueOnce(0) // `500:PG13`
      .mockResolvedValueOnce(1); // `500:R` again? — actually `500:R` is the exact, then PG/PG13/R/X/XXX. The third level here = R.

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.PG, // wrong rating
      chTracker: fakeTracker,
      isModerator: false,
    });

    // Still intercepted as sanity — no queue write
    expect(mockPool.increment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// addImageRating — image not in queue
// ===========================================================================
describe('addImageRating: image not in queue', () => {
  it('returns early with stats when image is not in any pool for the player rank', async () => {
    setKnightPlayer();
    setImage();
    mockPool.exists.mockResolvedValue(false);

    const result = await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockPool.increment).not.toHaveBeenCalled();
    expect(mockRatingsCounter.increment).not.toHaveBeenCalled();
    expect(result.stats).toBeDefined();
  });
});

// ===========================================================================
// addImageRating — moderator direct vote
// ===========================================================================
describe('addImageRating: moderator vote', () => {
  it('writes the rating via updateImageNsfwLevel and removes from queue', async () => {
    setKnightPlayer();
    setImage({ nsfwLevel: NsfwLevel.PG });
    setImageInPool(0);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: true,
    });

    expect(mockUpdateImageNsfwLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 500,
        nsfwLevel: NsfwLevel.R,
        userId: 100,
        isModerator: true,
        status: 'Actioned',
      })
    );
  });

  it('calls handleBlockImages when mod votes Blocked', async () => {
    setKnightPlayer();
    setImage({ nsfwLevel: NsfwLevel.PG });
    setImageInPool(0);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.Blocked,
      chTracker: fakeTracker,
      isModerator: true,
    });

    expect(mockHandleBlockImages).toHaveBeenCalledWith({ ids: [500] });
  });

  it('does NOT increment pool or rating counters for mod votes', async () => {
    setKnightPlayer();
    setImage();
    setImageInPool(0);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: true,
    });

    expect(mockPool.increment).not.toHaveBeenCalled();
    expect(mockRatingsCounter.increment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// addImageRating — Knight regular vote
// ===========================================================================
describe('addImageRating: Knight regular vote (no consensus yet)', () => {
  it('increments pool counter and the weighted ratings counter', async () => {
    setKnightPlayer({ exp: 5000, smites: 0 });
    setImage({ nsfwLevel: NsfwLevel.R });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1); // first vote

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockPool.increment).toHaveBeenCalledWith({ id: 500 });
    expect(mockRatingsCounter.increment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringContaining(`Knight-${NsfwLevel.R}`),
        value: expect.any(Number),
      })
    );
    // updateImageNsfwLevel is NOT called for sub-consensus votes
    expect(mockUpdateImageNsfwLevel).not.toHaveBeenCalled();
  });

  it('does not check consensus until knightVotes threshold is reached', async () => {
    setKnightPlayer();
    setImage({ nsfwLevel: NsfwLevel.R });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(3); // below threshold (5)

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: false,
    });

    // getAll on ratings counter would have been called inside checkWeightedConsensus
    expect(mockRatingsCounter.getAll).not.toHaveBeenCalledWith(
      expect.objectContaining({ withCount: true })
    );
  });
});

// ===========================================================================
// addImageRating — Knight consensus
// ===========================================================================
describe('addImageRating: Knight consensus reached', () => {
  it('updates image NSFW level when weighted consensus on same rating is reached', async () => {
    setKnightPlayer({ exp: 5000, smites: 0 });
    setImage({ nsfwLevel: NsfwLevel.R });
    setImageInPool(4);
    mockPool.increment.mockResolvedValue(5); // hits knightVotes threshold
    // Weighted consensus: 5 votes * 0.6 * 100 = 300 threshold.
    // Provide a Knight-R vote with score 600 to clear it on the same level.
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.R}`, score: 600 },
    ]);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockUpdateImageNsfwLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 500,
        nsfwLevel: NsfwLevel.R,
        isModerator: true,
        status: 'Actioned',
      })
    );
  });

  it('does NOT update NSFW level when no consensus and below max votes', async () => {
    setKnightPlayer();
    setImage({ nsfwLevel: NsfwLevel.R });
    setImageInPool(4);
    mockPool.increment.mockResolvedValue(5); // hits threshold but split votes
    // Five votes, none clearing 60% — split across multiple ratings
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.R}`, score: 200 },
      { value: `Knight-${NsfwLevel.PG13}`, score: 200 },
      { value: `Knight-${NsfwLevel.X}`, score: 100 },
    ]);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockUpdateImageNsfwLevel).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// addImageRating — excessive down-rating escalation (P0)
// ===========================================================================
describe('addImageRating: excessive down-rating escalates to Inquisitor queue', () => {
  it('does NOT apply consensus + adds image to Inquisitor pool when distance > 1', async () => {
    setKnightPlayer({ exp: 5000, smites: 0 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.XXX }); // current = XXX
    setImageInPool(4);
    mockPool.increment.mockResolvedValue(5); // hits knightVotes threshold
    // Weighted consensus: 5 * 0.6 * 100 = 300. Provide Knight-PG with score 400.
    // Flags.distance(XXX=16, PG=1) = |log2(16) - log2(1)| = 4. > 1 → excessive.
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.PG}`, score: 400 },
    ]);
    // addImageToQueue path will dbRead.image.findMany — return the image.
    mockDbRead.image.findMany.mockResolvedValue([
      { id: 500, url: 'mock', nsfwLevel: NsfwLevel.XXX, metadata: {} },
    ]);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.PG,
      chTracker: fakeTracker,
      isModerator: false,
    });

    // No consensus applied to image
    expect(mockUpdateImageNsfwLevel).not.toHaveBeenCalled();
    // Image escalated to Inquisitor queue (addImageToQueue uses pool.getCount on
    // cache-miss to seed score 0 — assert the Inquisitor pool saw the imageId).
    expect(mockInquisitorPool.getCount).toHaveBeenCalledWith(500);
    // Image removed from Knight queue
    expect(mockPool.reset).toHaveBeenCalled();
  });

  it('creates AdminAttention report when Knight votes Blocked and weighted score >= 200', async () => {
    setKnightPlayer({ exp: 5000, smites: 0 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.X });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1); // first vote, below knightVotes
    // Blocked-vote report path checks getAll for `Knight-Blocked` score >= 200.
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.Blocked}`, score: 200 },
    ]);
    mockDbRead.report.findFirst.mockResolvedValue(null); // no existing report

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.Blocked,
      damnedReason: 'CSAM' as any,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockCreateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 100,
        id: 500,
        details: expect.objectContaining({
          reason: 'CSAM',
        }),
      })
    );
    // Image is removed from queue after report creation
    expect(mockPool.reset).toHaveBeenCalled();
  });

  it('dedupes Blocked report when one already exists (no duplicate AdminAttention)', async () => {
    setKnightPlayer({ exp: 5000, smites: 0 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.X });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.Blocked}`, score: 300 },
    ]);
    // Existing report already filed
    mockDbRead.report.findFirst.mockResolvedValue({ id: 999 });

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.Blocked,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockCreateReport).not.toHaveBeenCalled();
  });

  it('does NOT create report when Blocked score is below 200 threshold', async () => {
    setKnightPlayer();
    setImage({ id: 500, nsfwLevel: NsfwLevel.X });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.Blocked}`, score: 100 }, // below 200
    ]);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.Blocked,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockCreateReport).not.toHaveBeenCalled();
  });

  it('uses fallback report reason when no damnedReason supplied', async () => {
    setKnightPlayer();
    setImage({ id: 500, nsfwLevel: NsfwLevel.X });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.Blocked}`, score: 200 },
    ]);
    mockDbRead.report.findFirst.mockResolvedValue(null);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.Blocked,
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockCreateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: expect.stringContaining('Multiple Knights'),
        }),
      })
    );
  });

  it('applies consensus normally when down-rating distance is exactly 1 (allowed)', async () => {
    setKnightPlayer({ exp: 5000, smites: 0 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.R }); // current = R (pos 2)
    setImageInPool(4);
    mockPool.increment.mockResolvedValue(5);
    // Consensus = PG13 (pos 1). distance(R, PG13) = 1. Allowed.
    mockRatingsCounter.getAll.mockResolvedValue([
      { value: `Knight-${NsfwLevel.PG13}`, score: 400 },
    ]);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.PG13,
      chTracker: fakeTracker,
      isModerator: false,
    });

    // Consensus applied — image NSFW level updated
    expect(mockUpdateImageNsfwLevel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 500, nsfwLevel: NsfwLevel.PG13 })
    );
    // NOT escalated to Inquisitor
    expect(mockInquisitorPool.getCount).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// addImageRating — Acolyte training paths (P0)
// ===========================================================================
describe('addImageRating: Acolyte wrong-answer enforcement', () => {
  it('increments acolyteFailedJudgments on a wrong rating', async () => {
    setAcolytePlayer({ exp: 500 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.PG });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);
    // Acolyte rated incorrectly; counter increments to 1 (below limit of 5)
    mockCounters.acolyteFailedJudgments.increment.mockResolvedValue(1);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.XXX, // wrong
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockCounters.acolyteFailedJudgments.increment).toHaveBeenCalledWith({ id: 100 });
    // Below limit → no smite yet
    expect(mockDbWrite.newOrderSmite.create).not.toHaveBeenCalled();
  });

  it('smites + resets counter when wrong-answer count EXCEEDS ACOLYTE_WRONG_ANSWER_LIMIT (>5)', async () => {
    setAcolytePlayer({ exp: 500 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.PG });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);
    // 6th wrong answer — exceeds limit (5)
    mockCounters.acolyteFailedJudgments.increment.mockResolvedValue(6);
    mockDbWrite.newOrderSmite.create.mockResolvedValue({ id: 1 });
    mockDbWrite.newOrderSmite.count.mockResolvedValue(1);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.XXX,
      chTracker: fakeTracker,
      isModerator: false,
    });

    // System smite issued
    expect(mockDbWrite.newOrderSmite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetPlayerId: 100,
          givenById: -1,
          reason: 'Exceeded wrong answer limit',
        }),
      })
    );
    // Wrong-answer counter reset after smite
    expect(mockCounters.acolyteFailedJudgments.reset).toHaveBeenCalledWith({ id: 100 });
  });

  it('cleanses all smites + resets wrong-answer counter on Acolyte level-up', async () => {
    // getLevelProgression boundaries (cumulative): L1=250, L2=545, L3=893, L4=1303.
    // exp 1203 = level 4; 1203 + baseExp(100) = 1303 = level 5 → triggers level-up.
    setAcolytePlayer({ exp: 1203 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.PG });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);
    mockCounters.exp.getCount.mockResolvedValue(1203);
    // updateMany return for cleanseAllSmites
    mockDbWrite.newOrderSmite.updateMany.mockResolvedValue({ count: 1 });

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.PG, // CORRECT — matches image nsfwLevel
      chTracker: fakeTracker,
      isModerator: false,
    });

    // Level-up triggers cleanseAllSmites + acolyteFailedJudgments reset
    expect(mockDbWrite.newOrderSmite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ targetPlayerId: 100, cleansedAt: null }),
        data: expect.objectContaining({ cleansedReason: 'Acolyte - Level up!' }),
      })
    );
    expect(mockCounters.acolyteFailedJudgments.reset).toHaveBeenCalledWith({ id: 100 });
  });

  it('does NOT increment wrong-answer counter on a correct Acolyte vote', async () => {
    setAcolytePlayer({ exp: 500 });
    setImage({ id: 500, nsfwLevel: NsfwLevel.R });
    setImageInPool(0);
    mockPool.increment.mockResolvedValue(1);

    await addImageRating({
      playerId: 100,
      imageId: 500,
      rating: NsfwLevel.R, // correct
      chTracker: fakeTracker,
      isModerator: false,
    });

    expect(mockCounters.acolyteFailedJudgments.increment).not.toHaveBeenCalled();
    expect(mockDbWrite.newOrderSmite.create).not.toHaveBeenCalled();
  });
});
