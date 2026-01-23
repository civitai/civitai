import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { SubscriptionMetadata, SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

dayjs.extend(utc);

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const { mockDbWrite, mockDbRead, mockCreateBuzzTransaction, mockDeliverMonthlyCosmetics } = vi.hoisted(() => {
  const mockRedeemableCode = {
    findUnique: vi.fn(),
    update: vi.fn(),
    createMany: vi.fn(),
    delete: vi.fn(),
  };

  const mockCustomerSubscription = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateManyAndReturn: vi.fn(),
  };

  const mockPrice = {
    findUnique: vi.fn(),
  };

  const mockProduct = {
    findMany: vi.fn(),
  };

  const mockKeyValue = {
    findUnique: vi.fn(),
  };

  return {
    mockDbWrite: {
      redeemableCode: mockRedeemableCode,
      customerSubscription: mockCustomerSubscription,
      price: mockPrice,
      product: mockProduct,
      keyValue: mockKeyValue,
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback({
          redeemableCode: mockRedeemableCode,
          customerSubscription: mockCustomerSubscription,
          price: mockPrice,
          product: mockProduct,
          keyValue: mockKeyValue,
        });
      }),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
    },
    mockDbRead: {
      keyValue: {
        findUnique: vi.fn(),
      },
    },
    mockCreateBuzzTransaction: vi.fn().mockResolvedValue({ success: true }),
    mockDeliverMonthlyCosmetics: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock modules
vi.mock('~/env/server', () => ({
  env: {
    TIER_METADATA_KEY: 'tier',
    BUZZ_ENDPOINT: 'http://mock-buzz-endpoint',
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/integrations/freshdesk', () => ({
  updateServiceTier: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: mockDbWrite,
  dbRead: mockDbRead,
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mockCreateBuzzTransaction,
}));

vi.mock('~/server/services/subscriptions.service', () => ({
  deliverMonthlyCosmetics: mockDeliverMonthlyCosmetics,
}));

vi.mock('~/server/utils/errorHandling', () => ({
  throwDbCustomError: (message: string) => () => {
    throw new Error(message);
  },
  withRetries: async (fn: () => Promise<any>) => fn(),
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
  product: MockProduct;
}

interface MockRedeemableCode {
  code: string;
  unitValue: number;
  type: string;
  userId: number | null;
  priceId: string | null;
  price: MockPrice | null;
  redeemedAt: Date | null;
  expiresAt: Date | null;
  transactionId: string | null;
}

interface MockSubscription {
  id: string;
  userId: number;
  productId: string;
  priceId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  canceledAt: Date | null;
  endedAt: Date | null;
  buzzType: string;
  metadata: SubscriptionMetadata;
  product: MockProduct;
  price: MockPrice;
}

const createMockProduct = (overrides: Partial<MockProduct> = {}): MockProduct => ({
  id: 'prod_test_123',
  name: 'Test Gold Membership',
  metadata: {
    tier: 'gold',
    monthlyBuzz: 50000,
    buzzType: 'yellow',
  },
  provider: 'Civitai',
  ...overrides,
});

const createMockPrice = (overrides: Partial<MockPrice> = {}): MockPrice => ({
  id: 'price_test_123',
  currency: 'USD',
  interval: 'month',
  product: createMockProduct(),
  ...overrides,
});

const createMockRedeemableCode = (
  overrides: Partial<MockRedeemableCode> = {}
): MockRedeemableCode => ({
  code: 'MB-TEST-1234',
  unitValue: 3,
  type: 'Membership',
  userId: null,
  priceId: 'price_test_123',
  price: createMockPrice({
    interval: 'month',
    product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
  }),
  redeemedAt: null,
  expiresAt: null,
  transactionId: null,
  ...overrides,
});

const createMockSubscription = (
  overrides: Partial<MockSubscription> = {}
): MockSubscription => ({
  id: 'sub_test_123',
  userId: 1,
  productId: 'prod_test_123',
  priceId: 'price_test_123',
  status: 'active',
  currentPeriodStart: new Date('2024-01-01'),
  currentPeriodEnd: new Date('2024-04-01'),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  canceledAt: null,
  endedAt: null,
  buzzType: 'yellow',
  metadata: {
    prepaids: { gold: 2 },
    buzzTransactionIds: [],
  },
  product: createMockProduct(),
  price: createMockPrice(),
  ...overrides,
});

// Import after mocks are set up
import {
  createRedeemableCodes,
  consumeRedeemableCode,
  deleteRedeemableCode,
} from '~/server/services/redeemableCode.service';
import { RedeemableCodeType } from '~/shared/utils/prisma/enums';

describe('redeemableCode.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createRedeemableCodes', () => {
    it('should create membership codes with correct MB- prefix', async () => {
      mockDbWrite.price.findUnique.mockResolvedValue({
        id: 'price_123',
        product: { id: 'prod_123', name: 'Gold', metadata: { tier: 'gold' } },
      });
      mockDbWrite.redeemableCode.createMany.mockResolvedValue({ count: 1 });

      const codes = await createRedeemableCodes({
        unitValue: 3,
        type: RedeemableCodeType.Membership,
        priceId: 'price_123',
        quantity: 1,
      });

      expect(codes).toHaveLength(1);
      expect(codes[0]).toMatch(/^MB-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    it('should create buzz codes with correct CS- prefix', async () => {
      mockDbWrite.redeemableCode.createMany.mockResolvedValue({ count: 1 });

      const codes = await createRedeemableCodes({
        unitValue: 5000,
        type: RedeemableCodeType.Buzz,
        quantity: 1,
      });

      expect(codes).toHaveLength(1);
      expect(codes[0]).toMatch(/^CS-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    it('should create multiple codes when quantity specified', async () => {
      mockDbWrite.price.findUnique.mockResolvedValue({
        id: 'price_123',
        product: { id: 'prod_123', name: 'Gold', metadata: { tier: 'gold' } },
      });
      mockDbWrite.redeemableCode.createMany.mockResolvedValue({ count: 5 });

      const codes = await createRedeemableCodes({
        unitValue: 3,
        type: RedeemableCodeType.Membership,
        priceId: 'price_123',
        quantity: 5,
      });

      expect(codes).toHaveLength(5);
      expect(mockDbWrite.redeemableCode.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            unitValue: 3,
            type: RedeemableCodeType.Membership,
            priceId: 'price_123',
          }),
        ]),
      });
    });

    it('should throw error when priceId does not exist', async () => {
      mockDbWrite.price.findUnique.mockResolvedValue(null);

      await expect(
        createRedeemableCodes({
          unitValue: 3,
          type: RedeemableCodeType.Membership,
          priceId: 'invalid_price',
        })
      ).rejects.toThrow('Price ID does not exist');
    });
  });

  describe('consumeRedeemableCode', () => {
    describe('New User - No Existing Membership', () => {
      it('should create new subscription with correct period end', async () => {
        const mockCode = createMockRedeemableCode({ unitValue: 3 });
        let createdSubscription: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockImplementation((args: any) => {
                createdSubscription = args.data;
                return { id: 'sub_new' };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Verify period end is 3 months from currentPeriodStart (unitValue = 3, interval = month)
        const periodStart = dayjs(createdSubscription.currentPeriodStart);
        const periodEnd = dayjs(createdSubscription.currentPeriodEnd);
        const monthsDiff = periodEnd.diff(periodStart, 'month');
        expect(monthsDiff).toBe(3);
      });

      it('should set prepaids to unitValue - 1 (first month granted immediately)', async () => {
        const mockCode = createMockRedeemableCode({ unitValue: 3 });
        let createdSubscription: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockImplementation((args: any) => {
                createdSubscription = args.data;
                return { id: 'sub_new' };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        expect(createdSubscription.metadata.prepaids.gold).toBe(2); // 3 - 1 = 2
      });

      it('should grant immediate buzz based on product monthlyBuzz', async () => {
        const mockCode = createMockRedeemableCode({
          price: createMockPrice({
            product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          }),
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({ id: 'sub_new' }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: 50000,
            toAccountId: 1,
            toAccountType: 'yellow',
          })
        );
      });

      it('should set cancelAtPeriodEnd to true for new subscriptions', async () => {
        const mockCode = createMockRedeemableCode();
        let createdSubscription: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockImplementation((args: any) => {
                createdSubscription = args.data;
                return { id: 'sub_new' };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        expect(createdSubscription.cancelAtPeriodEnd).toBe(true);
      });
    });

    describe('Same Tier Extension', () => {
      it('should NOT grant buzz instantly for same tier extension', async () => {
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            interval: 'month',
            product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          }),
        });

        const existingSub = createMockSubscription({
          product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          metadata: { prepaids: { gold: 2 }, buzzTransactionIds: ['tx1'] },
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockResolvedValue({ id: existingSub.id }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Same tier extension should NOT grant buzz immediately
        expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
      });

      it('should add ALL tokens as prepaids for same tier (no immediate consumption)', async () => {
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            interval: 'month',
            product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          }),
        });

        const existingSub = createMockSubscription({
          product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          metadata: { prepaids: { gold: 2 }, buzzTransactionIds: ['tx1'] },
        });

        let updatedMetadata: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockImplementation((args: any) => {
                updatedMetadata = args.data.metadata;
                return { id: existingSub.id };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // For same tier, ALL tokens should be added as prepaids (no -1 for immediate buzz)
        // 2 (existing) + 3 (new) = 5
        expect(updatedMetadata.prepaids.gold).toBe(5);
      });

      it('should extend currentPeriodEnd correctly', async () => {
        const mockCode = createMockRedeemableCode({
          unitValue: 2,
          price: createMockPrice({
            interval: 'month',
            product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          }),
        });

        const existingSub = createMockSubscription({
          currentPeriodEnd: new Date('2024-02-15'),
          product: createMockProduct({ metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' } }),
          metadata: { prepaids: { gold: 1 }, buzzTransactionIds: ['tx1'] },
        });

        let updatedSubscription: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockImplementation((args: any) => {
                updatedSubscription = args.data;
                return { id: existingSub.id };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Should extend by 2 months from current period end
        // Use UTC for consistent timezone handling
        const expectedEnd = dayjs.utc('2024-02-15').add(2, 'month').toDate();
        expect(updatedSubscription.currentPeriodEnd.getTime()).toBe(expectedEnd.getTime());
      });

    });

    describe('Downgrade (User has higher tier)', () => {
      it('should NOT grant buzz instantly when user has higher tier', async () => {
        // User has gold, redeeming silver code
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            id: 'price_silver',
            interval: 'month',
            product: createMockProduct({
              id: 'prod_silver',
              metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          productId: 'prod_gold',
          product: createMockProduct({
            id: 'prod_gold',
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { prepaids: { gold: 2 }, buzzTransactionIds: ['tx1'] },
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockResolvedValue({ id: existingSub.id }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Downgrade should NOT grant buzz immediately
        expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
      });

      it('should NOT change membership status when user has higher tier', async () => {
        // User has gold, redeeming silver code - should stay on gold
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            id: 'price_silver',
            interval: 'month',
            product: createMockProduct({
              id: 'prod_silver',
              metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          productId: 'prod_gold',
          priceId: 'price_gold',
          product: createMockProduct({
            id: 'prod_gold',
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { prepaids: { gold: 2 }, buzzTransactionIds: ['tx1'] },
        });

        let updatedSubscription: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockImplementation((args: any) => {
                updatedSubscription = args.data;
                return { id: existingSub.id };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Should NOT change productId or priceId - user stays on gold
        expect(updatedSubscription.productId).toBeUndefined();
        expect(updatedSubscription.priceId).toBeUndefined();
      });

      it('should add ALL tokens as prepaids for lower tier (no immediate consumption)', async () => {
        // User has gold, redeeming 3 silver tokens - all should be saved as prepaids
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            id: 'price_silver',
            interval: 'month',
            product: createMockProduct({
              id: 'prod_silver',
              metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          productId: 'prod_gold',
          product: createMockProduct({
            id: 'prod_gold',
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { prepaids: { gold: 2 }, buzzTransactionIds: ['tx1'] },
        });

        let updatedMetadata: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockImplementation((args: any) => {
                updatedMetadata = args.data.metadata;
                return { id: existingSub.id };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // All 3 silver tokens should be added as prepaids (no -1 for immediate buzz)
        expect(updatedMetadata.prepaids.silver).toBe(3);
        // Existing gold prepaids should remain unchanged
        expect(updatedMetadata.prepaids.gold).toBe(2);
      });
    });

    describe('Upgrade (User has lower tier)', () => {
      it('should grant buzz instantly when upgrading to higher tier', async () => {
        // User has silver, redeeming gold code - should grant buzz
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            id: 'price_gold',
            interval: 'month',
            product: createMockProduct({
              id: 'prod_gold',
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          productId: 'prod_silver',
          priceId: 'price_silver',
          product: createMockProduct({
            id: 'prod_silver',
            metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
          }),
          metadata: { prepaids: { silver: 2 }, buzzTransactionIds: ['tx1'] },
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockResolvedValue({ id: existingSub.id }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Upgrade should grant buzz immediately (gold tier = 50000)
        expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: 50000,
            toAccountId: 1,
          })
        );
      });

      it('should update membership to higher tier', async () => {
        // User has silver, redeeming gold code - should upgrade to gold
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            id: 'price_gold',
            interval: 'month',
            product: createMockProduct({
              id: 'prod_gold',
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          productId: 'prod_silver',
          priceId: 'price_silver',
          product: createMockProduct({
            id: 'prod_silver',
            metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
          }),
          metadata: { prepaids: { silver: 2 }, buzzTransactionIds: ['tx1'] },
        });

        let updatedSubscription: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockImplementation((args: any) => {
                updatedSubscription = args.data;
                return { id: existingSub.id };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // Should upgrade to gold
        expect(updatedSubscription.productId).toBe('prod_gold');
        expect(updatedSubscription.priceId).toBe('price_gold');
      });

      it('should set prepaids to unitValue - 1 for upgrade (first month granted immediately)', async () => {
        // User has silver, redeeming 3 gold tokens - should grant 1 immediately
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            id: 'price_gold',
            interval: 'month',
            product: createMockProduct({
              id: 'prod_gold',
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          productId: 'prod_silver',
          priceId: 'price_silver',
          product: createMockProduct({
            id: 'prod_silver',
            metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
          }),
          metadata: { prepaids: { silver: 2 }, buzzTransactionIds: ['tx1'] },
        });

        let updatedMetadata: any = null;

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({ ...mockCode, redeemedAt: new Date(), userId: 1 }),
            },
            customerSubscription: {
              findFirst: vi.fn().mockResolvedValue(existingSub),
              update: vi.fn().mockImplementation((args: any) => {
                updatedMetadata = args.data.metadata;
                return { id: existingSub.id };
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        // For upgrade, prepaids should be unitValue - 1 (first month granted immediately)
        // 3 - 1 = 2
        expect(updatedMetadata.prepaids.gold).toBe(2);
        // Existing silver prepaids should be preserved
        expect(updatedMetadata.prepaids.silver).toBe(2);
      });
    });

    describe('Edge Cases', () => {
      it('should reject already-redeemed codes by different user', async () => {
        const mockCode = createMockRedeemableCode({
          redeemedAt: new Date('2024-01-10'),
          userId: 999, // Different user
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);

        await expect(consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 })).rejects.toThrow(
          'Code does not exist or has been redeemed'
        );
      });

      it('should return existing record for same-user re-redemption', async () => {
        const mockCode = createMockRedeemableCode({
          redeemedAt: new Date('2024-01-10'),
          userId: 1, // Same user
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);
        mockDbRead.keyValue.findUnique.mockResolvedValue(null); // No gift notices

        const result = await consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 });

        expect(result.code).toBe('MB-TEST-1234');
        expect(result.redeemedAt).toBeDefined();
      });

      it('should reject codes without priceId for membership type', async () => {
        const mockCode = createMockRedeemableCode({
          type: 'Membership',
          priceId: null,
          price: null,
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);

        await expect(consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 })).rejects.toThrow(
          'Membership codes must have a price ID'
        );
      });

      it('should reject codes for non-Civitai provider products', async () => {
        const mockCode = createMockRedeemableCode({
          price: createMockPrice({
            product: createMockProduct({ provider: 'Stripe' }),
          }),
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(mockCode);

        await expect(consumeRedeemableCode({ code: 'MB-TEST-1234', userId: 1 })).rejects.toThrow(
          'Cannot redeem codes for non-Civitai products'
        );
      });
    });

    describe('Buzz Code Redemption', () => {
      it('should create buzz transaction for buzz codes', async () => {
        const buzzCode = createMockRedeemableCode({
          code: 'CS-TEST-1234',
          type: 'Buzz',
          unitValue: 10000,
          priceId: null,
          price: null,
        });

        mockDbWrite.redeemableCode.findUnique.mockResolvedValue(buzzCode);
        mockDbWrite.$transaction.mockImplementation(async (callback: any) => {
          const tx = {
            redeemableCode: {
              update: vi.fn().mockResolvedValue({
                ...buzzCode,
                redeemedAt: new Date(),
                userId: 1,
                transactionId: 'redeemable-code-CS-TEST-1234',
              }),
            },
          };
          return callback(tx);
        });

        await consumeRedeemableCode({ code: 'CS-TEST-1234', userId: 1 });

        expect(mockCreateBuzzTransaction).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: 10000,
            toAccountId: 1,
            externalTransactionId: 'redeemable-code-CS-TEST-1234',
          })
        );
      });
    });
  });

  describe('deleteRedeemableCode', () => {
    it('should delete unredeemed code', async () => {
      mockDbWrite.redeemableCode.delete.mockResolvedValue({ code: 'MB-TEST-1234' });

      await deleteRedeemableCode({ code: 'MB-TEST-1234' });

      expect(mockDbWrite.redeemableCode.delete).toHaveBeenCalledWith({
        where: { code: 'MB-TEST-1234', redeemedAt: null },
      });
    });

    it('should throw error when code is already redeemed', async () => {
      mockDbWrite.redeemableCode.delete.mockRejectedValue(
        new Error('Code does not exist or has been redeemed')
      );

      await expect(deleteRedeemableCode({ code: 'MB-TEST-1234' })).rejects.toThrow(
        'Code does not exist or has been redeemed'
      );
    });
  });
});
