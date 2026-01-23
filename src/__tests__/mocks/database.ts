import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { SubscriptionMetadata, SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

// Factory functions for creating test data
export const createMockProduct = (overrides: Partial<MockProduct> = {}): MockProduct => ({
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

export const createMockPrice = (overrides: Partial<MockPrice> = {}): MockPrice => ({
  id: 'price_test_123',
  currency: 'USD',
  interval: 'month',
  product: createMockProduct(),
  ...overrides,
});

export const createMockRedeemableCode = (
  overrides: Partial<MockRedeemableCode> = {}
): MockRedeemableCode => ({
  code: 'MB-TEST-1234',
  unitValue: 3,
  type: 'Membership',
  userId: null,
  priceId: 'price_test_123',
  price: createMockPrice(),
  redeemedAt: null,
  expiresAt: null,
  transactionId: null,
  ...overrides,
});

export const createMockSubscription = (
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

// Type definitions for mock objects
export interface MockProduct {
  id: string;
  name: string;
  metadata: Partial<SubscriptionProductMetadata>;
  provider: string;
  prices?: MockPrice[];
}

export interface MockPrice {
  id: string;
  currency: string;
  interval: string;
  product: MockProduct;
}

export interface MockRedeemableCode {
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

export interface MockSubscription {
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

// Create mock database client
export const createMockDbWrite = () => {
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
    upsert: vi.fn(),
    update: vi.fn(),
  };

  return {
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
  };
};

export const createMockDbRead = () => {
  return {
    keyValue: {
      findUnique: vi.fn(),
    },
  };
};

// Tier products for transition tests
export const createTierProducts = (): MockProduct[] => [
  {
    id: 'prod_bronze',
    name: 'Bronze Membership',
    metadata: { tier: 'bronze', monthlyBuzz: 10000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_bronze', currency: 'USD', interval: 'month', product: null as any }],
  },
  {
    id: 'prod_silver',
    name: 'Silver Membership',
    metadata: { tier: 'silver', monthlyBuzz: 25000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_silver', currency: 'USD', interval: 'month', product: null as any }],
  },
  {
    id: 'prod_gold',
    name: 'Gold Membership',
    metadata: { tier: 'gold', monthlyBuzz: 50000, buzzType: 'yellow' },
    provider: 'Civitai',
    prices: [{ id: 'price_gold', currency: 'USD', interval: 'month', product: null as any }],
  },
];
