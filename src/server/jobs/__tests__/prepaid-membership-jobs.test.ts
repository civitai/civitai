import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
  PrepaidToken,
} from '~/server/schema/subscriptions.schema';

// Inline reimplementation of getPrepaidTokens for the mock — mirrors the real logic
// so tests exercise the job code, not a stub.
const TIER_BUZZ_AMOUNTS: Record<string, number> = {
  bronze: 10000,
  silver: 25000,
  gold: 50000,
};

function fakePrepaidTokens({
  metadata,
}: {
  metadata: SubscriptionMetadata | null | undefined;
}): PrepaidToken[] {
  if (!metadata) return [];

  if (metadata.tokens && metadata.tokens.length > 0) {
    return metadata.tokens;
  }

  const prepaids = metadata.prepaids;
  if (!prepaids) return [];

  const tokens: PrepaidToken[] = [];
  const tiers = ['gold', 'silver', 'bronze'] as const;

  for (const tier of tiers) {
    const count = prepaids[tier] ?? 0;
    if (count <= 0) continue;
    const buzzAmount = TIER_BUZZ_AMOUNTS[tier] ?? 25000;
    for (let i = 0; i < count; i++) {
      tokens.push({
        id: `legacy_${tier}_${i}`,
        tier,
        status: 'locked',
        buzzAmount,
      });
    }
  }
  return tokens;
}

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const {
  mockDbWrite,
  mockDeliverMonthlyCosmetics,
  mockRefreshSession,
  mockGetPrepaidTokens,
} = vi.hoisted(() => {
  const mockCustomerSubscription = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    updateManyAndReturn: vi.fn(),
  };

  const mockProduct = {
    findMany: vi.fn(),
  };

  return {
    mockDbWrite: {
      customerSubscription: mockCustomerSubscription,
      product: mockProduct,
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback({
          customerSubscription: mockCustomerSubscription,
          product: mockProduct,
        });
      }),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
    },
    mockDeliverMonthlyCosmetics: vi.fn().mockResolvedValue(undefined),
    mockRefreshSession: vi.fn().mockResolvedValue(undefined),
    mockGetPrepaidTokens: vi.fn().mockImplementation(fakePrepaidTokens),
  };
});

// Mock modules
vi.mock('~/env/server', () => ({
  env: {
    TIER_METADATA_KEY: 'tier',
    BUZZ_ENDPOINT: 'http://mock-buzz-endpoint',
  },
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  deliverMonthlyCosmetics: mockDeliverMonthlyCosmetics,
}));

vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: mockRefreshSession,
}));

vi.mock('~/server/utils/subscription.utils', () => ({
  getPrepaidTokens: mockGetPrepaidTokens,
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: async (fn: () => Promise<any>, _retries?: number, _delay?: number) => fn(),
}));

// Mock dayjs to use standard dayjs that respects vi.useFakeTimers
vi.mock('~/shared/utils/dayjs', () => {
  const dayjs = require('dayjs');
  return { default: dayjs };
});

// Mock the createJob to return a Job-like object for testing
vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: any) => ({
    name: _name,
    cron: _cron,
    options: { shouldWait: false, lockExpiration: 0 },
    run: (opts?: { req?: any }) => ({
      result: fn({ status: 'running', on: vi.fn(), checkIfCanceled: vi.fn(), req: opts?.req }),
      cancel: vi.fn(),
    }),
  }),
}));

// Factory helpers
interface MockProduct {
  id: string;
  name: string;
  metadata: Partial<SubscriptionProductMetadata>;
  provider: string;
  prices: Array<{ id: string; currency: string; interval: string; active?: boolean }>;
}

const createTierProducts = (): MockProduct[] => [
  {
    id: 'prod_bronze',
    name: 'Bronze Membership',
    metadata: { tier: 'bronze', monthlyBuzz: 10000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_bronze', currency: 'USD', interval: 'month', active: true }],
  },
  {
    id: 'prod_silver',
    name: 'Silver Membership',
    metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_silver', currency: 'USD', interval: 'month', active: true }],
  },
  {
    id: 'prod_gold',
    name: 'Gold Membership',
    metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_gold', currency: 'USD', interval: 'month', active: true }],
  },
];

// Import after mocks
import {
  unlockPrepaidTokens,
  processPrepaidMembershipTransitions,
  cancelExpiredPrepaidMemberships,
} from '~/server/jobs/prepaid-membership-jobs';

describe('prepaid-membership-jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset the mock implementation to the default fake
    mockGetPrepaidTokens.mockImplementation(fakePrepaidTokens);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('unlockPrepaidTokens', () => {
    it('should unlock one token matching the current tier', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'locked', buzzAmount: 50000 },
        { id: 'tok_2', tier: 'gold', status: 'locked', buzzAmount: 50000 },
      ];

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          metadata: { tokens },
          tier: 'gold',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await unlockPrepaidTokens.run({ req: undefined }).result;

      // Should have called $executeRaw to batch-update metadata
      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);

      // Verify the update payload contains exactly one unlocked token
      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const jsonPayload = callArgs[1]; // The interpolated JSON string
      const updates = JSON.parse(jsonPayload);

      expect(updates).toHaveLength(1);
      const updatedMeta = JSON.parse(updates[0].metadata);
      const unlockedTokens = updatedMeta.tokens.filter(
        (t: PrepaidToken) => t.status === 'unlocked'
      );
      const lockedTokens = updatedMeta.tokens.filter(
        (t: PrepaidToken) => t.status === 'locked'
      );
      expect(unlockedTokens).toHaveLength(1);
      expect(lockedTokens).toHaveLength(1);
      expect(unlockedTokens[0].unlockedAt).toContain('2024-01-15');
    });

    it('should skip if a token was already unlocked today (idempotency)', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      const tokens: PrepaidToken[] = [
        {
          id: 'tok_1',
          tier: 'gold',
          status: 'unlocked',
          buzzAmount: 50000,
          unlockedAt: '2024-01-15T00:30:00.000Z',
        },
        { id: 'tok_2', tier: 'gold', status: 'locked', buzzAmount: 50000 },
      ];

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          metadata: { tokens },
          tier: 'gold',
        },
      ]);

      await unlockPrepaidTokens.run({ req: undefined }).result;

      // Should NOT execute any updates since a token was already unlocked today
      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    });

    it('should handle legacy prepaids by synthesizing tokens and decrementing counter', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      // Legacy metadata: no tokens array, only prepaids counters
      const legacyMetadata: SubscriptionMetadata = {
        prepaids: { gold: 3 },
      };

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_legacy',
          userId: 10,
          metadata: legacyMetadata,
          tier: 'gold',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await unlockPrepaidTokens.run({ req: undefined }).result;

      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);

      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const updates = JSON.parse(callArgs[1]);
      const updatedMeta = JSON.parse(updates[0].metadata);

      // Legacy token should be unlocked
      const unlocked = updatedMeta.tokens.filter(
        (t: PrepaidToken) => t.status === 'unlocked'
      );
      expect(unlocked).toHaveLength(1);
      expect(unlocked[0].id).toMatch(/^legacy_/);

      // Legacy prepaids should be cleared — tokens array is now the source of truth
      expect(updatedMeta.prepaids).toEqual({});
    });

    it('should skip tokens that do not match the current tier', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      // User is on silver tier but only has bronze tokens
      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'bronze', status: 'locked', buzzAmount: 10000 },
        { id: 'tok_2', tier: 'bronze', status: 'locked', buzzAmount: 10000 },
      ];

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          metadata: { tokens },
          tier: 'silver',
        },
      ]);

      await unlockPrepaidTokens.run({ req: undefined }).result;

      // No tokens match silver tier, so no updates
      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    });

    it('should handle no memberships gracefully', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([]);

      await unlockPrepaidTokens.run({ req: undefined }).result;

      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
      expect(mockDeliverMonthlyCosmetics).not.toHaveBeenCalled();
    });

    it('should still deliver monthly cosmetics after unlocking tokens', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'locked', buzzAmount: 50000 },
      ];

      mockDbWrite.$queryRaw.mockResolvedValue([
        { id: 'sub_1', userId: 1, metadata: { tokens }, tier: 'gold' },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await unlockPrepaidTokens.run({ req: undefined }).result;

      expect(mockDeliverMonthlyCosmetics).toHaveBeenCalled();
    });

    it('should batch updates when processing many memberships', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      // Create 150 memberships, each with one locked token
      const memberships = Array.from({ length: 150 }, (_, i) => ({
        id: `sub_${i}`,
        userId: i + 1,
        metadata: {
          tokens: [
            { id: `tok_${i}`, tier: 'bronze', status: 'locked', buzzAmount: 10000 },
          ],
        },
        tier: 'bronze',
      }));

      mockDbWrite.$queryRaw.mockResolvedValue(memberships);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 100 });

      await unlockPrepaidTokens.run({ req: undefined }).result;

      // Should batch into chunks of 100: 100 + 50 = 2 calls
      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('processPrepaidMembershipTransitions', () => {
    it('should transition to the best available tier from remaining tokens', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const tierProducts = createTierProducts();

      // User has silver and bronze tokens remaining (gold expired)
      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 },
        { id: 'tok_2', tier: 'silver', status: 'locked', buzzAmount: 25000 },
        { id: 'tok_3', tier: 'bronze', status: 'locked', buzzAmount: 10000 },
      ];

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: { tokens, proratedDays: {} },
        currentPeriodStart: new Date('2023-12-15'),
        currentPeriodEnd: new Date('2024-01-15'),
        product: {
          id: 'prod_gold',
          metadata: { tier: 'gold', monthlyBuzz: 50000 },
        },
        price: { id: 'price_gold', interval: 'month' },
      };

      mockDbWrite.product.findMany.mockResolvedValue(tierProducts);
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);

      // Verify the update targets silver (highest available tier)
      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const jsonPayload = callArgs[1];
      const updates = JSON.parse(jsonPayload);
      expect(updates[0].productId).toBe('prod_silver');
      expect(updates[0].priceId).toBe('price_silver');
    });

    it('should handle prorated days in period calculation', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const tierProducts = createTierProducts();

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'silver', status: 'locked', buzzAmount: 25000 },
      ];

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: {
          tokens,
          proratedDays: { silver: 10 },
        },
        currentPeriodStart: new Date('2023-12-15'),
        currentPeriodEnd: new Date('2024-01-15'),
        product: {
          id: 'prod_gold',
          metadata: { tier: 'gold', monthlyBuzz: 50000 },
        },
        price: { id: 'price_gold', interval: 'month' },
      };

      mockDbWrite.product.findMany.mockResolvedValue(tierProducts);
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const updates = JSON.parse(callArgs[1]);

      // Period should be 1 month (from 1 token) + 10 prorated days
      const periodEnd = new Date(updates[0].currentPeriodEnd);
      const periodStart = new Date(updates[0].currentPeriodStart);
      const diffDays = Math.round(
        (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
      );

      // 1 month (about 29-31 days) + 10 prorated days
      expect(diffDays).toBeGreaterThanOrEqual(39);
      expect(diffDays).toBeLessThanOrEqual(41);

      // Prorated days for silver should be cleared in updated metadata
      const updatedMeta = JSON.parse(updates[0].metadata);
      expect(updatedMeta.proratedDays.silver).toBeUndefined();
    });

    it('should cancel when no tokens and no prorated days remain', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: {
          tokens: [
            { id: 'tok_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 },
          ],
          proratedDays: {},
        },
        currentPeriodStart: new Date('2023-12-15'),
        currentPeriodEnd: new Date('2024-01-15'),
        product: {
          id: 'prod_gold',
          metadata: { tier: 'gold', monthlyBuzz: 50000 },
        },
        price: { id: 'price_gold', interval: 'month' },
      };

      mockDbWrite.product.findMany.mockResolvedValue(createTierProducts());
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const updates = JSON.parse(callArgs[1]);
      expect(updates[0].status).toBe('canceled');
      expect(updates[0].canceledAt).toBeTruthy();
      expect(updates[0].endedAt).toBeTruthy();
    });

    it('should preserve the tokens array in metadata during transition', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const tierProducts = createTierProducts();

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 },
        { id: 'tok_2', tier: 'silver', status: 'locked', buzzAmount: 25000 },
        { id: 'tok_3', tier: 'silver', status: 'locked', buzzAmount: 25000 },
      ];

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: { tokens, proratedDays: {} },
        currentPeriodStart: new Date('2023-12-15'),
        currentPeriodEnd: new Date('2024-01-15'),
        product: {
          id: 'prod_gold',
          metadata: { tier: 'gold', monthlyBuzz: 50000 },
        },
        price: { id: 'price_gold', interval: 'month' },
      };

      mockDbWrite.product.findMany.mockResolvedValue(tierProducts);
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const updates = JSON.parse(callArgs[1]);
      const updatedMeta = JSON.parse(updates[0].metadata);

      // All original tokens should be preserved in the metadata
      expect(updatedMeta.tokens).toHaveLength(3);
      expect(updatedMeta.tokens[0].id).toBe('tok_1');
      expect(updatedMeta.tokens[0].status).toBe('claimed');
      expect(updatedMeta.tokens[1].status).toBe('locked');
    });

    it('should transition to silver via prorated days even with no silver tokens (only bronze tokens)', async () => {
      // Scenario: Gold membership expires. User has bronze tokens and silver prorated days but NO silver tokens.
      // Should land on silver (prorated days) not bronze (tokens), and NOT unlock any tokens.
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const tierProducts = createTierProducts();

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 },
        { id: 'tok_2', tier: 'bronze', status: 'locked', buzzAmount: 10000 },
        { id: 'tok_3', tier: 'bronze', status: 'locked', buzzAmount: 10000 },
      ];

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: {
          tokens,
          proratedDays: { silver: 15 }, // 15 prorated silver days, no silver tokens
        },
        currentPeriodStart: new Date('2023-12-15'),
        currentPeriodEnd: new Date('2024-01-15'),
        product: {
          id: 'prod_gold',
          metadata: { tier: 'gold', monthlyBuzz: 50000 },
        },
        price: { id: 'price_gold', interval: 'month' },
      };

      mockDbWrite.product.findMany.mockResolvedValue(tierProducts);
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);

      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const updates = JSON.parse(callArgs[1]);

      // Should transition to silver (higher tier with prorated days) not bronze (lower tier with tokens)
      expect(updates[0].productId).toBe('prod_silver');
      expect(updates[0].priceId).toBe('price_silver');

      // Period should be 0 months (no silver tokens) + 15 prorated days = 15 days
      const periodEnd = new Date(updates[0].currentPeriodEnd);
      const periodStart = new Date(updates[0].currentPeriodStart);
      const diffDays = Math.round(
        (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(diffDays).toBe(15);

      // Silver prorated days should be cleared after use
      const updatedMeta = JSON.parse(updates[0].metadata);
      expect(updatedMeta.proratedDays.silver).toBeUndefined();

      // Bronze tokens should still be preserved for future transition
      const bronzeTokens = updatedMeta.tokens.filter((t: PrepaidToken) => t.tier === 'bronze');
      expect(bronzeTokens).toHaveLength(2);
      expect(bronzeTokens.every((t: PrepaidToken) => t.status === 'locked')).toBe(true);
    });

    it('should add 1 month per token when transitioning to next tier with tokens', async () => {
      // Scenario: Gold membership expires. User has 3 silver tokens.
      // Should transition to silver with currentPeriodEnd = now + 3 months.
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const tierProducts = createTierProducts();

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 },
        { id: 'tok_2', tier: 'silver', status: 'locked', buzzAmount: 25000 },
        { id: 'tok_3', tier: 'silver', status: 'locked', buzzAmount: 25000 },
        { id: 'tok_4', tier: 'silver', status: 'locked', buzzAmount: 25000 },
      ];

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: { tokens, proratedDays: {} },
        currentPeriodStart: new Date('2023-12-15'),
        currentPeriodEnd: new Date('2024-01-15'),
        product: {
          id: 'prod_gold',
          metadata: { tier: 'gold', monthlyBuzz: 50000 },
        },
        price: { id: 'price_gold', interval: 'month' },
      };

      mockDbWrite.product.findMany.mockResolvedValue(tierProducts);
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);

      const callArgs = mockDbWrite.$executeRaw.mock.calls[0];
      const updates = JSON.parse(callArgs[1]);

      // Should transition to silver
      expect(updates[0].productId).toBe('prod_silver');
      expect(updates[0].priceId).toBe('price_silver');

      // Period should be 3 months from now (3 silver tokens = 3 months)
      const periodEnd = new Date(updates[0].currentPeriodEnd);
      const periodStart = new Date(updates[0].currentPeriodStart);
      const diffDays = Math.round(
        (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
      );
      // 3 months from Jan 15 = Apr 15 = ~90 days (89-91 depending on Feb length)
      expect(diffDays).toBeGreaterThanOrEqual(89);
      expect(diffDays).toBeLessThanOrEqual(91);

      // All tokens should be preserved in metadata
      const updatedMeta = JSON.parse(updates[0].metadata);
      expect(updatedMeta.tokens).toHaveLength(4);
      // Gold token still claimed, silver tokens still locked (unlock job handles unlocking later)
      expect(updatedMeta.tokens.find((t: PrepaidToken) => t.id === 'tok_1').status).toBe('claimed');
      expect(updatedMeta.tokens.filter((t: PrepaidToken) => t.tier === 'silver' && t.status === 'locked')).toHaveLength(3);
    });

    it('should not process if no expiring memberships', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      mockDbWrite.product.findMany.mockResolvedValue(createTierProducts());
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);

      await processPrepaidMembershipTransitions.run().result;

      expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('cancelExpiredPrepaidMemberships', () => {
    it('should query both active and expired_claimable statuses', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: ['active', 'expired_claimable'] },
            currentPeriodEnd: { lt: expect.any(Date) },
          }),
        })
      );
    });

    it('should set expired_claimable when unclaimed tokens exist and unlock locked ones', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'locked', buzzAmount: 50000 },
        { id: 'tok_2', tier: 'gold', status: 'unlocked', buzzAmount: 50000, unlockedAt: '2024-01-14T01:00:00Z' },
        { id: 'tok_3', tier: 'gold', status: 'claimed', buzzAmount: 50000, claimedAt: '2024-01-13T00:00:00Z' },
      ];

      const expiredMembership = {
        id: 'sub_1',
        userId: 1,
        status: 'active',
        metadata: { tokens },
        currentPeriodEnd: new Date('2024-01-14'),
      };

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiredMembership]);
      mockDbWrite.customerSubscription.update.mockResolvedValue({});

      await cancelExpiredPrepaidMemberships.run().result;

      // Should call update (not updateMany) for expired_claimable transition
      expect(mockDbWrite.customerSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub_1' },
          data: expect.objectContaining({
            status: 'expired_claimable',
          }),
        })
      );

      // Verify locked tokens were unlocked in the metadata
      const updateCall = mockDbWrite.customerSubscription.update.mock.calls[0][0];
      const updatedMeta = updateCall.data.metadata as SubscriptionMetadata;
      const updatedTokens = updatedMeta.tokens!;

      // The previously locked token should now be unlocked
      const tok1 = updatedTokens.find((t: PrepaidToken) => t.id === 'tok_1')!;
      expect(tok1.status).toBe('unlocked');
      expect(tok1.unlockedAt).toBeTruthy();

      // The already unlocked token should remain unlocked
      const tok2 = updatedTokens.find((t: PrepaidToken) => t.id === 'tok_2')!;
      expect(tok2.status).toBe('unlocked');

      // The claimed token should remain claimed
      const tok3 = updatedTokens.find((t: PrepaidToken) => t.id === 'tok_3')!;
      expect(tok3.status).toBe('claimed');
    });

    it('should cancel when no unclaimed tokens remain', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const tokens: PrepaidToken[] = [
        { id: 'tok_1', tier: 'gold', status: 'claimed', buzzAmount: 50000, claimedAt: '2024-01-10T00:00:00Z' },
      ];

      const expiredMembership = {
        id: 'sub_1',
        userId: 1,
        status: 'active',
        metadata: { tokens },
        currentPeriodEnd: new Date('2024-01-14'),
      };

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiredMembership]);
      mockDbWrite.customerSubscription.updateMany.mockResolvedValue({ count: 1 });

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['sub_1'] } },
          data: expect.objectContaining({
            status: 'canceled',
            canceledAt: expect.any(Date),
            endedAt: expect.any(Date),
          }),
        })
      );
    });

    it('should handle multiple memberships with different token states', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const memberships = [
        {
          id: 'sub_1',
          userId: 1,
          status: 'active',
          metadata: {
            tokens: [
              { id: 'tok_a', tier: 'gold', status: 'locked', buzzAmount: 50000 },
            ],
          },
          currentPeriodEnd: new Date('2024-01-14'),
        },
        {
          id: 'sub_2',
          userId: 2,
          status: 'active',
          metadata: {
            tokens: [
              { id: 'tok_b', tier: 'silver', status: 'claimed', buzzAmount: 25000, claimedAt: '2024-01-10T00:00:00Z' },
            ],
          },
          currentPeriodEnd: new Date('2024-01-13'),
        },
        {
          id: 'sub_3',
          userId: 3,
          status: 'active',
          metadata: {
            tokens: [
              { id: 'tok_c', tier: 'bronze', status: 'unlocked', buzzAmount: 10000, unlockedAt: '2024-01-12T00:00:00Z' },
            ],
          },
          currentPeriodEnd: new Date('2024-01-10'),
        },
      ];

      mockDbWrite.customerSubscription.findMany.mockResolvedValue(memberships);
      mockDbWrite.customerSubscription.update.mockResolvedValue({});
      mockDbWrite.customerSubscription.updateMany.mockResolvedValue({ count: 1 });

      await cancelExpiredPrepaidMemberships.run().result;

      // sub_1 (locked token) and sub_3 (unlocked token) -> expired_claimable
      expect(mockDbWrite.customerSubscription.update).toHaveBeenCalledTimes(2);

      // sub_2 (all claimed) -> canceled
      expect(mockDbWrite.customerSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['sub_2'] } },
        })
      );
    });

    it('should refresh sessions for all affected users', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const memberships = [
        {
          id: 'sub_1',
          userId: 1,
          status: 'active',
          metadata: {
            tokens: [
              { id: 'tok_a', tier: 'gold', status: 'claimed', buzzAmount: 50000, claimedAt: '2024-01-10T00:00:00Z' },
            ],
          },
          currentPeriodEnd: new Date('2024-01-14'),
        },
        {
          id: 'sub_2',
          userId: 2,
          status: 'active',
          metadata: {
            tokens: [
              { id: 'tok_b', tier: 'silver', status: 'locked', buzzAmount: 25000 },
            ],
          },
          currentPeriodEnd: new Date('2024-01-13'),
        },
      ];

      mockDbWrite.customerSubscription.findMany.mockResolvedValue(memberships);
      mockDbWrite.customerSubscription.update.mockResolvedValue({});
      mockDbWrite.customerSubscription.updateMany.mockResolvedValue({ count: 1 });

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockRefreshSession).toHaveBeenCalledWith(1);
      expect(mockRefreshSession).toHaveBeenCalledWith(2);
      expect(mockRefreshSession).toHaveBeenCalledTimes(2);
    });

    it('should not re-process memberships already in expired_claimable state', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const membership = {
        id: 'sub_1',
        userId: 1,
        status: 'expired_claimable',
        metadata: {
          tokens: [
            { id: 'tok_1', tier: 'gold', status: 'unlocked', buzzAmount: 50000, unlockedAt: '2024-01-14T00:00:00Z' },
          ],
        },
        currentPeriodEnd: new Date('2024-01-14'),
      };

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([membership]);

      await cancelExpiredPrepaidMemberships.run().result;

      // Should NOT call update for expired_claimable since it's already in that state
      expect(mockDbWrite.customerSubscription.update).not.toHaveBeenCalled();
      // Should NOT call updateMany either since no memberships need canceling
      expect(mockDbWrite.customerSubscription.updateMany).not.toHaveBeenCalled();
    });

    it('should not run if no expired memberships', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.update).not.toHaveBeenCalled();
      expect(mockDbWrite.customerSubscription.updateMany).not.toHaveBeenCalled();
      expect(mockRefreshSession).not.toHaveBeenCalled();
    });
  });
});
