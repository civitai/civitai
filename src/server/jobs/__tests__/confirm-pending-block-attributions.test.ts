import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the daily cron that promotes pending block_buzz_attribution
 * rows to confirmed once they're past the provider's refund window — with
 * the PAYOUT-1 velocity/volume hold gate. Validates the per-provider
 * window math, the per-owner hold decision, and the idempotent shape of
 * the WHERE clauses.
 */

const { mockDbWrite } = vi.hoisted(() => ({
  mockDbWrite: {
    blockBuzzAttribution: {
      groupBy: vi.fn(),
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

import {
  confirmPendingBlockAttributions,
  HOLD_VELOCITY_CENTS,
  HOLD_VELOCITY_COUNT,
} from '../confirm-pending-block-attributions';

beforeEach(() => {
  mockDbWrite.blockBuzzAttribution.groupBy.mockReset();
  mockDbWrite.blockBuzzAttribution.updateMany.mockReset();
  vi.useRealTimers();
});

/** No owners over threshold → every provider returns an empty group. */
function noHoldGroups() {
  mockDbWrite.blockBuzzAttribution.groupBy.mockResolvedValue([]);
}

describe('confirmPendingBlockAttributions', () => {
  it('issues one groupBy + one confirm updateMany per provider with the right cutoff', async () => {
    const now = new Date('2026-06-30T03:15:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    noHoldGroups();
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValue({ count: 0 });

    await confirmPendingBlockAttributions();

    // No owner held → no held updateMany, one confirm updateMany per provider.
    expect(mockDbWrite.blockBuzzAttribution.groupBy).toHaveBeenCalledTimes(3);
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

    // Each confirm promotes pending → confirmed
    for (const provider of ['stripe', 'paddle', 'nowpayments'] as const) {
      expect(byProvider[provider].data.status).toBe('confirmed');
      expect(byProvider[provider].data.confirmedAt).toBeInstanceOf(Date);
    }
  });

  it('aggregates confirmed + held counts across providers', async () => {
    noHoldGroups();
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 5 });
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 2 });
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await confirmPendingBlockAttributions();

    expect(result).toEqual({ totalConfirmed: 7, totalHeld: 0 });
  });

  it('every read + write only ever filters status=pending (idempotent)', async () => {
    noHoldGroups();
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValue({ count: 0 });
    await confirmPendingBlockAttributions();
    for (const call of mockDbWrite.blockBuzzAttribution.groupBy.mock.calls) {
      expect(call[0].where.status).toBe('pending');
    }
    for (const call of mockDbWrite.blockBuzzAttribution.updateMany.mock.calls) {
      expect(call[0].where.status).toBe('pending');
    }
  });

  it('holds an owner whose candidate COUNT exceeds the threshold', async () => {
    // First provider (stripe) has one over-count owner; the other two clean.
    mockDbWrite.blockBuzzAttribution.groupBy
      .mockResolvedValueOnce([
        { appOwnerUserId: 7, _count: HOLD_VELOCITY_COUNT + 1, _sum: { appOwnerShareCents: 10 } },
        { appOwnerUserId: 8, _count: 3, _sum: { appOwnerShareCents: 10 } },
      ])
      .mockResolvedValue([]);
    // stripe: held updateMany then confirm updateMany; others: confirm only.
    mockDbWrite.blockBuzzAttribution.updateMany
      .mockResolvedValueOnce({ count: 201 }) // held
      .mockResolvedValueOnce({ count: 3 }) // confirmed (stripe, owner 8)
      .mockResolvedValueOnce({ count: 0 }) // paddle confirm
      .mockResolvedValueOnce({ count: 0 }); // nowpayments confirm

    const result = await confirmPendingBlockAttributions();

    expect(result.totalHeld).toBe(201);
    expect(result.totalConfirmed).toBe(3);

    const heldCall = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(heldCall.where.appOwnerUserId).toEqual({ in: [7] });
    expect(heldCall.data.status).toBe('held');
    expect(heldCall.data.holdReason).toBe('velocity');
    expect(heldCall.data.heldAt).toBeInstanceOf(Date);

    const confirmCall = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[1][0];
    expect(confirmCall.where.appOwnerUserId).toEqual({ notIn: [7] });
    expect(confirmCall.data.status).toBe('confirmed');
  });

  it('holds an owner whose candidate CENTS exceeds the threshold', async () => {
    mockDbWrite.blockBuzzAttribution.groupBy
      .mockResolvedValueOnce([
        {
          appOwnerUserId: 42,
          _count: 5, // under count threshold
          _sum: { appOwnerShareCents: HOLD_VELOCITY_CENTS + 1 }, // over cents
        },
      ])
      .mockResolvedValue([]);
    mockDbWrite.blockBuzzAttribution.updateMany
      .mockResolvedValueOnce({ count: 5 }) // held
      .mockResolvedValueOnce({ count: 0 }) // stripe confirm (none left)
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await confirmPendingBlockAttributions();

    expect(result.totalHeld).toBe(5);
    const heldCall = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(heldCall.where.appOwnerUserId).toEqual({ in: [42] });
    expect(heldCall.data.status).toBe('held');
  });

  it('confirms (does not hold) an owner under both thresholds', async () => {
    mockDbWrite.blockBuzzAttribution.groupBy
      .mockResolvedValueOnce([
        {
          appOwnerUserId: 1,
          _count: HOLD_VELOCITY_COUNT, // exactly at — not strictly over
          _sum: { appOwnerShareCents: HOLD_VELOCITY_CENTS }, // exactly at
        },
      ])
      .mockResolvedValue([]);
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValue({ count: 10 });

    const result = await confirmPendingBlockAttributions();

    // No held updateMany issued (boundary is strict `>`); only confirms.
    expect(result.totalHeld).toBe(0);
    for (const call of mockDbWrite.blockBuzzAttribution.updateMany.mock.calls) {
      expect(call[0].data.status).toBe('confirmed');
    }
  });

  it('mixed owners in one sweep: one held, one confirmed', async () => {
    mockDbWrite.blockBuzzAttribution.groupBy
      .mockResolvedValueOnce([
        { appOwnerUserId: 100, _count: HOLD_VELOCITY_COUNT + 50, _sum: { appOwnerShareCents: 5 } },
        { appOwnerUserId: 200, _count: 2, _sum: { appOwnerShareCents: 5 } },
      ])
      .mockResolvedValue([]);
    mockDbWrite.blockBuzzAttribution.updateMany
      .mockResolvedValueOnce({ count: 250 }) // held (owner 100)
      .mockResolvedValueOnce({ count: 2 }) // confirmed (owner 200)
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await confirmPendingBlockAttributions();

    expect(result).toEqual({ totalConfirmed: 2, totalHeld: 250 });
    const heldCall = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(heldCall.where.appOwnerUserId).toEqual({ in: [100] });
    const confirmCall = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[1][0];
    expect(confirmCall.where.appOwnerUserId).toEqual({ notIn: [100] });
  });
});
