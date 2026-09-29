import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  authenticate: vi.fn(async () => 'jwt'),
  createPayout: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'batch-1' })),
}));

vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: mocks }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import { custodySweepJob } from '~/server/jobs/custody-sweep';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const DEDUP_KEY = 'custody-sweep:last-payout';

// The shape `GET /v1/balance` answers with: an object keyed by currency, amounts as numbers.
// Amounts are illustrative; the shape is what the provider returned when this was written.
const balancePayload = ({
  usdcbase = 0,
  usdcbasePending = 0,
  usdcsol = 0,
}: {
  usdcbase?: number;
  usdcbasePending?: number;
  usdcsol?: number;
}) => ({
  usdcbase: { amount: usdcbase, pendingAmount: usdcbasePending },
  eth: { amount: 0, pendingAmount: 0 },
  sol: { amount: 0, pendingAmount: 0 },
  usdcsol: { amount: usdcsol, pendingAmount: 0 },
});

const balanceIs = (payload: unknown) =>
  mocks.getBalance.mockResolvedValue(NOWPayments.balanceResponseSchema.parse(payload));

const runJob = () =>
  (custodySweepJob as unknown as { run: () => Promise<Record<string, unknown>> }).run();

describe('custody-sweep', () => {
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
    const parsed = NOWPayments.balanceResponseSchema.parse(balancePayload({ usdcbase: 120.456 }));
    expect(parsed.usdcbase).toEqual({ amount: 120.456, pendingAmount: 0 });
  });

  it('pays out the settled usdcbase balance less the buffer, excluding pending funds', async () => {
    balanceIs(balancePayload({ usdcbase: 120.456, usdcbasePending: 50 }));

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

  it('records the payout guard before creating the payout', async () => {
    balanceIs(balancePayload({ usdcbase: 120.456 }));

    await runJob();

    expect(redisMock.redis.set).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.set).toHaveBeenCalledWith(DEDUP_KEY, expect.any(String), { EX: 3600 });
    expect(redisMock.redis.set.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createPayout.mock.invocationCallOrder[0]
    );
  });

  it('skips without reading the balance when a payout was recorded recently', async () => {
    redisMock.redis.get.mockResolvedValue('2026-09-29T04:00:00.000Z');
    balanceIs(balancePayload({ usdcbase: 120.456 }));

    const result = await runJob();

    expect(result).toEqual(expect.objectContaining({ skipped: true }));
    expect(mocks.getBalance).not.toHaveBeenCalled();
    expect(mocks.createPayout).not.toHaveBeenCalled();
  });

  it('clears the payout guard when the payout is refused', async () => {
    balanceIs(balancePayload({ usdcbase: 120.456 }));
    mocks.createPayout.mockResolvedValueOnce(null);

    await expect(runJob()).rejects.toThrow('Failed to create payout');
    expect(redisMock.redis.del).toHaveBeenCalledWith(DEDUP_KEY);
  });

  it('reads only usdcbase, not another currency above the threshold', async () => {
    balanceIs(balancePayload({ usdcbase: 3, usdcbasePending: 10, usdcsol: 500 }));

    const result = await runJob();

    expect(result).toEqual({ skipped: true, balance: 3, threshold: 5 });
    expect(mocks.createPayout).not.toHaveBeenCalled();
  });

  it('does not sweep a balance exactly at the threshold', async () => {
    balanceIs(balancePayload({ usdcbase: 5 }));

    const result = await runJob();

    expect(result).toEqual({ skipped: true, balance: 5, threshold: 5 });
    expect(mocks.createPayout).not.toHaveBeenCalled();
  });

  it('throws when the response has no usdcbase entry', async () => {
    balanceIs({ usdcsol: { amount: 500, pendingAmount: 0 } });

    await expect(runJob()).rejects.toThrow('Invalid balance value: not found');
    expect(mocks.createPayout).not.toHaveBeenCalled();
  });
});
