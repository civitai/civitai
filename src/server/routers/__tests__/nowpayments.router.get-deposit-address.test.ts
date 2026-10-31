import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import type * as NowPaymentsController from '~/server/controllers/nowpayments.controller';

// The real rateLimit middleware runs here: it stands down under isTest, so that is turned off.
const { mockGetDepositAddressHandler, mockHSetWithTTL } = vi.hoisted(() => ({
  mockGetDepositAddressHandler: vi.fn(async (_opts: unknown) => ({
    address: 'addr',
    paymentId: 1,
    chain: 'evm',
  })),
  mockHSetWithTTL: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('~/server/controllers/nowpayments.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof NowPaymentsController>()),
  getDepositAddressHandler: mockGetDepositAddressHandler,
}));
// The caller checks its env at load; nothing here reaches NowPayments.
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: {} }));
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  isDev: false,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));

import { TRPCError } from '@trpc/server';
import { nowPaymentsRouter } from '../nowpayments.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockHGet = redisMock.redis.packed.hGet;
const user = { id: 7, isModerator: false, tier: 'free', username: 'depositor', onboarding: 0x1f };

function call(chain?: string) {
  const ctx = {
    acceptableOrigin: true,
    user: user as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
  return nowPaymentsRouter.createCaller(ctx as never).getDepositAddress({ chain });
}

/** `n` recorded attempts spread evenly across the `spanMs` before now, shifted back by `offsetMs`. */
function attemptsSpanning(n: number, spanMs: number, offsetMs = 0) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => now - offsetMs - Math.round((spanMs * i) / n));
}

const MINUTE = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  mockHGet.mockResolvedValue([]);
});

describe('nowPayments.getDepositAddress rate limit', () => {
  it('refuses once the last hour holds more than 60 calls', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(61, 59 * MINUTE));

    const err = await call().then(
      () => null,
      (e: unknown) => e as TRPCError
    );

    expect(err).toBeInstanceOf(TRPCError);
    expect(err?.code).toBe('TOO_MANY_REQUESTS');
    expect(mockGetDepositAddressHandler).not.toHaveBeenCalled();
  });

  it('still serves the 60th call in the hour', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(60, 59 * MINUTE));

    await expect(call()).resolves.toMatchObject({ address: 'addr' });
  });

  it('ages calls out after an hour', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(200, 30 * MINUTE, 61 * MINUTE));

    await expect(call()).resolves.toMatchObject({ address: 'addr' });
  });

  it('counts calls per user', async () => {
    await call();

    expect(mockHSetWithTTL.mock.calls[0]?.[2]).toBe(`user:${user.id}`);
  });
});

describe('nowPayments.getDepositAddress input', () => {
  it('defaults to evm and refuses a chain that is not a lowercase id', async () => {
    await call();
    expect(mockGetDepositAddressHandler.mock.calls[0]?.[0]).toMatchObject({
      input: { chain: 'evm' },
    });

    for (const chain of ['EVM', 'evm ', 'e/v', 'a'.repeat(21), '']) {
      await expect(call(chain), chain).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockGetDepositAddressHandler).toHaveBeenCalledTimes(1);
  });
});
