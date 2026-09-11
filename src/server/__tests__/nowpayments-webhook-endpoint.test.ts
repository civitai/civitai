import { beforeEach, describe, expect, it, vi } from 'vitest';

// The handler pulls these in at module scope; install canonical mocks first.
import '~/__tests__/mocks/logging.mock';

const { env, processDeposit, validateWebhookEvent } = vi.hoisted(() => ({
  env: { NOW_PAYMENTS_IPN_KEY: 'ipn-secret' } as { NOW_PAYMENTS_IPN_KEY?: string },
  processDeposit: vi.fn(async () => ({ userId: 42, buzzAmount: 0, transactionId: undefined })),
  // Signature validation is not what this suite tests; hold it valid and vary the body.
  validateWebhookEvent: vi.fn((_sig: string, body: unknown) => ({ isValid: true, ...(body as object) })),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ trackWebhookEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({
  default: { validateWebhookEvent },
}));
vi.mock('~/server/services/nowpayments.service', () => ({ processDeposit }));

const handler = (await import('~/pages/api/webhooks/nowpayments')).default;

function createMocks(body: unknown) {
  const req = { method: 'POST', headers: { 'x-nowpayments-sig': 'sig' }, body } as Record<
    string,
    unknown
  >;

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
  return { req, res };
}

const run = (payment_status: string) => {
  const { req, res } = createMocks({ payment_id: 12345, payment_status, order_id: 'user:42' });
  return handler(req as never, res as never).then(() => res);
};

beforeEach(() => {
  vi.clearAllMocks();
  env.NOW_PAYMENTS_IPN_KEY = 'ipn-secret';
});

describe('nowpayments webhook endpoint', () => {
  it('routes a failed event to processDeposit', async () => {
    await run('failed');

    expect(processDeposit).toHaveBeenCalledTimes(1);
    expect(processDeposit).toHaveBeenCalledWith(12345, 'failed', expect.any(Object));
  });

  it.each(['confirming', 'finished', 'partially_paid'])(
    'routes a %s event to processDeposit',
    async (status) => {
      await run(status);
      expect(processDeposit).toHaveBeenCalledWith(12345, status, expect.any(Object));
    }
  );

  it('does not process a non-actionable status', async () => {
    const res = await run('waiting');

    expect(processDeposit).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });
});
