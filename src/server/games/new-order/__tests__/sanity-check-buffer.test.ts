import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression: the HA/Sentinel sysRedis client returns BLOB_STRING replies as a
// Buffer. getSanityCheckImage() reads the sanity-check pool via
// sysRedis.sMembers(...SANITY_CHECKS.POOL) — members are "imageId:nsfwLevel"
// strings — then does `selected.split(':')`. A Buffer has no `.split`, so it
// threw `t.split is not a function`, was swallowed by the surrounding try/catch
// and logged as a sanity-check fetch failure, and returned null → the game's
// anti-cheat sanity injection silently stopped. The read site now coerces every
// member with decodeRedisString (Buffer -> utf8, no-op on string), so the split
// is safe regardless of whether Redis handed back a string or a Buffer.
//
// This exercises the REAL getSanityCheckImage() + the REAL decodeRedisString
// coercion (only sysRedis + dbRead are mocked).

const { mockSysRedis, mockFindUnique, mockHandleLogError, counterStub } = vi.hoisted(() => ({
  mockSysRedis: { sMembers: vi.fn() },
  mockFindUnique: vi.fn(),
  mockHandleLogError: vi.fn(),
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

vi.mock('~/server/redis/client', () => ({
  redis: {},
  sysRedis: mockSysRedis,
  REDIS_KEYS: {},
  REDIS_SYS_KEYS: {
    NEW_ORDER: {
      SANITY_CHECKS: { POOL: 'new-order:sanity-checks:pool' },
    },
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { image: { findUnique: mockFindUnique } },
  dbWrite: {},
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
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: mockHandleLogError,
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
vi.mock('~/server/services/user.service', () => ({ claimCosmetic: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));

// Import AFTER mocks — real decodeRedisString + shuffle stay in play.
import { getSanityCheckImage } from '~/server/services/games/new-order.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue({ url: 'https://example.test/img.jpg', metadata: {} });
});

describe('getSanityCheckImage — BLOB_STRING/Buffer sMembers decoding', () => {
  it('parses a Buffer member without throwing (the t.split is not a function crash)', async () => {
    // Single-element pool → shuffle is deterministic, so the parsed result is exact.
    mockSysRedis.sMembers.mockResolvedValue([Buffer.from('12345:4', 'utf8')]);

    const result = await getSanityCheckImage();

    expect(result).toEqual({
      imageId: 12345,
      nsfwLevel: 4,
      imageUrl: 'https://example.test/img.jpg',
      metadata: {},
    });
    // The failure was swallowed by try/catch → the symptom was a silent null +
    // an error log, never a thrown error. Assert we did NOT hit that path.
    expect(mockHandleLogError).not.toHaveBeenCalled();
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 12345 },
      select: { url: true, metadata: true },
    });
  });

  it('parses a plain string member unchanged (single-node/dev behavior)', async () => {
    mockSysRedis.sMembers.mockResolvedValue(['777:2']);

    const result = await getSanityCheckImage();

    expect(result).toMatchObject({ imageId: 777, nsfwLevel: 2 });
    expect(mockHandleLogError).not.toHaveBeenCalled();
  });

  it('returns null on an empty pool without touching the DB', async () => {
    mockSysRedis.sMembers.mockResolvedValue([]);

    const result = await getSanityCheckImage();

    expect(result).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
