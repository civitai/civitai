import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
  PrepaidToken,
} from '~/server/schema/subscriptions.schema';

dayjs.extend(utc);

// Use vi.hoisted to define mocks that will be available in vi.mock factories
const { mockDbWrite, mockDbRead, mockCreateBuzzTransaction, mockDeliverMonthlyCosmetics } =
  vi.hoisted(() => {
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

vi.mock('~/server/utils/subscription.utils', () => {
  const TIER_BUZZ: Record<string, number> = { bronze: 10000, silver: 25000, gold: 50000 };
  return {
    invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
    getPrepaidTokens: ({ metadata }: any) => {
      if (!metadata) return [];
      if (metadata.tokens?.length > 0) return metadata.tokens;
      const prepaids = metadata.prepaids;
      if (!prepaids) return [];
      const tokens: any[] = [];
      for (const tier of ['gold', 'silver', 'bronze']) {
        const count = prepaids[tier] ?? 0;
        for (let i = 0; i < count; i++) {
          tokens.push({
            id: `legacy_${tier}_${i}`,
            tier,
            status: 'locked',
            buzzAmount: TIER_BUZZ[tier] ?? 25000,
          });
        }
      }
      return tokens;
    },
  };
});

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
    product: createMockProduct({
      metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
    }),
  }),
  redeemedAt: null,
  expiresAt: null,
  transactionId: null,
  ...overrides,
});

const createMockToken = (overrides: Partial<PrepaidToken> = {}): PrepaidToken => ({
  id: `tok_existing_${Math.random().toString(36).slice(2, 10)}`,
  tier: 'gold',
  status: 'locked',
  buzzAmount: 50000,
  codeId: 'MB-PREV-CODE',
  ...overrides,
});

const createMockSubscription = (overrides: Partial<MockSubscription> = {}): MockSubscription => ({
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
    tokens: [
      createMockToken({ id: 'tok_existing_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }),
      createMockToken({ id: 'tok_existing_2', tier: 'gold', status: 'locked', buzzAmount: 50000 }),
    ],
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

      it('should create N tokens where N equals unitValue, with first unlocked', async () => {
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

        const tokens: PrepaidToken[] = createdSubscription.metadata.tokens;
        expect(tokens).toHaveLength(3);

        // First token should be unlocked with unlockedAt set
        expect(tokens[0].status).toBe('unlocked');
        expect(tokens[0].tier).toBe('gold');
        expect(tokens[0].buzzAmount).toBe(50000);
        expect(tokens[0].codeId).toBe('MB-TEST-1234');
        expect(tokens[0].unlockedAt).toBeDefined();
        expect(tokens[0].id).toMatch(/^tok_/);

        // Remaining tokens should be locked without unlockedAt
        expect(tokens[1].status).toBe('locked');
        expect(tokens[1].unlockedAt).toBeUndefined();
        expect(tokens[2].status).toBe('locked');
        expect(tokens[2].unlockedAt).toBeUndefined();
      });

      it('should NEVER call createBuzzTransaction for membership codes', async () => {
        const mockCode = createMockRedeemableCode({
          price: createMockPrice({
            product: createMockProduct({
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
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

        // Token-based system never auto-delivers buzz for membership codes
        expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
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

      it('should call deliverMonthlyCosmetics for new membership', async () => {
        const mockCode = createMockRedeemableCode();

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

        expect(mockDeliverMonthlyCosmetics).toHaveBeenCalledWith(
          expect.objectContaining({ userIds: [1] })
        );
      });

      it('should store tokens with unique IDs matching tok_ prefix pattern', async () => {
        const mockCode = createMockRedeemableCode({ unitValue: 5 });
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

        const tokens: PrepaidToken[] = createdSubscription.metadata.tokens;
        expect(tokens).toHaveLength(5);

        // All IDs should be unique
        const ids = tokens.map((t) => t.id);
        expect(new Set(ids).size).toBe(5);

        // All should match tok_ pattern
        tokens.forEach((token) => {
          expect(token.id).toMatch(/^tok_/);
        });
      });
    });

    describe('Same Tier Extension', () => {
      it('should NOT call createBuzzTransaction for same tier extension', async () => {
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            interval: 'month',
            product: createMockProduct({
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingTokens: PrepaidToken[] = [
          createMockToken({ id: 'tok_prev_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }),
          createMockToken({ id: 'tok_prev_2', tier: 'gold', status: 'locked', buzzAmount: 50000 }),
        ];

        const existingSub = createMockSubscription({
          product: createMockProduct({
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { tokens: existingTokens },
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

        expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
      });

      it('should append N locked tokens to existing tokens array for same tier', async () => {
        const mockCode = createMockRedeemableCode({
          unitValue: 3,
          price: createMockPrice({
            interval: 'month',
            product: createMockProduct({
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingTokens: PrepaidToken[] = [
          createMockToken({ id: 'tok_prev_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }),
          createMockToken({ id: 'tok_prev_2', tier: 'gold', status: 'locked', buzzAmount: 50000 }),
        ];

        const existingSub = createMockSubscription({
          product: createMockProduct({
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { tokens: existingTokens },
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

        const tokens: PrepaidToken[] = updatedMetadata.tokens;
        // 2 existing + 3 new = 5 total
        expect(tokens).toHaveLength(5);

        // First 2 tokens are the preserved existing ones
        expect(tokens[0].id).toBe('tok_prev_1');
        expect(tokens[0].status).toBe('claimed');
        expect(tokens[1].id).toBe('tok_prev_2');
        expect(tokens[1].status).toBe('locked');

        // Last 3 are new tokens, ALL locked (same tier = no unlocked first token)
        const newTokens = tokens.slice(2);
        expect(newTokens).toHaveLength(3);
        newTokens.forEach((token) => {
          expect(token.status).toBe('locked');
          expect(token.tier).toBe('gold');
          expect(token.buzzAmount).toBe(50000);
          expect(token.codeId).toBe('MB-TEST-1234');
          expect(token.unlockedAt).toBeUndefined();
        });
      });

      it('should extend currentPeriodEnd correctly', async () => {
        const mockCode = createMockRedeemableCode({
          unitValue: 2,
          price: createMockPrice({
            interval: 'month',
            product: createMockProduct({
              metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
            }),
          }),
        });

        const existingSub = createMockSubscription({
          currentPeriodEnd: new Date('2024-02-15'),
          product: createMockProduct({
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: {
            tokens: [
              createMockToken({ id: 'tok_prev_1', tier: 'gold', status: 'locked', buzzAmount: 50000 }),
            ],
          },
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
      it('should NOT call createBuzzTransaction when user has higher tier', async () => {
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

        const existingGoldTokens: PrepaidToken[] = [
          createMockToken({ id: 'tok_gold_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }),
          createMockToken({ id: 'tok_gold_2', tier: 'gold', status: 'locked', buzzAmount: 50000 }),
        ];

        const existingSub = createMockSubscription({
          productId: 'prod_gold',
          product: createMockProduct({
            id: 'prod_gold',
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { tokens: existingGoldTokens },
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

        expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
      });

      it('should NOT change productId or priceId when user has higher tier', async () => {
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
          metadata: {
            tokens: [
              createMockToken({ id: 'tok_gold_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }),
            ],
          },
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

      it('should append all-locked silver tokens and preserve existing gold tokens', async () => {
        // User has gold, redeeming 3 silver tokens - all should be locked
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

        const existingGoldTokens: PrepaidToken[] = [
          createMockToken({ id: 'tok_gold_1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }),
          createMockToken({ id: 'tok_gold_2', tier: 'gold', status: 'locked', buzzAmount: 50000 }),
        ];

        const existingSub = createMockSubscription({
          productId: 'prod_gold',
          product: createMockProduct({
            id: 'prod_gold',
            metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
          }),
          metadata: { tokens: existingGoldTokens },
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

        const tokens: PrepaidToken[] = updatedMetadata.tokens;
        // 2 existing gold + 3 new silver = 5 total
        expect(tokens).toHaveLength(5);

        // Existing gold tokens preserved at the start
        expect(tokens[0].id).toBe('tok_gold_1');
        expect(tokens[0].tier).toBe('gold');
        expect(tokens[0].status).toBe('claimed');
        expect(tokens[1].id).toBe('tok_gold_2');
        expect(tokens[1].tier).toBe('gold');

        // New silver tokens: ALL locked (downgrade = no unlocked first token)
        const silverTokens = tokens.slice(2);
        expect(silverTokens).toHaveLength(3);
        silverTokens.forEach((token) => {
          expect(token.status).toBe('locked');
          expect(token.tier).toBe('silver');
          expect(token.buzzAmount).toBe(25000);
          expect(token.codeId).toBe('MB-TEST-1234');
          expect(token.unlockedAt).toBeUndefined();
        });
      });
    });

    describe('Upgrade (User has lower tier)', () => {
      it('should NOT call createBuzzTransaction when upgrading tier', async () => {
        // User has silver, redeeming gold code - no immediate buzz delivery
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

        const existingSilverTokens: PrepaidToken[] = [
          createMockToken({ id: 'tok_silver_1', tier: 'silver', status: 'claimed', buzzAmount: 25000 }),
          createMockToken({ id: 'tok_silver_2', tier: 'silver', status: 'locked', buzzAmount: 25000 }),
        ];

        const existingSub = createMockSubscription({
          productId: 'prod_silver',
          priceId: 'price_silver',
          product: createMockProduct({
            id: 'prod_silver',
            metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
          }),
          metadata: { tokens: existingSilverTokens },
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

        // Token-based system never auto-delivers buzz for membership codes
        expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
      });

      it('should update membership productId and priceId to higher tier', async () => {
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
          metadata: {
            tokens: [
              createMockToken({ id: 'tok_silver_1', tier: 'silver', status: 'claimed', buzzAmount: 25000 }),
            ],
          },
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

      it('should create N gold tokens with first unlocked and preserve existing silver tokens', async () => {
        // User has silver with 2 existing tokens, redeeming 3 gold tokens
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

        const existingSilverTokens: PrepaidToken[] = [
          createMockToken({ id: 'tok_silver_1', tier: 'silver', status: 'claimed', buzzAmount: 25000 }),
          createMockToken({ id: 'tok_silver_2', tier: 'silver', status: 'locked', buzzAmount: 25000 }),
        ];

        const existingSub = createMockSubscription({
          productId: 'prod_silver',
          priceId: 'price_silver',
          product: createMockProduct({
            id: 'prod_silver',
            metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
          }),
          metadata: { tokens: existingSilverTokens },
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

        const tokens: PrepaidToken[] = updatedMetadata.tokens;
        // 2 existing silver + 3 new gold = 5 total
        expect(tokens).toHaveLength(5);

        // Existing silver tokens should be preserved at the start
        expect(tokens[0].id).toBe('tok_silver_1');
        expect(tokens[0].tier).toBe('silver');
        expect(tokens[0].status).toBe('claimed');
        expect(tokens[1].id).toBe('tok_silver_2');
        expect(tokens[1].tier).toBe('silver');
        expect(tokens[1].status).toBe('locked');

        // New gold tokens: first is unlocked with unlockedAt, rest are locked
        const goldTokens = tokens.slice(2);
        expect(goldTokens).toHaveLength(3);

        expect(goldTokens[0].status).toBe('unlocked');
        expect(goldTokens[0].tier).toBe('gold');
        expect(goldTokens[0].buzzAmount).toBe(50000);
        expect(goldTokens[0].codeId).toBe('MB-TEST-1234');
        expect(goldTokens[0].unlockedAt).toBeDefined();

        expect(goldTokens[1].status).toBe('locked');
        expect(goldTokens[1].unlockedAt).toBeUndefined();
        expect(goldTokens[2].status).toBe('locked');
        expect(goldTokens[2].unlockedAt).toBeUndefined();
      });

      it('should reset currentPeriodStart and compute new currentPeriodEnd on upgrade', async () => {
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
          currentPeriodStart: new Date('2024-01-01'),
          currentPeriodEnd: new Date('2024-04-01'),
          productId: 'prod_silver',
          priceId: 'price_silver',
          product: createMockProduct({
            id: 'prod_silver',
            metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
          }),
          metadata: {
            tokens: [
              createMockToken({ id: 'tok_silver_1', tier: 'silver', status: 'claimed', buzzAmount: 25000 }),
            ],
          },
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

        // Upgrade resets period start to now and computes new end from now
        const now = new Date('2024-01-15T10:00:00Z');
        const expectedEnd = dayjs.utc(now).add(3, 'month').toDate();
        expect(updatedSubscription.currentPeriodStart.getTime()).toBe(now.getTime());
        expect(updatedSubscription.currentPeriodEnd.getTime()).toBe(expectedEnd.getTime());
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
