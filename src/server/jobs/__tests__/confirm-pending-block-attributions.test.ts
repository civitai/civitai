import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the daily cron that promotes pending block_buzz_attribution
 * rows to confirmed once they're past the provider's refund window.
 * Validates the per-provider window math and the idempotent shape of
 * the WHERE clause.
 */

const { mockDbWrite } = vi.hoisted(() => ({
  mockDbWrite: {
    blockBuzzAttribution: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: () => Promise.resolve(null),
}));
// createJob from ./job wraps the handler in metadata-tracking machinery
// we don't need here — stub it to just return the bare handler.
vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: () => unknown) => fn,
}));

import { confirmPendingBlockAttributions } from '../confirm-pending-block-attributions';

beforeEach(() => {
  mockDbWrite.blockBuzzAttribution.updateMany.mockReset();
  vi.useRealTimers();
});

describe('confirmPendingBlockAttributions', () => {
  it('issues one updateMany per provider with the right cutoff', async () => {
    const now = new Date('2026-06-30T03:15:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValue({ count: 0 });

    await confirmPendingBlockAttributions();

    expect(mockDbWrite.blockBuzzAttribution.updateMany).toHaveBeenCalledTimes(3);
    const calls = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls;
    const byProvider = Object.fromEntries(
      calls.map((c) => [c[0].where.paymentProvider, c[0]])
    );

    // Stripe: 30-day window
    expect(byProvider.stripe.where.status).toBe('pending');
    expect(byProvider.stripe.where.attributedAt.lt).toEqual(
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    );
    // Paddle: 14-day window
    expect(byProvider.paddle.where.attributedAt.lt).toEqual(
      new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    );
    // NOWPayments: 1-day window (crypto)
    expect(byProvider.nowpayments.where.attributedAt.lt).toEqual(
      new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)
    );

    // Each call promotes pending → confirmed
    for (const provider of ['stripe', 'paddle', 'nowpayments'] as const) {
      expect(byProvider[provider].data.status).toBe('confirmed');
      expect(byProvider[provider].data.confirmedAt).toBeInstanceOf(Date);
    }
  });

  it('aggregates confirmed counts across providers', async () => {
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 5 });
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 2 });
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await confirmPendingBlockAttributions();

    expect(result).toEqual({ totalConfirmed: 7 });
  });

  it('is idempotent — only filters status=pending', async () => {
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValue({ count: 0 });
    await confirmPendingBlockAttributions();
    for (const call of mockDbWrite.blockBuzzAttribution.updateMany.mock.calls) {
      expect(call[0].where.status).toBe('pending');
    }
  });
});
