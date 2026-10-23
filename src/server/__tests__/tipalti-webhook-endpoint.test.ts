import { beforeEach, describe, expect, it, vi } from 'vitest';

// The handler pulls these in at module scope; install canonical mocks first.
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as CreatorProgramService from '~/server/services/creator-program.service';
import type * as UserPaymentConfigurationService from '~/server/services/user-payment-configuration.service';

const { bust, updateByTipaltiAccount, validateWebhookEvent } = vi.hoisted(() => ({
  bust: vi.fn(async () => undefined),
  updateByTipaltiAccount: vi.fn(async () => ({ userId: 42 })),
  // Signature validation is not what this suite tests; hold it valid and vary the body.
  validateWebhookEvent: vi.fn(() => ({ isValid: true })),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/http/tipalti/tipalti.caller', () => ({
  default: async () => ({ validateWebhookEvent }),
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorProgramService>()),
  userCashCache: { bust },
}));
vi.mock('~/server/services/user-payment-configuration.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPaymentConfigurationService>()),
  updateByTipaltiAccount,
}));

const handler = (await import('~/pages/api/webhooks/tipalti')).default;

const run = async (eventData: Record<string, unknown>) => {
  const body = JSON.stringify({ id: 'evt-1', type: 'payeeDetailsChanged', eventData });
  const req = {
    method: 'POST',
    headers: { 'tipalti-signature': 'sig' },
    body,
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };

  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
    once: () => res,
    _status: () => statusCode,
  };
  await handler(req as never, res as never);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ TIPALTI_WEBTOKEN_SECRET: 'secret' });
});

describe('tipalti webhook endpoint: payeeDetailsChanged', () => {
  // withdrawCash refuses on the cached 'pending' status, so a stale cache blocks a newly Active
  // creator for the cache's day-long TTL.
  it('busts the cash cache for the user whose payment configuration was updated', async () => {
    // The payeeId deliberately differs from the returned row, so the bust must use the row.
    const res = await run({ payeeId: '7', status: 'Active', isPayable: true });

    expect(updateByTipaltiAccount).toHaveBeenCalledTimes(1);
    expect(bust).toHaveBeenCalledTimes(1);
    expect(bust).toHaveBeenCalledWith(42);
    expect(res._status()).toBe(200);
  });

  it('does not bust the cache when the payment configuration update fails', async () => {
    updateByTipaltiAccount.mockRejectedValueOnce(new Error('User tipalti account not found'));

    const res = await run({ payeeId: '7', status: 'Active', isPayable: true });

    expect(bust).not.toHaveBeenCalled();
    expect(res._status()).toBe(400);
  });
});
