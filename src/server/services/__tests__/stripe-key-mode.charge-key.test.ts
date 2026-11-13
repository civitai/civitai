import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';

/**
 * getBuzzPackages serves the live Buzz row under every key mode. That is safe only while it stays
 * a database read and the Stripe client is built from STRIPE_SECRET_KEY.
 */

const { StripeCtor } = vi.hoisted(() => ({
  StripeCtor: vi.fn(function (this: { key: string }, key: string) {
    this.key = key;
  }),
}));
vi.mock('stripe', () => ({ default: StripeCtor }));

const TEST_KEY = 'sk_test_00000000000000000000';

beforeEach(() => {
  resetSharedMocks();
  vi.resetModules();
  StripeCtor.mockClear();
  setEnv({ STRIPE_SECRET_KEY: TEST_KEY });
});

describe('Buzz under a sandbox key', () => {
  it('builds the charging client from the sandbox key', async () => {
    const { getServerStripe } = await import('~/server/utils/get-server-stripe');
    const client = (await getServerStripe()) as unknown as { key: string };
    expect(StripeCtor).toHaveBeenCalledTimes(1);
    expect(client.key).toBe(TEST_KEY);
  });

  it('reads the live packages without touching Stripe', async () => {
    dbMock.dbRead.product.findMany.mockResolvedValue([
      {
        id: 'prod_sandbox_buzz',
        name: 'Buzz',
        description: null,
        defaultPriceId: null,
        metadata: { tier: 'buzz', live_id: 'prod_live_buzz' },
        prices: [{ id: 'p0', description: null, unitAmount: 1000, currency: 'usd', metadata: {} }],
      },
      {
        id: 'prod_live_buzz',
        name: 'Buzz',
        description: null,
        defaultPriceId: null,
        metadata: { tier: 'buzz' },
        prices: [{ id: 'p1', description: null, unitAmount: 1000, currency: 'usd', metadata: {} }],
      },
    ]);
    const { getBuzzPackages } = await import('~/server/services/stripe.service');
    expect((await getBuzzPackages()).map((p) => p.id)).toEqual(['p1']);
    expect(StripeCtor).not.toHaveBeenCalled();
  });
});
