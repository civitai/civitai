import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  authenticate: vi.fn(async () => 'jwt'),
  createPayout: vi.fn(async () => ({ id: 'batch-1' })),
}));

vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: mocks }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import { custodySweepJob } from '~/server/jobs/custody-sweep';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// The shape `GET /v1/balance` answers with: an object keyed by currency, amounts as numbers.
// Amounts are illustrative; the shape is what the provider returned when this was written.
const balancePayload = (usdcbase: number, usdcsol = 0) => ({
  usdcbase: { amount: usdcbase, pendingAmount: 0 },
  eth: { amount: 0, pendingAmount: 0 },
  sol: { amount: 0, pendingAmount: 0 },
  usdcsol: { amount: usdcsol, pendingAmount: 0 },
});

const runJob = () =>
  (custodySweepJob as unknown as { run: () => Promise<Record<string, unknown>> }).run();

describe('custody-sweep balance handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv({
      NOW_PAYMENTS_EMAIL: 'ops@example.com',
      NOW_PAYMENTS_PASSWORD: 'pw',
      NOW_PAYMENTS_PAYOUT_ADDRESS: '0xpayout',
    });
    redisMock.redis.get.mockResolvedValue(null);
  });

  it("parses the provider's per-currency balance object", () => {
    const parsed = NOWPayments.balanceResponseSchema.parse(balancePayload(120.456));
    expect(parsed.usdcbase).toEqual({ amount: 120.456, pendingAmount: 0 });
  });

  it('pays out the usdcbase balance less the buffer', async () => {
    mocks.getBalance.mockResolvedValue(
      NOWPayments.balanceResponseSchema.parse(balancePayload(120.456))
    );

    const result = await runJob();

    expect(result).toEqual({
      batchId: 'batch-1',
      amount: 119.45,
      remainingBalance: expect.closeTo(1.006, 6),
    });
    expect(mocks.createPayout).toHaveBeenCalledTimes(1);
    const [input] = mocks.createPayout.mock.calls[0] as unknown as [NOWPayments.CreatePayoutInput];
    expect(input.withdrawals).toEqual([
      expect.objectContaining({ address: '0xpayout', currency: 'usdcbase', amount: 119.45 }),
    ]);
  });

  it('reads only usdcbase, not another currency above the threshold', async () => {
    mocks.getBalance.mockResolvedValue(
      NOWPayments.balanceResponseSchema.parse(balancePayload(3, 500))
    );

    const result = await runJob();

    expect(result).toEqual({ skipped: true, balance: 3, threshold: 5 });
    expect(mocks.createPayout).not.toHaveBeenCalled();
  });
});
