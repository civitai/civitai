import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import { MIN_CREATOR_SCORE } from '~/shared/constants/creator-program.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';

// ── Hoisted mocks ──────────────────────────────────────────────────────────────
const {
  mockDbWrite,
  mockClickhouse,
  mockCreateBuzzTransaction,
  mockGetCounterPartyBuzzTransactions,
  mockGetUserBuzzAccount,
  mockGetTopContributors,
  mockRefundTransaction,
  mockCreateNotification,
  mockPayToTipaltiAccount,
  mockSignalClient,
  mockSysRedis,
  mockFetchThroughCache,
  mockBustFetchThroughCache,
  mockClearCacheByPattern,
  mockCachedObject,
  mockCreateCachedObject,
} = vi.hoisted(() => {
  const mockCachedObject = {
    fetch: vi.fn().mockResolvedValue({}),
    bust: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };

  return {
    mockDbWrite: {
      user: { findFirstOrThrow: vi.fn(), findFirst: vi.fn() },
      customerSubscription: { findFirst: vi.fn() },
      cashWithdrawal: {
        findMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      userPaymentConfiguration: { findUnique: vi.fn() },
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
    },
    mockClickhouse: {
      $query: vi.fn().mockResolvedValue([]),
    },
    mockCreateBuzzTransaction: vi.fn().mockResolvedValue({ transactionId: 'tx-123' }),
    mockGetCounterPartyBuzzTransactions: vi.fn().mockResolvedValue({
      counterPartyAccountType: 'yellow',
      totalBalance: 0,
    }),
    mockGetUserBuzzAccount: vi.fn().mockResolvedValue([{ balance: 0 }]),
    mockGetTopContributors: vi.fn().mockResolvedValue({}),
    mockRefundTransaction: vi.fn().mockResolvedValue(undefined),
    mockCreateNotification: vi.fn().mockResolvedValue(undefined),
    mockPayToTipaltiAccount: vi.fn().mockResolvedValue({
      paymentBatchId: 'batch-1',
      paymentRefCode: 'ref-1',
    }),
    mockSignalClient: { topicSend: vi.fn() },
    mockSysRedis: { get: vi.fn().mockResolvedValue(null) },
    mockFetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
    mockBustFetchThroughCache: vi.fn().mockResolvedValue(undefined),
    mockClearCacheByPattern: vi.fn().mockResolvedValue(undefined),
    mockCachedObject,
    mockCreateCachedObject: vi.fn(() => mockCachedObject),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────────────
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: mockClickhouse }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mockCreateBuzzTransaction,
  createMultiAccountBuzzTransaction: vi.fn(),
  getCounterPartyBuzzTransactions: mockGetCounterPartyBuzzTransactions,
  getUserBuzzAccount: mockGetUserBuzzAccount,
  getTopContributors: mockGetTopContributors,
  refundTransaction: mockRefundTransaction,
  getAccountsBalances: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/user-payment-configuration.service', () => ({
  payToTipaltiAccount: mockPayToTipaltiAccount,
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: mockFetchThroughCache,
  bustFetchThroughCache: mockBustFetchThroughCache,
  clearCacheByPattern: mockClearCacheByPattern,
  createCachedObject: mockCreateCachedObject,
}));
vi.mock('~/server/redis/client', () => ({
  REDIS_KEYS: {
    CREATOR_PROGRAM: {
      CAPS: 'cp:caps',
      BANKED: 'cp:banked',
      CASH: 'cp:cash',
      POOL_VALUE: 'cp:pool-value',
      POOL_SIZE: 'cp:pool-size',
      POOL_FORECAST: 'cp:pool-forecast',
      PREV_MONTH_STATS: 'cp:prev-month-stats',
    },
  },
  REDIS_SYS_KEYS: { CREATOR_PROGRAM: { FLIP_PHASES: 'cp:flip' } },
  sysRedis: mockSysRedis,
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: mockSignalClient }));
vi.mock('~/server/prom/client', () => ({ userUpdateCounter: { inc: vi.fn() } }));
vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

// ── Import the service under test ──────────────────────────────────────────────
import {
  bankBuzz,
  extractBuzz,
  getBanked,
  getCompensationPool,
  getCreatorRequirements,
  joinCreatorsProgram,
  withdrawCash,
} from '~/server/services/creator-program.service';

// ── Helpers ────────────────────────────────────────────────────────────────────
const userId = 42;
const defaultCap = {
  id: userId,
  definition: { tier: 'silver' as const, limit: 1000000, percentOfPeakEarning: 1.25 },
  peakEarning: { month: new Date(), earned: 500000 },
  cap: 625000,
};

function mockUser(overrides: Record<string, any> = {}) {
  return { id: userId, onboarding: 0, ...overrides };
}

/** Set up the cap cache mock to return a valid cap for the user */
function mockCapCache() {
  mockCachedObject.fetch.mockResolvedValue({ [userId]: defaultCap });
}

/** Mock getBanked counterparty responses for green then yellow (buzzBankTypes order) */
function mockBankedAmounts(green: number, yellow: number) {
  mockGetCounterPartyBuzzTransactions
    .mockResolvedValueOnce({ counterPartyAccountType: 'green', totalBalance: green })
    .mockResolvedValueOnce({ counterPartyAccountType: 'yellow', totalBalance: yellow });
}

// ── Tests ──────────────────────────────────────────────────────────────────────
// Pin time to mid-month so both banking (1st-27th) and (flipped) extraction
// (1st-27th) phases are open during tests. The default getPhases logic puts
// extraction in the last 3 days of the month; running tests near month-end
// flips banking closed and breaks every bank/extract test otherwise.
beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSysRedis.get.mockResolvedValue(null);
  // Default fetchThroughCache: just call the function
  mockFetchThroughCache.mockImplementation(
    async (_key: string, fn: () => Promise<any>) => fn()
  );
});

// ─── getCreatorRequirements ────────────────────────────────────────────────────
describe('getCreatorRequirements', () => {
  it('returns score and membership', async () => {
    mockDbWrite.$queryRaw.mockResolvedValueOnce([
      { score: MIN_CREATOR_SCORE + 1000, membership: 'silver' },
    ]);

    const result = await getCreatorRequirements(userId);

    expect(result.score.current).toBe(MIN_CREATOR_SCORE + 1000);
    expect(result.membership).toBe('silver');
    expect(result.validMembership).toBe('silver');
  });

  it('returns validMembership=false for free tier', async () => {
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ score: 5000, membership: 'free' }]);

    const result = await getCreatorRequirements(userId);

    expect(result.membership).toBeUndefined();
    expect(result.validMembership).toBe(false);
  });

  it('returns validMembership=false for founder tier', async () => {
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ score: 20000, membership: 'founder' }]);

    const result = await getCreatorRequirements(userId);

    expect(result.membership).toBe('founder');
    expect(result.validMembership).toBe(false);
  });
});

// ─── joinCreatorsProgram ───────────────────────────────────────────────────────
describe('joinCreatorsProgram', () => {
  it('succeeds when requirements are met', async () => {
    // getCreatorRequirements query
    mockDbWrite.$queryRaw.mockResolvedValueOnce([
      { score: MIN_CREATOR_SCORE + 1000, membership: 'silver' },
    ]);
    mockDbWrite.user.findFirstOrThrow.mockResolvedValueOnce(mockUser());
    mockDbWrite.$executeRaw.mockResolvedValueOnce(undefined);

    await expect(joinCreatorsProgram(userId)).resolves.not.toThrow();
    expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
  });

  it('rejects users without a valid membership', async () => {
    mockDbWrite.$queryRaw.mockResolvedValueOnce([
      { score: MIN_CREATOR_SCORE + 1000, membership: 'free' },
    ]);

    await expect(joinCreatorsProgram(userId)).rejects.toThrow();
  });

  it('rejects users with insufficient creator score', async () => {
    mockDbWrite.$queryRaw.mockResolvedValueOnce([{ score: 100, membership: 'silver' }]);

    await expect(joinCreatorsProgram(userId)).rejects.toThrow();
  });

  it('rejects banned users', async () => {
    mockDbWrite.$queryRaw.mockResolvedValueOnce([
      { score: MIN_CREATOR_SCORE + 1000, membership: 'silver' },
    ]);
    mockDbWrite.user.findFirstOrThrow.mockResolvedValueOnce(
      mockUser({ onboarding: OnboardingSteps.BannedCreatorProgram })
    );

    await expect(joinCreatorsProgram(userId)).rejects.toThrow();
  });
});

// ─── getBanked ─────────────────────────────────────────────────────────────────
describe('getBanked', () => {
  it('returns per-type banked amounts and combined total', async () => {
    mockCapCache();
    mockBankedAmounts(30000, 50000);

    const result = await getBanked(userId);

    expect(result.perType.green).toBe(30000);
    expect(result.perType.yellow).toBe(50000);
    expect(result.total).toBe(80000);
    // Both types queried against the same creatorProgramBank account
    expect(mockGetCounterPartyBuzzTransactions).toHaveBeenCalledTimes(2);
    const calls = mockGetCounterPartyBuzzTransactions.mock.calls;
    expect(calls[0][0].accountType).toBe('creatorProgramBank');
    expect(calls[1][0].accountType).toBe('creatorProgramBank');
  });

  it('returns unified cap from highest membership tier', async () => {
    mockCapCache();
    mockBankedAmounts(0, 0);

    const result = await getBanked(userId);

    expect(result.cap).toBeDefined();
    expect(result.cap.cap).toBe(defaultCap.cap);
  });
});

// ─── bankBuzz ──────────────────────────────────────────────────────────────────
describe('bankBuzz', () => {
  beforeEach(() => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValue(mockUser());
    mockDbWrite.customerSubscription.findFirst.mockResolvedValue({ id: 1 });
    mockCapCache();
    mockBankedAmounts(0, 0);

    // getCompensationPool mocks (called after banking for signal)
    mockClickhouse.$query.mockResolvedValue([{ balance: 35000 }]);
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 100000 }]);
  });

  it('banks yellow buzz into creatorProgramBank', async () => {
    await bankBuzz(userId, 10000, 'yellow');

    expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 10000,
        fromAccountId: userId,
        fromAccountType: 'yellow',
        toAccountType: 'creatorProgramBank',
        type: TransactionType.Bank,
      })
    );
  });

  it('banks green buzz into creatorProgramBank (same unified account)', async () => {
    await bankBuzz(userId, 10000, 'green');

    expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountType: 'green',
        toAccountType: 'creatorProgramBank',
        type: TransactionType.Bank,
      })
    );
  });

  it('rejects blue buzz', async () => {
    await expect(bankBuzz(userId, 10000, 'blue')).rejects.toThrow();
  });

  it('rejects banned users', async () => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValueOnce(
      mockUser({ onboarding: OnboardingSteps.BannedCreatorProgram })
    );

    await expect(bankBuzz(userId, 10000, 'yellow')).rejects.toThrow();
  });

  it('rejects users without active membership', async () => {
    mockDbWrite.customerSubscription.findFirst.mockResolvedValueOnce(null);

    await expect(bankBuzz(userId, 10000, 'yellow')).rejects.toThrow();
  });

  it('caps amount to remaining cap', async () => {
    // Override the beforeEach mocks: user already banked 620000 of 625000 cap
    mockGetCounterPartyBuzzTransactions.mockReset();
    mockGetCounterPartyBuzzTransactions
      .mockResolvedValueOnce({ counterPartyAccountType: 'green', totalBalance: 0 })
      .mockResolvedValueOnce({ counterPartyAccountType: 'yellow', totalBalance: 620000 });

    await bankBuzz(userId, 50000, 'yellow');

    // Should only bank 5000 (625000 - 620000)
    expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 5000 })
    );
  });

  it('busts banked and pool size caches after banking', async () => {
    await bankBuzz(userId, 10000, 'yellow');

    expect(mockBustFetchThroughCache).toHaveBeenCalledWith(`cp:banked:${userId}`);
    expect(mockBustFetchThroughCache).toHaveBeenCalledWith('cp:pool-size');
  });

  it('sends compensation pool update signal after banking', async () => {
    await bankBuzz(userId, 10000, 'yellow');

    expect(mockSignalClient.topicSend).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'creators-program:compensation-pool-update',
      })
    );
  });
});

// ─── extractBuzz ───────────────────────────────────────────────────────────────
describe('extractBuzz', () => {
  beforeEach(() => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValue(mockUser());
    mockCapCache();
    // Flip phases so extraction is active now
    mockSysRedis.get.mockResolvedValue('true');

    // getCompensationPool mocks (called after extraction for signal)
    mockClickhouse.$query.mockResolvedValue([{ balance: 35000 }]);
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 100000 }]);
  });

  it('extracts all banked buzz types back to their original type', async () => {
    mockBankedAmounts(30000, 50000);

    await extractBuzz(userId);

    // Should create extract transactions for both types
    const extractCalls = mockCreateBuzzTransaction.mock.calls.filter(
      (call: any[]) => call[0].type === TransactionType.Extract
    );
    expect(extractCalls).toHaveLength(2);

    // Green buzz goes back to green account
    const greenExtract = extractCalls.find((c: any[]) => c[0].toAccountType === 'green');
    expect(greenExtract).toBeDefined();
    expect(greenExtract![0].amount).toBe(30000);
    expect(greenExtract![0].fromAccountType).toBe('creatorProgramBank');

    // Yellow buzz goes back to yellow account
    const yellowExtract = extractCalls.find((c: any[]) => c[0].toAccountType === 'yellow');
    expect(yellowExtract).toBeDefined();
    expect(yellowExtract![0].amount).toBe(50000);
    expect(yellowExtract![0].fromAccountType).toBe('creatorProgramBank');
  });

  it('does nothing when no buzz is banked', async () => {
    mockBankedAmounts(0, 0);

    await extractBuzz(userId);

    expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
  });

  it('rejects banned users', async () => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValueOnce(
      mockUser({ onboarding: OnboardingSteps.BannedCreatorProgram })
    );

    await expect(extractBuzz(userId)).rejects.toThrow();
  });

  it('no fee when total is within free tier (100k)', async () => {
    mockBankedAmounts(0, 100000);

    await extractBuzz(userId);

    const feeCalls = mockCreateBuzzTransaction.mock.calls.filter(
      (call: any[]) => call[0].type === TransactionType.Fee
    );
    expect(feeCalls).toHaveLength(0);
  });

  it('charges extraction fee when above free tier', async () => {
    // 200k yellow — first 100k free, next 100k at 5% = 5000 fee
    mockBankedAmounts(0, 200000);

    await extractBuzz(userId);

    const feeCalls = mockCreateBuzzTransaction.mock.calls.filter(
      (call: any[]) => call[0].type === TransactionType.Fee
    );
    expect(feeCalls).toHaveLength(1);
    expect(feeCalls[0][0].amount).toBe(5000);
    expect(feeCalls[0][0].fromAccountType).toBe('yellow');
  });

  it('distributes extraction fee proportionally across types', async () => {
    // 100k green + 200k yellow = 300k total
    // Fee on 300k: first 100k free, next 200k at 5% = 10000
    mockBankedAmounts(100000, 200000);

    await extractBuzz(userId);

    const feeCalls = mockCreateBuzzTransaction.mock.calls.filter(
      (call: any[]) => call[0].type === TransactionType.Fee
    );
    // Should have fees from both types proportionally
    expect(feeCalls.length).toBeGreaterThanOrEqual(1);
    const totalFee = feeCalls.reduce((sum: number, c: any[]) => sum + c[0].amount, 0);
    expect(totalFee).toBe(10000);
  });

  it('busts caches after extraction', async () => {
    mockBankedAmounts(0, 50000);

    await extractBuzz(userId);

    expect(mockBustFetchThroughCache).toHaveBeenCalledWith(`cp:banked:${userId}`);
    expect(mockBustFetchThroughCache).toHaveBeenCalledWith('cp:pool-size');
  });
});

// ─── getCompensationPool ───────────────────────────────────────────────────────
describe('getCompensationPool', () => {
  it('returns unified pool value, size, and phases for a specific month', async () => {
    mockClickhouse.$query
      .mockResolvedValueOnce([{ balance: 50000 }]) // pool value
      .mockResolvedValueOnce([{ balance: 2000000 }]); // pool forecast
    mockGetUserBuzzAccount.mockResolvedValueOnce([{ balance: 1000000 }]); // pool size

    const result = await getCompensationPool({ month: new Date('2025-04-01') });

    expect(result.value).toBeDefined();
    expect(result.size.current).toBe(1000000);
    expect(result.phases).toBeDefined();
    expect(result.phases.bank).toBeDefined();
    expect(result.phases.extraction).toBeDefined();
  });

  it('uses cache for current month queries', async () => {
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 0 }]);
    mockClickhouse.$query.mockResolvedValue([{ balance: 0 }]);

    await getCompensationPool({});

    // fetchThroughCache should be called for pool value and forecast (not size)
    expect(mockFetchThroughCache).toHaveBeenCalledWith(
      'cp:pool-value',
      expect.any(Function),
      expect.any(Object)
    );
    expect(mockFetchThroughCache).toHaveBeenCalledWith(
      'cp:pool-forecast',
      expect.any(Function),
      expect.any(Object)
    );
  });
});

// ─── withdrawCash ──────────────────────────────────────────────────────────────
describe('withdrawCash', () => {
  beforeEach(() => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValue(mockUser());
    mockDbWrite.userPaymentConfiguration.findUnique.mockResolvedValue({
      userId,
      tipaltiPaymentsEnabled: true,
      tipaltiWithdrawalMethod: 'Wire',
    });
    mockDbWrite.cashWithdrawal.create.mockResolvedValue({ id: 'withdrawal-1' });
  });

  it('rejects banned users', async () => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValueOnce(
      mockUser({ onboarding: OnboardingSteps.BannedCreatorProgram })
    );

    await expect(withdrawCash(userId, 10000)).rejects.toThrow();
  });

  it('rejects amounts below minimum', async () => {
    // getCash uses userCashCache (createCachedObject), not fetchThroughCache
    mockCachedObject.fetch.mockResolvedValueOnce({
      [userId]: {
        id: userId,
        status: 'ready',
        ready: 100000,
        pending: 0,
        withdrawn: 0,
        paymentMethod: 'Wire',
      },
    });

    await expect(withdrawCash(userId, 100)).rejects.toThrow('below minimum');
  });

  it('rejects users without payment setup', async () => {
    mockCachedObject.fetch.mockResolvedValueOnce({
      [userId]: {
        id: userId,
        status: 'ready',
        ready: 100000,
        pending: 0,
        withdrawn: 0,
        paymentMethod: 'Wire',
      },
    });
    mockDbWrite.userPaymentConfiguration.findUnique.mockResolvedValueOnce({
      userId,
      tipaltiPaymentsEnabled: false,
      tipaltiWithdrawalMethod: 'Wire',
    });

    await expect(withdrawCash(userId, 10000)).rejects.toThrow('not payable');
  });
});

// ─── Unified pool invariants ───────────────────────────────────────────────────
describe('unified pool invariants', () => {
  beforeEach(() => {
    mockDbWrite.user.findFirstOrThrow.mockResolvedValue(mockUser());
    mockDbWrite.customerSubscription.findFirst.mockResolvedValue({ id: 1 });
    mockCapCache();
    mockBankedAmounts(0, 0);
    mockClickhouse.$query.mockResolvedValue([{ balance: 35000 }]);
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 100000 }]);
  });

  it('both yellow and green buzz bank into creatorProgramBank', async () => {
    await bankBuzz(userId, 10000, 'green');

    expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountType: 'green',
        toAccountType: 'creatorProgramBank',
        type: TransactionType.Bank,
      })
    );

    vi.clearAllMocks();
    mockDbWrite.user.findFirstOrThrow.mockResolvedValue(mockUser());
    mockDbWrite.customerSubscription.findFirst.mockResolvedValue({ id: 1 });
    mockCapCache();
    mockBankedAmounts(0, 0);
    mockClickhouse.$query.mockResolvedValue([{ balance: 35000 }]);
    mockGetUserBuzzAccount.mockResolvedValue([{ balance: 100000 }]);

    await bankBuzz(userId, 10000, 'yellow');

    expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountType: 'yellow',
        toAccountType: 'creatorProgramBank',
        type: TransactionType.Bank,
      })
    );
  });

  it('pool size queries single creatorProgramBank account', async () => {
    mockClickhouse.$query
      .mockResolvedValueOnce([{ balance: 35000 }])
      .mockResolvedValueOnce([{ balance: 1000000 }]);
    mockGetUserBuzzAccount.mockResolvedValueOnce([{ balance: 500000 }]);

    const pool = await getCompensationPool({ month: new Date('2025-04-01') });

    expect(mockGetUserBuzzAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountType: 'creatorProgramBank',
      })
    );
    expect(pool.size.current).toBe(500000);
  });

  it('extraction refunds each buzz type to its original account', async () => {
    // Flip phases so extraction is active now (covers start of month to L-3)
    mockSysRedis.get.mockResolvedValue('true');
    mockCapCache();
    // Need fresh counterparty mocks (beforeEach ones may be consumed by bankBuzz tests)
    mockGetCounterPartyBuzzTransactions.mockReset();
    mockGetCounterPartyBuzzTransactions
      .mockResolvedValueOnce({ counterPartyAccountType: 'green', totalBalance: 20000 })
      .mockResolvedValueOnce({ counterPartyAccountType: 'yellow', totalBalance: 80000 });

    await extractBuzz(userId);

    const allCalls = mockCreateBuzzTransaction.mock.calls;
    const extractCalls = allCalls.filter(
      (call: any[]) => call[0].type === TransactionType.Extract
    );

    expect(extractCalls).toHaveLength(2);
    const greenRefund = extractCalls.find((c: any[]) => c[0].toAccountType === 'green');
    const yellowRefund = extractCalls.find((c: any[]) => c[0].toAccountType === 'yellow');

    expect(greenRefund![0].amount).toBe(20000);
    expect(yellowRefund![0].amount).toBe(80000);
  });
});
