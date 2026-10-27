import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOpenDepositReport, watchOpenDeposits, reconcileDeposits, processDeposit } = vi.hoisted(
  () => ({
    getOpenDepositReport: vi.fn(),
    watchOpenDeposits: vi.fn(),
    reconcileDeposits: vi.fn(),
    processDeposit: vi.fn(),
  })
);

// The moderator check has its own suite; this one is about what the handler returns and does.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  ModEndpoint: (handler: unknown) => handler,
}));
// The real service builds the NowPayments client at load. Every export that does work is a spy,
// so a handler that started calling one would show up below.
vi.mock('~/server/services/nowpayments.service', () => ({
  getOpenDepositReport,
  watchOpenDeposits,
  reconcileDeposits,
  processDeposit,
}));

const { default: handler } = (await import(
  '~/pages/api/mod/nowpayments/open-deposits'
)) as unknown as {
  default: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
};

const call = async () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await handler({ method: 'GET', query: {} } as NextApiRequest, res as unknown as NextApiResponse);
  return { status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] };
};

beforeEach(() => vi.clearAllMocks());

describe('GET /api/mod/nowpayments/open-deposits', () => {
  it('returns the open and held deposits with their counts, and triggers no work', async () => {
    const counts = { open: 1, oldestOpenDays: 5, held: 1, finishedUncredited: 0 };
    getOpenDepositReport.mockResolvedValueOnce({
      counts,
      items: [
        {
          paymentId: '1001',
          userId: 1,
          username: 'a',
          status: 'confirmed',
          payCurrency: 'btc',
          payAmount: 0.01,
          daysOpen: 5,
          held: false,
        },
        {
          paymentId: '1002',
          userId: 2,
          username: 'b',
          status: 'held',
          payCurrency: 'eth',
          payAmount: 1,
          daysOpen: 0,
          held: true,
        },
      ],
    });

    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body).toEqual({
      counts,
      deposits: [
        {
          paymentId: '1001',
          userId: 1,
          coin: 'btc',
          actuallyPaid: 0.01,
          npStatus: 'confirmed',
          daysOpen: 5,
          heldForReview: false,
        },
        {
          paymentId: '1002',
          userId: 2,
          coin: 'eth',
          actuallyPaid: 1,
          npStatus: 'held',
          daysOpen: 0,
          heldForReview: true,
        },
      ],
    });
    expect(watchOpenDeposits).not.toHaveBeenCalled();
    expect(reconcileDeposits).not.toHaveBeenCalled();
    expect(processDeposit).not.toHaveBeenCalled();
  });
});
