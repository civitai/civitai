import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';
import { getBuzzPackages } from '~/server/services/stripe.service';
import { getPlans } from '~/server/services/subscriptions.service';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

/**
 * A dev database can hold the live Stripe catalogue and a sandbox copy of it side by side; the
 * copy is the rows whose metadata carries `live_id`. Each key must see only its own catalogue,
 * and a live key must see exactly what it saw before sandbox rows existed.
 */

const LIVE_KEY = 'sk_live_00000000000000000000';
const TEST_KEY = 'sk_test_00000000000000000000';

const plan = (id: string, provider: string, metadata: Record<string, string> = {}) => ({
  id,
  name: id,
  description: null,
  metadata: { tier: 'gold', ...metadata },
  defaultPriceId: `${id}-price`,
  provider,
  prices: [
    {
      id: `${id}-price`,
      interval: 'month',
      intervalCount: 1,
      type: 'recurring',
      unitAmount: 1000,
      currency: 'usd',
      metadata: {},
    },
  ],
});

const liveGold = plan('prod_live_gold', 'Stripe');
const sandboxGold = plan('prod_sandbox_gold', 'Stripe', { live_id: 'prod_live_gold' });

const plans = (key: string, paymentProvider = PaymentProvider.Stripe) => {
  setEnv({ STRIPE_SECRET_KEY: key });
  return getPlans({ paymentProvider }).then((rows) => rows.map((r) => r.id));
};

beforeEach(() => {
  resetSharedMocks();
});

describe('getPlans by Stripe key mode', () => {
  beforeEach(() => {
    dbMock.dbWrite.product.findMany.mockResolvedValue([sandboxGold, liveGold]);
  });

  it('shows a live key only the live rows', async () => {
    expect(await plans(LIVE_KEY)).toEqual(['prod_live_gold']);
  });

  it.each([
    ['no key', undefined],
    ['a restricted live key', 'rk_live_00000000000000000000'],
  ])('reads %s as live, so a catalogue without sandbox rows is listed whole', async (_, key) => {
    dbMock.dbWrite.product.findMany.mockResolvedValue([liveGold]);
    expect(await plans(key as string)).toEqual(['prod_live_gold']);
  });

  it.each([TEST_KEY, 'rk_test_00000000000000000000'])(
    'shows a sandbox key (%s) only the sandbox copies',
    async (key) => {
      expect(await plans(key)).toEqual(['prod_sandbox_gold']);
    }
  );

  it.each([LIVE_KEY, TEST_KEY])('leaves other providers alone (%s)', async (key) => {
    dbMock.dbWrite.product.findMany.mockResolvedValue([
      plan('pro_paddle_gold', 'Paddle'),
      plan('pro_paddle_marked', 'Paddle', { live_id: 'x' }),
    ]);
    expect(await plans(key, PaymentProvider.Paddle)).toEqual([
      'pro_paddle_gold',
      'pro_paddle_marked',
    ]);
  });
});

describe('getBuzzPackages', () => {
  const buzz = (id: string, metadata: Record<string, string>) => ({
    id,
    name: 'Buzz',
    description: null,
    defaultPriceId: null,
    metadata: { tier: 'buzz', ...metadata },
    prices: [
      { id: `${id}-1000`, description: null, unitAmount: 1000, currency: 'usd', metadata: {} },
    ],
  });

  it.each([LIVE_KEY, TEST_KEY])(
    'reads the live Buzz row, not a sandbox copy listed first (%s)',
    async (key) => {
      setEnv({ STRIPE_SECRET_KEY: key });
      dbMock.dbRead.product.findMany.mockResolvedValue([
        buzz('prod_sandbox_buzz', { live_id: 'prod_live_buzz' }),
        buzz('prod_live_buzz', {}),
      ]);
      expect((await getBuzzPackages()).map((p) => p.id)).toEqual(['prod_live_buzz-1000']);
    }
  );
});
