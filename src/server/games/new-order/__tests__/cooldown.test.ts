import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockRedis,
  mockSysRedis,
  mockLogToAxiom,
  mockHandleLogError,
  // Config getter returns these on demand
  configHolder,
} = vi.hoisted(() => {
  const configHolder: { value: any } = { value: null };

  return {
    configHolder,
    mockRedis: {
      pTTL: vi.fn().mockResolvedValue(-2),
      zRemRangeByScore: vi.fn().mockResolvedValue(0),
      zCard: vi.fn().mockResolvedValue(0),
      zAdd: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockImplementation(async (_script, { arguments: args }) => Number(args[0])),
    },
    mockSysRedis: {
      packed: {
        get: vi.fn(async () => configHolder.value),
      },
    },
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
    mockHandleLogError: vi.fn(),
  };
});

vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: {
    CACHES: {
      NEW_ORDER: {
        RATE_LIMIT: {
          MINUTE: 'new-order:rate-limit:minute',
          HOUR: 'new-order:rate-limit:hour',
          DAY: 'new-order:rate-limit:day',
          COOLDOWN: 'new-order:rate-limit:cooldown',
        },
      },
    },
  },
  REDIS_SYS_KEYS: {
    NEW_ORDER: {
      EXP: 'new-order:exp',
      FERVOR: 'new-order:fervor',
      BUZZ: 'new-order:blessed-buzz',
      PENDING_BUZZ: 'new-order:pending-buzz',
      RECENTLY_GRANTED_BUZZ: 'new-order:recently-granted-buzz',
      SMITE: 'new-order:smite-progress',
      QUEUES: 'new-order:queues',
      ACTIVE_SLOT: 'new-order:active-slot',
      RATINGS: 'new-order:ratings',
      MATCHES: 'new-order:matches',
      JUDGEMENTS: {
        ALL: 'new-order:judgments:all',
        CORRECT: 'new-order:judgments:correct',
        ACOLYTE_FAILED: 'new-order:judgments:acolyte-failed',
      },
      SANITY_CHECKS: { POOL: 'new-order:sanity-checks', FAILURES: 'new-order:sanity-failures' },
      CONFIG: 'new-order:config',
      PROCESSING: {
        LAST_PROCESSED_AT: 'new-order:processing:last-processed-at',
        BATCH_CUTOFF: 'new-order:processing:batch-cutoff',
        PENDING_COUNT: 'new-order:processing:pending-count',
        LOCK: 'new-order:processing:lock',
      },
    },
  },
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/utils/errorHandling', () => ({ handleLogError: mockHandleLogError }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/common/constants', () => ({
  CacheTTL: { day: 86400 },
  newOrderConfig: {},
}));
vi.mock('~/server/common/enums', () => ({
  NewOrderImageRatingStatus: {},
}));
vi.mock('~/shared/utils/prisma/enums', () => ({ NewOrderRankType: {} }));
vi.mock('dayjs', () => ({ default: () => ({}) }));

// Import AFTER mocks
import {
  checkVotingRateLimit,
  DEFAULT_VOTING_RATE_LIMIT_CONFIG,
} from '~/server/games/new-order/utils';

const DEFAULT_CONFIG = {
  perMinute: 40,
  perHour: 600,
  perDay: 3000,
};

beforeEach(() => {
  vi.clearAllMocks();
  configHolder.value = { ...DEFAULT_CONFIG };
  mockRedis.pTTL.mockResolvedValue(-2);
  mockRedis.zCard.mockResolvedValue(0);
});

describe('checkVotingRateLimit cooldown behavior', () => {
  it('short-circuits when cooldown is active', async () => {
    mockRedis.pTTL.mockResolvedValueOnce(5_000); // 5s left

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    expect(result.cooldownUntil).toBeGreaterThan(Date.now());
    // Sliding window check is skipped — no zCard reads when locked.
    expect(mockRedis.zCard).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('allows the vote and does not set cooldown when under all limits', async () => {
    mockRedis.zCard.mockResolvedValue(10);

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(true);
    expect(result.cooldownUntil).toBe(0);
    expect(mockRedis.eval).not.toHaveBeenCalled();
    // Vote was recorded in all three windows
    expect(mockRedis.zAdd).toHaveBeenCalledTimes(3);
  });

  it('sets a 10-minute cooldown when the minute window trips', async () => {
    mockRedis.pTTL.mockResolvedValueOnce(-2); // no current cooldown
    // minute at cap, hour/day under cap
    mockRedis.zCard
      .mockResolvedValueOnce(DEFAULT_CONFIG.perMinute) // minute
      .mockResolvedValueOnce(50) // hour
      .mockResolvedValueOnce(50); // day

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('PTTL'),
      {
        keys: ['new-order:rate-limit:cooldown:42'],
        arguments: [(10 * 60 * 1000).toString()],
      }
    );
    expect(mockRedis.zAdd).not.toHaveBeenCalled();
  });

  it('sets a 1-hour cooldown when the hour window trips (minute still allowed)', async () => {
    mockRedis.pTTL.mockResolvedValueOnce(-2);
    mockRedis.zCard
      .mockResolvedValueOnce(10) // minute ok
      .mockResolvedValueOnce(DEFAULT_CONFIG.perHour) // hour at cap
      .mockResolvedValueOnce(100); // day ok

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('PTTL'),
      {
        keys: ['new-order:rate-limit:cooldown:42'],
        arguments: [(60 * 60 * 1000).toString()],
      }
    );
  });

  it('sets a 24-hour cooldown when the day window trips', async () => {
    mockRedis.pTTL.mockResolvedValueOnce(-2);
    mockRedis.zCard
      .mockResolvedValueOnce(10) // minute ok
      .mockResolvedValueOnce(50) // hour ok
      .mockResolvedValueOnce(DEFAULT_CONFIG.perDay); // day at cap

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('PTTL'),
      {
        keys: ['new-order:rate-limit:cooldown:42'],
        arguments: [(24 * 60 * 60 * 1000).toString()],
      }
    );
  });

  it('does not shrink an active longer cooldown (max-merge via Lua)', async () => {
    // Short-circuit path: pTTL > 0 at entry means we never reach the Lua
    // call. Tested separately above. This case covers the race window:
    // pTTL=0 at read time (expired between checks) but Lua sees a longer
    // existing cooldown and refuses to shrink — return the existing PTTL.
    mockRedis.pTTL.mockResolvedValueOnce(-2);
    mockRedis.zCard
      .mockResolvedValueOnce(DEFAULT_CONFIG.perMinute) // minute trip → 10m attempt
      .mockResolvedValueOnce(50)
      .mockResolvedValueOnce(50);
    // Lua returns existing 30-min PTTL (greater than requested 10m)
    mockRedis.eval.mockResolvedValueOnce(30 * 60 * 1000);

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    // cooldownUntil reflects the longer existing window, not the 10m attempt
    expect(result.cooldownUntil).toBeGreaterThan(Date.now() + 25 * 60 * 1000);
  });

  it('denies the vote when redis is unavailable', async () => {
    mockRedis.pTTL.mockRejectedValueOnce(new Error('connection refused'));

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    expect(mockHandleLogError).toHaveBeenCalled();
  });

  it('falls back to default limits and allows the vote when config is missing', async () => {
    // A wiped/unseeded `new-order:config` must degrade to defaults, NOT lock
    // every voter out. Regression guard for the 2026-06-15 incident where the
    // missing key produced a permanent fake "60s cooldown" for all voters.
    configHolder.value = null;
    mockRedis.zCard.mockResolvedValue(0);

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(true);
    expect(result.cooldownUntil).toBe(0);
    // Vote recorded under the default sliding windows.
    expect(mockRedis.zAdd).toHaveBeenCalledTimes(3);
  });

  it('still enforces default limits (not unlimited) when config is missing', async () => {
    // Falling back to defaults must not become "allow everything" — a bot that
    // hammers past the default minute cap still trips a cooldown.
    configHolder.value = null;
    mockRedis.pTTL.mockResolvedValueOnce(-2);
    mockRedis.zCard
      .mockResolvedValueOnce(DEFAULT_VOTING_RATE_LIMIT_CONFIG.perMinute) // minute at default cap
      .mockResolvedValueOnce(50) // hour ok
      .mockResolvedValueOnce(50); // day ok

    const result = await checkVotingRateLimit(42);

    expect(result.allowed).toBe(false);
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.stringContaining('PTTL'), {
      keys: ['new-order:rate-limit:cooldown:42'],
      arguments: [(10 * 60 * 1000).toString()],
    });
    expect(mockRedis.zAdd).not.toHaveBeenCalled();
  });
});
