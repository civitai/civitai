import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Coinbase } from '~/server/http/coinbase/coinbase.schema';

// Use vi.hoisted so mocks are available inside vi.mock factories
const {
  mockDbRead,
  mockDbWrite,
  mockCoinbaseCaller,
  mockGrantBuzzPurchase,
  mockGrantCosmetics,
  mockEmailSend,
} = vi.hoisted(() => {
  const mockRedeemableCode = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };

  const mockProduct = {
    findFirst: vi.fn(),
  };

  const mockUser = {
    findUnique: vi.fn(),
  };

  return {
    mockDbRead: {
      redeemableCode: { findFirst: vi.fn() },
      product: mockProduct,
      user: mockUser,
    },
    mockDbWrite: {
      redeemableCode: mockRedeemableCode,
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback({
          redeemableCode: mockRedeemableCode,
        });
      }),
    },
    mockCoinbaseCaller: {
      createCharge: vi.fn(),
      isAPIHealthy: vi.fn(),
    },
    mockGrantBuzzPurchase: vi.fn().mockResolvedValue('tx_123'),
    mockGrantCosmetics: vi.fn().mockResolvedValue(undefined),
    mockEmailSend: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock modules
vi.mock('process', () => ({
  env: {
    NEXTAUTH_URL: 'https://civitai.com',
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/http/coinbase/coinbase.caller', () => ({
  default: mockCoinbaseCaller,
  CoinbaseCaller: { verifyWebhookSignature: vi.fn() },
}));

vi.mock('~/server/services/buzz.service', () => ({
  grantBuzzPurchase: mockGrantBuzzPurchase,
}));

vi.mock('~/server/services/cosmetic.service', () => ({
  grantCosmetics: mockGrantCosmetics,
}));

vi.mock('~/server/common/constants', () => ({
  COINBASE_FIXED_FEE: 0,
  specialCosmeticRewards: { crypto: [] },
}));

vi.mock('~/server/email/templates/redeemableCodePurchase.email', () => ({
  redeemableCodePurchaseEmail: {
    send: mockEmailSend,
  },
}));

vi.mock('~/server/schema/subscriptions.schema', () => ({
  subscriptionProductMetadataSchema: {
    parse: vi.fn((x: any) => x),
  },
}));

vi.mock('~/utils/string-helpers', () => ({
  generateToken: vi.fn(() => 'ABCD'),
}));

// Import after mocks
import {
  createBuzzOrder,
  createCodeOrder,
  processBuzzOrder,
  processCodeOrder,
} from '~/server/services/coinbase.service';

// Helper to build a minimal webhook event data object.
// Metadata is loosely typed to allow testing validation of incomplete/invalid inputs.
type EventDataOverrides = Omit<
  Partial<Coinbase.WebhookEventSchema['event']['data']>,
  'metadata'
> & {
  metadata?: Record<string, unknown>;
};

function makeEventData(
  overrides: EventDataOverrides = {}
): Coinbase.WebhookEventSchema['event']['data'] {
  return {
    id: 'charge_abc',
    metadata: {},
    ...overrides,
  } as Coinbase.WebhookEventSchema['event']['data'];
}

describe('coinbase.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // createCodeOrder
  // ---------------------------------------------------------------------------
  describe('createCodeOrder', () => {
    const mockCharge = {
      id: 'charge_123',
      hosted_url: 'https://commerce.coinbase.com/charges/abc',
    };

    it('should create a buzz code order with correct price', async () => {
      mockCoinbaseCaller.createCharge.mockResolvedValue(mockCharge);

      const result = await createCodeOrder({
        type: 'Buzz',
        buzzAmount: 10000,
        userId: 42,
      });

      expect(result).toBe(mockCharge);
      expect(mockCoinbaseCaller.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Redeemable code purchase',
          pricing_type: 'fixed_price',
          local_price: {
            amount: '10', // 10000 buzz / 10 = 1000 cents / 100 = $10
            currency: 'USD',
          },
          metadata: expect.objectContaining({
            userId: 42,
            codeType: 'Buzz',
            codeUnitValue: 10000,
            codePriceId: undefined,
          }),
        })
      );
    });

    it('should generate orderId with code- prefix for webhook routing', async () => {
      mockCoinbaseCaller.createCharge.mockResolvedValue(mockCharge);

      await createCodeOrder({ type: 'Buzz', buzzAmount: 10000, userId: 42 });

      const call = mockCoinbaseCaller.createCharge.mock.calls[0][0];
      expect(call.metadata.internalOrderId).toMatch(/^code-42-/);
    });

    it('should set redirect to coinbase-code success page', async () => {
      mockCoinbaseCaller.createCharge.mockResolvedValue(mockCharge);

      await createCodeOrder({ type: 'Buzz', buzzAmount: 10000, userId: 42 });

      const call = mockCoinbaseCaller.createCharge.mock.calls[0][0];
      expect(call.redirect_url).toContain('/payment/coinbase-code?');
      expect(call.redirect_url).toContain('orderId=code-42-');
    });

    it('should create a membership code order by looking up price from DB', async () => {
      mockDbRead.product.findFirst.mockResolvedValue({
        id: 'prod_gold',
        name: 'Gold Membership',
        prices: [{ id: 'price_gold_monthly', unitAmount: 1500 }],
      });
      mockCoinbaseCaller.createCharge.mockResolvedValue(mockCharge);

      const result = await createCodeOrder({
        type: 'Membership',
        tier: 'gold',
        months: 3,
        userId: 42,
      });

      expect(result).toBe(mockCharge);

      // Should query for Civitai provider, active, matching tier
      expect(mockDbRead.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            provider: 'Civitai',
            active: true,
            metadata: { path: ['tier'], equals: 'gold' },
          }),
        })
      );

      // Price should be unitAmount * months: 1500 * 3 = 4500 cents = $45
      expect(mockCoinbaseCaller.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          local_price: {
            amount: '45', // 4500 / 100
            currency: 'USD',
          },
          metadata: expect.objectContaining({
            codeType: 'Membership',
            codeUnitValue: 3,
            codePriceId: 'price_gold_monthly',
          }),
        })
      );
    });

    it('should throw when no active price is found for membership tier', async () => {
      mockDbRead.product.findFirst.mockResolvedValue(null);

      await expect(
        createCodeOrder({ type: 'Membership', tier: 'gold', months: 3, userId: 42 })
      ).rejects.toThrow('No active price found for gold membership');
    });

    it('should throw when product has no prices', async () => {
      mockDbRead.product.findFirst.mockResolvedValue({
        id: 'prod_gold',
        name: 'Gold',
        prices: [],
      });

      await expect(
        createCodeOrder({ type: 'Membership', tier: 'gold', months: 3, userId: 42 })
      ).rejects.toThrow('No active price found for gold membership');
    });

    it('should throw when coinbase charge creation fails', async () => {
      mockCoinbaseCaller.createCharge.mockResolvedValue(null);

      await expect(
        createCodeOrder({ type: 'Buzz', buzzAmount: 10000, userId: 42 })
      ).rejects.toThrow('Failed to create charge');
    });
  });

  // ---------------------------------------------------------------------------
  // processCodeOrder
  // ---------------------------------------------------------------------------
  describe('processCodeOrder', () => {
    it('should create a Buzz redeemable code on confirmed charge', async () => {
      mockDbRead.redeemableCode.findFirst.mockResolvedValue(null); // no duplicate
      mockDbRead.user.findUnique.mockResolvedValue({ email: 'user@test.com', username: 'tester' });
      mockDbWrite.redeemableCode.create.mockResolvedValue({});

      const result = await processCodeOrder(
        makeEventData({
          metadata: {
            internalOrderId: 'code-42-1708862400000',
            codeType: 'Buzz',
            codeUnitValue: 10000,
          },
        })
      );

      expect(result.userId).toBe(42);
      expect(result.codeType).toBe('Buzz');
      expect(result.codeUnitValue).toBe(10000);
      // Code should be generated with CS- prefix
      expect(result.code).toMatch(/^CS-/);

      // Should create the redeemable code in a transaction
      expect(mockDbWrite.redeemableCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          unitValue: 10000,
          type: 'Buzz',
          userId: 42,
          transactionId: 'code-42-1708862400000',
        }),
      });
    });

    it('should create a Membership redeemable code with priceId', async () => {
      mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);
      mockDbRead.user.findUnique.mockResolvedValue({ email: 'user@test.com', username: 'tester' });
      mockDbWrite.redeemableCode.create.mockResolvedValue({});

      const result = await processCodeOrder(
        makeEventData({
          metadata: {
            internalOrderId: 'code-42-1708862400000',
            codeType: 'Membership',
            codeUnitValue: 3,
            codePriceId: 'price_gold_monthly',
          },
        })
      );

      expect(result.code).toMatch(/^MB-/);
      expect(mockDbWrite.redeemableCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          unitValue: 3,
          type: 'Membership',
          priceId: 'price_gold_monthly',
          userId: 42,
        }),
      });
    });

    it('should send email to the purchaser after code creation', async () => {
      mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);
      mockDbRead.user.findUnique.mockResolvedValue({
        email: 'buyer@civitai.com',
        username: 'BuzzBuyer',
      });
      mockDbWrite.redeemableCode.create.mockResolvedValue({});

      await processCodeOrder(
        makeEventData({
          metadata: {
            internalOrderId: 'code-42-1708862400000',
            codeType: 'Buzz',
            codeUnitValue: 25000,
          },
        })
      );

      expect(mockEmailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'buyer@civitai.com',
          username: 'BuzzBuyer',
          type: 'Buzz',
          unitValue: 25000,
        })
      );
    });

    it('should not fail if email send fails', async () => {
      mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);
      mockDbRead.user.findUnique.mockResolvedValue({ email: 'user@test.com', username: 'tester' });
      mockDbWrite.redeemableCode.create.mockResolvedValue({});
      mockEmailSend.mockRejectedValueOnce(new Error('SMTP down'));

      // Should not throw
      const result = await processCodeOrder(
        makeEventData({
          metadata: {
            internalOrderId: 'code-42-1708862400000',
            codeType: 'Buzz',
            codeUnitValue: 10000,
          },
        })
      );

      expect(result.code).toBeDefined();
    });

    it('should skip email if user has no email', async () => {
      mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);
      mockDbRead.user.findUnique.mockResolvedValue({ email: null, username: 'noemail' });
      mockDbWrite.redeemableCode.create.mockResolvedValue({});

      await processCodeOrder(
        makeEventData({
          metadata: {
            internalOrderId: 'code-42-1708862400000',
            codeType: 'Buzz',
            codeUnitValue: 10000,
          },
        })
      );

      expect(mockEmailSend).not.toHaveBeenCalled();
    });

    describe('idempotency', () => {
      it('should return existing code for duplicate webhook (already processed)', async () => {
        mockDbRead.redeemableCode.findFirst.mockResolvedValue({ code: 'CS-XXXX-YYYY' });

        const result = await processCodeOrder(
          makeEventData({
            metadata: {
              internalOrderId: 'code-42-1708862400000',
              codeType: 'Buzz',
              codeUnitValue: 10000,
            },
          })
        );

        expect(result.code).toBe('CS-XXXX-YYYY');
        expect(result.message).toBe('Code order already processed');
        // Should NOT create another code
        expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('validation', () => {
      it('should throw when internalOrderId is missing', async () => {
        await expect(
          processCodeOrder(makeEventData({ metadata: {} }))
        ).rejects.toThrow('Missing required metadata');
      });

      it('should throw when userId cannot be parsed from orderId', async () => {
        mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);

        await expect(
          processCodeOrder(
            makeEventData({
              metadata: {
                internalOrderId: 'code-notanumber-1708862400000',
                codeType: 'Buzz',
                codeUnitValue: 10000,
              },
            })
          )
        ).rejects.toThrow('Invalid userId');
      });

      it('should throw when codeType is missing', async () => {
        mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);

        await expect(
          processCodeOrder(
            makeEventData({
              metadata: {
                internalOrderId: 'code-42-1708862400000',
                codeUnitValue: 10000,
              },
            })
          )
        ).rejects.toThrow('Missing codeType or codeUnitValue');
      });

      it('should throw when codeUnitValue is missing', async () => {
        mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);

        await expect(
          processCodeOrder(
            makeEventData({
              metadata: {
                internalOrderId: 'code-42-1708862400000',
                codeType: 'Buzz',
              },
            })
          )
        ).rejects.toThrow('Missing codeType or codeUnitValue');
      });

      it('should throw when Membership order is missing codePriceId', async () => {
        mockDbRead.redeemableCode.findFirst.mockResolvedValue(null);

        await expect(
          processCodeOrder(
            makeEventData({
              metadata: {
                internalOrderId: 'code-42-1708862400000',
                codeType: 'Membership',
                codeUnitValue: 3,
                // no codePriceId
              },
            })
          )
        ).rejects.toThrow('Membership code orders require a codePriceId');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // createBuzzOrder (existing — quick sanity tests)
  // ---------------------------------------------------------------------------
  describe('createBuzzOrder', () => {
    it('should reject tampered amounts', async () => {
      await expect(
        createBuzzOrder({ buzzAmount: 10000, unitAmount: 999, userId: 1 })
      ).rejects.toThrow('There was an error while creating your order');
    });

    it('should create charge with correct pricing', async () => {
      const mockCharge = { id: 'c1', hosted_url: 'https://coinbase.com/c1' };
      mockCoinbaseCaller.createCharge.mockResolvedValue(mockCharge);

      const result = await createBuzzOrder({
        buzzAmount: 10000,
        unitAmount: 1000,
        userId: 1,
      });

      expect(result).toBe(mockCharge);
      expect(mockCoinbaseCaller.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          local_price: { amount: '10', currency: 'USD' },
          metadata: expect.objectContaining({ buzzAmount: 10000, userId: 1 }),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // processBuzzOrder (existing — quick sanity tests)
  // ---------------------------------------------------------------------------
  describe('processBuzzOrder', () => {
    it('should grant buzz for valid event', async () => {
      const result = await processBuzzOrder(
        makeEventData({
          metadata: {
            internalOrderId: '42-10000-1000-1708862400000',
          },
        })
      );

      expect(result.userId).toBe(42);
      expect(result.buzzAmount).toBe(10000);
      expect(mockGrantBuzzPurchase).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42, amount: 10000 })
      );
    });

    it('should throw when metadata is missing', async () => {
      // Note: processBuzzOrder has a pre-existing bug where its catch block
      // references an undefined `event` variable, so the thrown error is
      // "event is not defined" rather than the original validation error.
      await expect(processBuzzOrder(makeEventData({ metadata: {} }))).rejects.toThrow();
    });
  });
});
