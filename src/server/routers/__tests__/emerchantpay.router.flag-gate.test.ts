import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as EmerchantPayController from '~/server/controllers/emerchantpay.controller';

/** eMerchantPay is retired: with the default flags, none of its procedures answers anyone. */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
});

const { handler } = vi.hoisted(() => ({ handler: vi.fn(async () => 'ok') }));

vi.mock('~/server/controllers/emerchantpay.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof EmerchantPayController>()),
  getStatus: handler,
  createBuzzOrderHandler: handler,
  getTransactionStatusHandler: handler,
}));

import { OnboardingComplete } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The caller reads its credentials when its module loads.
setEnv({
  EMERCHANTPAY_WPF_URL: 'https://emerchantpay.test',
  EMERCHANTPAY_USERNAME: 'user',
  EMERCHANTPAY_PASSWORD: 'password',
});
const { emerchantpayRouter } = await import('~/server/routers/emerchantpay.router');

const ctxFor = (user?: Record<string, unknown>) =>
  ({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host: 'civitai.com' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    // The base chain reads this; isFlagProtected computes the flags itself from user and host.
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

const PROCEDURES: [
  string,
  (c: ReturnType<typeof emerchantpayRouter.createCaller>) => Promise<unknown>
][] = [
  ['getStatus', (c) => c.getStatus()],
  ['createBuzzOrder', (c) => c.createBuzzOrder({ unitAmount: 1000, buzzAmount: 1000 } as never)],
  ['getTransactionStatus', (c) => c.getTransactionStatus({ id: 'tx-1' })],
];

beforeEach(() => {
  handler.mockClear();
});

describe('emerchantpay router with the default flags', () => {
  it.each(PROCEDURES)('refuses %s to a signed-in user', async (_name, call) => {
    const caller = emerchantpayRouter.createCaller(
      ctxFor({ id: 41, username: 'buyer', onboarding: OnboardingComplete })
    );

    await expect(call(caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses getStatus to a signed-out visitor', async () => {
    await expect(emerchantpayRouter.createCaller(ctxFor()).getStatus()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
