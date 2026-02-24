import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const {
  mockDbWrite,
  mockCreateBuzzTransactionMany,
  mockDeliverMonthlyCosmetics,
  mockRefreshSession,
} = vi.hoisted(() => {
  const mockCustomerSubscription = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
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
    mockCreateBuzzTransactionMany: vi.fn().mockResolvedValue({ success: true }),
    mockDeliverMonthlyCosmetics: vi.fn().mockResolvedValue(undefined),
    mockRefreshSession: vi.fn().mockResolvedValue(undefined),
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

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  deliverMonthlyCosmetics: mockDeliverMonthlyCosmetics,
}));

vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: mockRefreshSession,
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: async (fn: () => Promise<any>, _retries?: number, _delay?: number) => fn(),
}));

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

// Factory functions for creating test data
interface MockProduct {
  id: string;
  name: string;
  metadata: Partial<SubscriptionProductMetadata>;
  provider: string;
  prices?: MockPrice[];
}

interface MockPrice {
  id: string;
  currency: string;
  interval: string;
  product?: MockProduct;
}

const createTierProducts = (): MockProduct[] => [
  {
    id: 'prod_bronze',
    name: 'Bronze Membership',
    metadata: { tier: 'bronze', monthlyBuzz: 10000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_bronze', currency: 'USD', interval: 'month' }],
  },
  {
    id: 'prod_silver',
    name: 'Silver Membership',
    metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_silver', currency: 'USD', interval: 'month' }],
  },
  {
    id: 'prod_gold',
    name: 'Gold Membership',
    metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_gold', currency: 'USD', interval: 'month' }],
  },
];

// Import after mocks
import {
  deliverPrepaidMembershipBuzz,
  processPrepaidMembershipTransitions,
  cancelExpiredPrepaidMemberships,
} from '~/server/jobs/prepaid-membership-jobs';

describe('prepaid-membership-jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('deliverPrepaidMembershipBuzz', () => {
    it('should select only users with prepaids > 0 and grant buzz', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          buzzAmount: '50000',
          productId: 'prod_gold',
          priceId: 'price_gold',
          interval: 'month',
          tier: 'gold',
          buzzType: 'yellow',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith([
        expect.objectContaining({
          toAccountId: 1,
          amount: 50000,
          toAccountType: 'yellow',
        }),
      ]);
    });

    it('should not run if no membership holders found', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([]);

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      expect(mockCreateBuzzTransactionMany).not.toHaveBeenCalled();
    });

    it('should grant correct monthlyBuzz amount from product metadata', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          buzzAmount: '25000',
          productId: 'prod_silver',
          priceId: 'price_silver',
          interval: 'month',
          tier: 'silver',
          buzzType: 'yellow',
        },
        {
          id: 'sub_2',
          userId: 2,
          buzzAmount: '10000',
          productId: 'prod_bronze',
          priceId: 'price_bronze',
          interval: 'month',
          tier: 'bronze',
          buzzType: 'yellow',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 2 });

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ toAccountId: 1, amount: 25000 }),
          expect.objectContaining({ toAccountId: 2, amount: 10000 }),
        ])
      );
    });

    it('should decrement prepaids after granting buzz', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          buzzAmount: '50000',
          productId: 'prod_gold',
          priceId: 'price_gold',
          interval: 'month',
          tier: 'gold',
          buzzType: 'yellow',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
    });

    it('should record externalTransactionId with correct format', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          buzzAmount: '50000',
          productId: 'prod_gold',
          priceId: 'price_gold',
          interval: 'month',
          tier: 'gold',
          buzzType: 'yellow',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith([
        expect.objectContaining({
          externalTransactionId: expect.stringMatching(/civitai-membership:2024-01:1:prod_gold:v3/),
        }),
      ]);
    });

    it('should deliver cosmetics after buzz', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      mockDbWrite.$queryRaw.mockResolvedValue([
        {
          id: 'sub_1',
          userId: 1,
          buzzAmount: '50000',
          productId: 'prod_gold',
          priceId: 'price_gold',
          interval: 'month',
          tier: 'gold',
          buzzType: 'yellow',
        },
      ]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      expect(mockDeliverMonthlyCosmetics).toHaveBeenCalled();
    });

    it('should batch process when many users found', async () => {
      vi.setSystemTime(new Date('2024-01-15T01:00:00Z'));

      const users = Array.from({ length: 150 }, (_, i) => ({
        id: `sub_${i}`,
        userId: i + 1,
        buzzAmount: '10000',
        productId: 'prod_bronze',
        priceId: 'price_bronze',
        interval: 'month',
        tier: 'bronze',
        buzzType: 'yellow',
      }));

      mockDbWrite.$queryRaw.mockResolvedValue(users);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 100 });

      await deliverPrepaidMembershipBuzz.run({ req: undefined }).result;

      // Should have called createBuzzTransactionMany twice (100 + 50)
      expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('processPrepaidMembershipTransitions', () => {
    it('should find memberships expiring today', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      mockDbWrite.product.findMany.mockResolvedValue(createTierProducts());
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);

      await processPrepaidMembershipTransitions.run().result;

      expect(mockDbWrite.customerSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'active',
            currentPeriodEnd: expect.objectContaining({
              gte: expect.any(Date),
              lt: expect.any(Date),
            }),
          }),
        })
      );
    });

    it('should select highest available tier from prepaids when transitioning', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const tierProducts = createTierProducts();

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: {
          prepaids: { bronze: 2, silver: 1 },
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

      mockDbWrite.product.findMany.mockResolvedValue(tierProducts);
      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiringMembership]);
      mockDbWrite.$executeRaw.mockResolvedValue({ count: 1 });

      await processPrepaidMembershipTransitions.run().result;

      expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
    });

    it('should cancel subscription when no prepaids remain', async () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00Z'));

      const expiringMembership = {
        id: 'sub_1',
        userId: 1,
        metadata: {
          prepaids: {},
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

      expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
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
    it('should find active memberships past currentPeriodEnd', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'active',
            currentPeriodEnd: {
              lt: expect.any(Date),
            },
          }),
        })
      );
    });

    it('should set status to canceled with canceledAt and endedAt', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const expiredMembership = {
        id: 'sub_1',
        userId: 1,
        currentPeriodEnd: new Date('2024-01-14'),
      };

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiredMembership]);
      mockDbWrite.customerSubscription.updateManyAndReturn.mockResolvedValue([{ userId: 1 }]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'canceled',
            canceledAt: expect.any(Date),
            endedAt: expect.any(Date),
          }),
        })
      );
    });

    it('should refresh user sessions after cancellation', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const expiredMembership = {
        id: 'sub_1',
        userId: 1,
        currentPeriodEnd: new Date('2024-01-14'),
      };

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([expiredMembership]);
      mockDbWrite.customerSubscription.updateManyAndReturn.mockResolvedValue([{ userId: 1 }]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockRefreshSession).toHaveBeenCalledWith(1);
    });

    it('should not run if no expired memberships', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      mockDbWrite.customerSubscription.findMany.mockResolvedValue([]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('should handle multiple expired memberships', async () => {
      vi.setSystemTime(new Date('2024-01-15T02:00:00Z'));

      const expiredMemberships = [
        { id: 'sub_1', userId: 1, currentPeriodEnd: new Date('2024-01-14') },
        { id: 'sub_2', userId: 2, currentPeriodEnd: new Date('2024-01-13') },
        { id: 'sub_3', userId: 3, currentPeriodEnd: new Date('2024-01-10') },
      ];

      mockDbWrite.customerSubscription.findMany.mockResolvedValue(expiredMemberships);
      mockDbWrite.customerSubscription.updateManyAndReturn.mockResolvedValue([
        { userId: 1 },
        { userId: 2 },
        { userId: 3 },
      ]);

      await cancelExpiredPrepaidMemberships.run().result;

      expect(mockDbWrite.customerSubscription.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: ['sub_1', 'sub_2', 'sub_3'] },
          },
        })
      );
    });
  });
});
