import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the App-Blocks payout RECONCILIATION webhook handler (audit
 * blocker #2). The interesting surface:
 *   - an approved/completed event → row 'completed'
 *   - a declined/failed/cancelled event → row 'failed' AND revertPayoutMint
 *     called (balance restored — safe because money did not leave)
 *   - the handler looks the row up by EXACT refCode (the BPW-prefixed code)
 *   - intermediate events leave the terminal status alone
 *   - a re-delivered failure does NOT double-revert (already 'failed')
 *
 * db + revert + logger are mocked at the module boundary.
 */

const { mockDbWrite, mockRevert, mockLog } = vi.hoisted(() => ({
  mockDbWrite: {
    blockPayoutWithdrawal: { findFirst: vi.fn(), update: vi.fn() },
  },
  mockRevert: vi.fn(),
  mockLog: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  revertPayoutMint: (...a: unknown[]) => mockRevert(...a),
}));

import { processBlockPayoutEvent } from '../payout-webhook.service';

const REFCODE = 'BPW0123456789A';
const OWNER = 555;

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'bpw_test',
    appOwnerUserId: OWNER,
    payoutId: 'bba_payout_X',
    refCode: REFCODE,
    status: 'pending_approval',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.blockPayoutWithdrawal.findFirst.mockResolvedValue(row());
  mockDbWrite.blockPayoutWithdrawal.update.mockResolvedValue({ id: 'bpw_test' });
  mockRevert.mockResolvedValue({ reverted: 5, ledgerDeleted: true });
});

describe('processBlockPayoutEvent — refCode resolution', () => {
  it('looks the row up by exact refCode for a group event (payments[0].refCode)', async () => {
    await processBlockPayoutEvent({
      type: 'paymentGroupApproved',
      eventData: { payments: [{ refCode: REFCODE }] },
    });
    expect(mockDbWrite.blockPayoutWithdrawal.findFirst).toHaveBeenCalledWith({
      where: { refCode: REFCODE },
    });
  });

  it('looks the row up by exact refCode for a payment-level event (eventData.refCode)', async () => {
    await processBlockPayoutEvent({
      type: 'paymentCompleted',
      eventData: { refCode: REFCODE },
    });
    expect(mockDbWrite.blockPayoutWithdrawal.findFirst).toHaveBeenCalledWith({
      where: { refCode: REFCODE },
    });
  });

  it('throws when the row is not found (so the webhook surfaces the miss)', async () => {
    mockDbWrite.blockPayoutWithdrawal.findFirst.mockResolvedValueOnce(null);
    await expect(
      processBlockPayoutEvent({ type: 'paymentCompleted', eventData: { refCode: REFCODE } })
    ).rejects.toThrow(/not found/i);
  });
});

describe('processBlockPayoutEvent — approved/completed → completed', () => {
  it('marks the row completed on paymentGroupApproved (no revert)', async () => {
    await processBlockPayoutEvent({
      type: 'paymentGroupApproved',
      eventData: { payments: [{ refCode: REFCODE }] },
    });
    const data = mockDbWrite.blockPayoutWithdrawal.update.mock.calls[0][0].data;
    expect(data.status).toBe('completed');
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it('marks the row completed on paymentCompleted (no revert)', async () => {
    await processBlockPayoutEvent({ type: 'paymentCompleted', eventData: { refCode: REFCODE } });
    const data = mockDbWrite.blockPayoutWithdrawal.update.mock.calls[0][0].data;
    expect(data.status).toBe('completed');
    expect(mockRevert).not.toHaveBeenCalled();
  });
});

describe('processBlockPayoutEvent — declined/failed → failed + revert', () => {
  it('marks failed and reverts the mint on paymentGroupDeclined', async () => {
    await processBlockPayoutEvent({
      type: 'paymentGroupDeclined',
      eventData: { payments: [{ refCode: REFCODE }] },
    });
    expect(mockRevert).toHaveBeenCalledWith({ payoutId: 'bba_payout_X', appOwnerUserId: OWNER });
    const data = mockDbWrite.blockPayoutWithdrawal.update.mock.calls[0][0].data;
    expect(data.status).toBe('failed');
    expect(data.payoutId).toBeNull();
  });

  it('marks failed and reverts on paymentError', async () => {
    await processBlockPayoutEvent({
      type: 'paymentError',
      eventData: { refCode: REFCODE, errorDescription: 'bank rejected' },
    });
    expect(mockRevert).toHaveBeenCalledWith({ payoutId: 'bba_payout_X', appOwnerUserId: OWNER });
    const data = mockDbWrite.blockPayoutWithdrawal.update.mock.calls[0][0].data;
    expect(data.status).toBe('failed');
    expect(data.note).toMatch(/bank rejected/);
  });

  it('does NOT double-revert a re-delivered failure (already failed)', async () => {
    mockDbWrite.blockPayoutWithdrawal.findFirst.mockResolvedValueOnce(row({ status: 'failed' }));
    await processBlockPayoutEvent({
      type: 'paymentGroupDeclined',
      eventData: { payments: [{ refCode: REFCODE }] },
    });
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it('emits CRITICAL + rethrows if the revert itself fails', async () => {
    mockRevert.mockRejectedValueOnce(new Error('revert deadlock'));
    await expect(
      processBlockPayoutEvent({ type: 'paymentError', eventData: { refCode: REFCODE } })
    ).rejects.toThrow(/revert deadlock/);
    const critical = mockLog.mock.calls.find(
      (c) => c[0]?.name === 'block-revenue-payout-critical-sent-not-recorded'
    );
    expect(critical).toBeTruthy();
  });
});

describe('processBlockPayoutEvent — intermediate events', () => {
  it('does not change the terminal status on paymentSubmitted', async () => {
    await processBlockPayoutEvent({ type: 'paymentSubmitted', eventData: { refCode: REFCODE } });
    const data = mockDbWrite.blockPayoutWithdrawal.update.mock.calls[0][0].data;
    expect(data.status).toBeUndefined(); // no status key → unchanged
    expect(mockRevert).not.toHaveBeenCalled();
  });
});
