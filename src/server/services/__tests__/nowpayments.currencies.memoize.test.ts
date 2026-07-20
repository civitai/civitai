import { describe, it, expect, vi, beforeEach } from 'vitest';

// Focused test for the in-proc memoization of getSupportedCurrencies (a GLOBAL,
// rarely-changing list). Mocks only what nowpayments.service needs to import;
// the REAL ttl-memoize is used so we exercise the actual memo. Each test
// re-imports the module after vi.resetModules() for a fresh memo slate. TTL
// expiry itself is covered deterministically in ttl-memoize.test.ts.
const { packedGet, packedSet, getMerchantCoins, getFullCurrencies, getMinimumPaymentAmount } =
  vi.hoisted(() => ({
    packedGet: vi.fn(),
    packedSet: vi.fn(),
    getMerchantCoins: vi.fn(),
    getFullCurrencies: vi.fn(),
    getMinimumPaymentAmount: vi.fn(),
  }));

vi.mock('~/env/server', () => ({ env: { NEXTAUTH_URL: 'https://example.test' } }));
vi.mock('../../logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../buzz.service', () => ({
  getMultipliersForUser: vi.fn(),
  getTransactionByExternalId: vi.fn(),
  grantBuzzPurchase: vi.fn(),
}));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({
  default: { getMerchantCoins, getFullCurrencies, getMinimumPaymentAmount },
}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/utils/distributed-lock', () => ({ withDistributedLock: vi.fn() }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: vi.fn() } }));
vi.mock('~/server/common/enums', () => ({
  SignalMessages: { CryptoDepositUpdate: 'x' },
  NotificationCategory: { Buzz: 'buzz' },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/redis/client', () => ({
  redis: { packed: { get: packedGet, set: packedSet } },
  REDIS_KEYS: { CACHES: { SUPPORTED_CRYPTO_CURRENCIES: 'packed:caches:supported-crypto' } },
}));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
vi.mock('~/server/common/chain-config', () => ({
  getChainConfig: vi.fn(),
  getChainForNetworkWithFallback: vi.fn(() => ({ chain: 'eth' })),
  isDepositComplete: vi.fn(),
  outcomeAmountToBuzz: vi.fn(),
}));
// NOTE: ttl-memoize is intentionally NOT mocked — the real memo is under test.

async function loadService() {
  vi.resetModules();
  return import('../nowpayments.service');
}

describe('getSupportedCurrencies in-proc memoize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves a redis-cached list from the in-proc memo, collapsing repeat calls to one GET', async () => {
    const { getSupportedCurrencies } = await loadService();
    const group = [{ ticker: 'btc', name: 'Bitcoin', networks: [] }];
    packedGet.mockResolvedValue(group);

    expect(await getSupportedCurrencies()).toEqual(group);
    expect(await getSupportedCurrencies()).toEqual(group);

    // Within the TTL both calls collapse to a single redis GET, and the upstream
    // NowPayments API is never touched on the cached path.
    expect(packedGet).toHaveBeenCalledTimes(1);
    expect(getMerchantCoins).not.toHaveBeenCalled();
  });

  it('fail-open: an upstream miss returns [] and is NOT memoized (next call retries)', async () => {
    const { getSupportedCurrencies } = await loadService();
    packedGet.mockResolvedValue(null); // force the upstream fetch path
    // First call: upstream unavailable -> [] (not cached).
    getMerchantCoins.mockResolvedValueOnce(null);
    getFullCurrencies.mockResolvedValueOnce(null);

    expect(await getSupportedCurrencies()).toEqual([]);

    // Second call must re-attempt the upstream fetch rather than serve a cached [].
    getMerchantCoins.mockResolvedValueOnce({ selectedCurrencies: [] });
    getFullCurrencies.mockResolvedValueOnce({ currencies: [] });
    expect(await getSupportedCurrencies()).toEqual([]);

    // Two full attempts => the memo did not freeze in the first failure.
    expect(getMerchantCoins).toHaveBeenCalledTimes(2);
  });
});
