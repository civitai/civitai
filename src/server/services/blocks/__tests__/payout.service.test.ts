import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the publisher revenue-payout "separate rail" (PR1, pull model).
 *
 * The financial edge cases are the gate here:
 *   - FLAG OFF → refuse before ANY mint / Tipalti call.
 *   - non-owner can only ever act on ctx.user.id (enforced at the proc; the
 *     service takes a userId and scopes everything to it — see the proc test).
 *   - below-$100 confirmed net → rejected, no mint, no Tipalti.
 *   - happy path → mints, then Tipalti is paid the right DOLLAR amount
 *     (cents/100), tracking row written.
 *   - Tipalti FAILURE → compensating revert (rows back to confirmed, ledger
 *     row deleted, balance preserved), original error re-thrown.
 *   - double / repeat withdraw is idempotent (mint UNIQUE guard / alreadyPaid
 *     path → no Tipalti, no double-pay).
 *   - clawback (net ≤ 0) → abort without minting / paying.
 *
 * All collaborators (flag, mint/revenue/revert, Tipalti, db) are mocked at the
 * module boundary so the test is in-process + deterministic — mirrors the
 * buzz-attribution.service test.
 */

const {
  mockIsPayoutEnabled,
  mockGetRevenue,
  mockMint,
  mockRevert,
  mockPayTipalti,
  mockDbRead,
  mockDbWrite,
  mockLog,
} = vi.hoisted(() => ({
  mockIsPayoutEnabled: vi.fn(),
  mockGetRevenue: vi.fn(),
  mockMint: vi.fn(),
  mockRevert: vi.fn(),
  mockPayTipalti: vi.fn(),
  mockDbRead: {
    user: { findFirst: vi.fn() },
    userPaymentConfiguration: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    blockPayoutWithdrawal: { create: vi.fn(), update: vi.fn() },
  },
  mockLog: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksPayoutEnabled: () => mockIsPayoutEnabled(),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  getRevenueForOwner: (...a: unknown[]) => mockGetRevenue(...a),
  mintPayoutForOwner: (...a: unknown[]) => mockMint(...a),
  revertPayoutMint: (...a: unknown[]) => mockRevert(...a),
}));
vi.mock('~/server/services/user-payment-configuration.service', () => ({
  payToTipaltiAccount: (...a: unknown[]) => mockPayTipalti(...a),
}));

import { withdrawAppRevenue, MIN_APP_REVENUE_PAYOUT_CENTS } from '../payout.service';

const OWNER = 777;

function setConfirmedNet(shareCents: number) {
  mockGetRevenue.mockResolvedValue({
    summary: {
      pending: { count: 0, grossCents: 0, shareCents: 0 },
      confirmed: { count: 5, grossCents: shareCents, shareCents },
      paidOut: { count: 0, grossCents: 0, shareCents: 0 },
      voided: { count: 0, grossCents: 0 },
    },
    topApps: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: flag ON, payable, healthy user, plenty of confirmed balance.
  mockIsPayoutEnabled.mockResolvedValue(true);
  mockDbRead.user.findFirst.mockResolvedValue({
    id: OWNER,
    bannedAt: null,
    onboarding: 0,
  });
  mockDbRead.userPaymentConfiguration.findUnique.mockResolvedValue({
    userId: OWNER,
    tipaltiPaymentsEnabled: true,
    tipaltiWithdrawalMethod: 'BankWire',
  });
  setConfirmedNet(25_000); // $250
  mockMint.mockResolvedValue({
    minted: true,
    payoutId: 'bba_payout_X',
    totalCents: 25_000,
    rowCount: 5,
  });
  mockPayTipalti.mockResolvedValue({ paymentBatchId: 'batch_1', paymentRefCode: 'BPWxxxxxxxxxxxx' });
  mockDbWrite.blockPayoutWithdrawal.create.mockResolvedValue({ id: 'bpw_1' });
  mockDbWrite.blockPayoutWithdrawal.update.mockResolvedValue({ id: 'bpw_1' });
  mockRevert.mockResolvedValue({ reverted: 5, ledgerDeleted: true });
});

describe('withdrawAppRevenue — flag gate', () => {
  it('refuses when the payout flag is OFF, before any mint or Tipalti call', async () => {
    mockIsPayoutEnabled.mockResolvedValueOnce(false);

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/not enabled/i);

    expect(mockMint).not.toHaveBeenCalled();
    expect(mockPayTipalti).not.toHaveBeenCalled();
    // Flag is the FIRST check — we never even read the user.
    expect(mockDbRead.user.findFirst).not.toHaveBeenCalled();
  });
});

describe('withdrawAppRevenue — preconditions', () => {
  it('rejects a banned user (no mint, no Tipalti)', async () => {
    mockDbRead.user.findFirst.mockResolvedValueOnce({
      id: OWNER,
      bannedAt: new Date(),
      onboarding: 0,
    });
    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/banned/i);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockPayTipalti).not.toHaveBeenCalled();
  });

  it('rejects a non-payable user (tipaltiPaymentsEnabled false)', async () => {
    mockDbRead.userPaymentConfiguration.findUnique.mockResolvedValueOnce({
      userId: OWNER,
      tipaltiPaymentsEnabled: false,
      tipaltiWithdrawalMethod: 'BankWire',
    });
    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/payable/i);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockPayTipalti).not.toHaveBeenCalled();
  });

  it('rejects when no real Tipalti withdrawal method (NoPM)', async () => {
    mockDbRead.userPaymentConfiguration.findUnique.mockResolvedValueOnce({
      userId: OWNER,
      tipaltiPaymentsEnabled: true,
      tipaltiWithdrawalMethod: 'NoPM',
    });
    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/payment method/i);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('rejects a confirmed net below the $100 minimum (no mint, no Tipalti)', async () => {
    setConfirmedNet(MIN_APP_REVENUE_PAYOUT_CENTS - 1); // $99.99
    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/minimum/i);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockPayTipalti).not.toHaveBeenCalled();
  });

  it('allows exactly the $100 minimum', async () => {
    setConfirmedNet(MIN_APP_REVENUE_PAYOUT_CENTS); // $100
    mockMint.mockResolvedValueOnce({
      minted: true,
      payoutId: 'bba_payout_min',
      totalCents: MIN_APP_REVENUE_PAYOUT_CENTS,
      rowCount: 2,
    });
    mockPayTipalti.mockResolvedValueOnce({ paymentBatchId: 'b', paymentRefCode: 'r' });

    await withdrawAppRevenue(OWNER);
    expect(mockMint).toHaveBeenCalledTimes(1);
    // Tipalti paid $100 (DOLLARS).
    expect(mockPayTipalti.mock.calls[0][0].amount).toBe(100);
  });
});

describe('withdrawAppRevenue — happy path', () => {
  it('creates the tracking row FIRST, mints, then pays Tipalti the DOLLAR amount (cents/100)', async () => {
    const result = await withdrawAppRevenue(OWNER);

    // SAFE ORDERING (#3): the tracking row is created BEFORE the mint, in
    // 'processing', carrying a BPW refCode the webhook can find.
    expect(mockDbWrite.blockPayoutWithdrawal.create).toHaveBeenCalledTimes(1);
    const created = mockDbWrite.blockPayoutWithdrawal.create.mock.calls[0][0].data;
    expect(created.status).toBe('processing');
    expect(created.appOwnerUserId).toBe(OWNER);
    expect(created.payoutId).toBeNull();
    expect(created.refCode).toMatch(/^BPW/);
    expect(created.id).toMatch(/^bpw_/);

    // The create happens before any Tipalti call.
    expect(mockDbWrite.blockPayoutWithdrawal.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPayTipalti.mock.invocationCallOrder[0]
    );

    // Minted under a unique, per-attempt period key.
    expect(mockMint).toHaveBeenCalledTimes(1);
    const mintArg = mockMint.mock.calls[0][0];
    expect(mintArg.appOwnerUserId).toBe(OWNER);
    expect(typeof mintArg.periodKey).toBe('string');
    expect(mintArg.periodKey).toMatch(/^withdraw:/);

    // Tipalti paid DOLLARS, byUserId -1 (the bank), to the owner; refCode is BPW.
    expect(mockPayTipalti).toHaveBeenCalledTimes(1);
    const payArg = mockPayTipalti.mock.calls[0][0];
    expect(payArg.amount).toBe(250); // 25_000 cents / 100
    expect(payArg.toUserId).toBe(OWNER);
    expect(payArg.byUserId).toBe(-1);
    expect(payArg.requestId).toMatch(/^BPW/);

    // On success the row is UPDATED to pending_approval with the batch id.
    const upd = mockDbWrite.blockPayoutWithdrawal.update.mock.calls.map((c) => c[0].data);
    const pending = upd.find((d) => d.status === 'pending_approval');
    expect(pending).toBeTruthy();
    expect(pending?.payoutId).toBe('bba_payout_X');
    expect(pending?.amountCents).toBe(25_000);
    expect(pending?.paymentBatchId).toBe('batch_1');

    // No revert on success.
    expect(mockRevert).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      payoutId: 'bba_payout_X',
      amountCents: 25_000,
      paymentBatchId: 'batch_1',
    });
  });
});

describe('withdrawAppRevenue — compensating revert (pre-money failure)', () => {
  it('reverts the mint when Tipalti FAILS, preserving the balance, re-throwing', async () => {
    const tipaltiErr = new Error('Tipalti unreachable');
    mockPayTipalti.mockRejectedValueOnce(tipaltiErr);

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/Tipalti unreachable/);

    // The mint was reverted for THIS payout + owner (balance restored). Safe:
    // the failure happened BEFORE money moved.
    expect(mockRevert).toHaveBeenCalledTimes(1);
    expect(mockRevert).toHaveBeenCalledWith({ payoutId: 'bba_payout_X', appOwnerUserId: OWNER });

    // The pre-created row is UPDATED to 'failed' (no 'pending_approval' update).
    const upd = mockDbWrite.blockPayoutWithdrawal.update.mock.calls.map((c) => c[0].data);
    expect(upd.some((d) => d.status === 'pending_approval')).toBe(false);
    const failed = upd.find((d) => d.status === 'failed');
    expect(failed).toBeTruthy();
    // Revert succeeded → ledger row gone → payoutId cleared (FK-safe).
    expect(failed?.payoutId).toBeNull();
  });

  it('keeps the payoutId + emits CRITICAL when the REVERT itself fails (manual intervention)', async () => {
    mockPayTipalti.mockRejectedValueOnce(new Error('Tipalti boom'));
    mockRevert.mockRejectedValueOnce(new Error('revert tx deadlock'));

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/Tipalti boom/);

    const failed = mockDbWrite.blockPayoutWithdrawal.update.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.status === 'failed');
    // Revert failed → ledger row may still exist → keep the linkage + flag it.
    expect(failed?.payoutId).toBe('bba_payout_X');
    expect(failed?.note).toMatch(/manual intervention/i);

    // A CRITICAL alertable signal was emitted for the failed revert.
    const critical = mockLog.mock.calls.find(
      (c) => c[0]?.name === 'block-revenue-payout-critical-sent-not-recorded'
    );
    expect(critical).toBeTruthy();
  });
});

describe('withdrawAppRevenue — success-path row update failure (money already sent)', () => {
  it('does NOT revert, emits CRITICAL, and still returns success when the pending_approval update fails', async () => {
    // create (processing) succeeds; the success-path update throws.
    mockDbWrite.blockPayoutWithdrawal.update.mockRejectedValueOnce(new Error('db write failed'));

    const result = await withdrawAppRevenue(OWNER);

    // Money already moved → NEVER revert.
    expect(mockPayTipalti).toHaveBeenCalledTimes(1);
    expect(mockRevert).not.toHaveBeenCalled();

    // CRITICAL alertable signal emitted.
    const critical = mockLog.mock.calls.find(
      (c) => c[0]?.name === 'block-revenue-payout-critical-sent-not-recorded'
    );
    expect(critical).toBeTruthy();

    // The disbursement happened, so we surface success (the webhook reconciles
    // the row off the persisted refCode) rather than tripping a double-pay retry.
    expect(result).toMatchObject({ payoutId: 'bba_payout_X', amountCents: 25_000 });
  });
});

describe('withdrawAppRevenue — idempotency / no double-pay', () => {
  it('does NOT call Tipalti when the mint reports alreadyPaid (repeat/concurrent attempt)', async () => {
    mockMint.mockResolvedValueOnce({ minted: false, alreadyPaid: true });

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/no confirmed app revenue/i);

    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockPayTipalti).not.toHaveBeenCalled();
    expect(mockRevert).not.toHaveBeenCalled();
    // The pre-created row is marked no_balance (terminal, no money).
    const upd = mockDbWrite.blockPayoutWithdrawal.update.mock.calls.map((c) => c[0].data);
    expect(upd.some((d) => d.status === 'no_balance')).toBe(true);
  });

  it('does NOT call Tipalti when net is non-positive at mint time (clawback landed)', async () => {
    // The pre-gate read saw enough balance, but a clawback flips the net at
    // mint time → mint carries forward, refuses to flip → no disbursement.
    mockMint.mockResolvedValueOnce({ minted: false, carriedForwardCents: -50, rowCount: 3 });

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/no confirmed app revenue/i);

    expect(mockPayTipalti).not.toHaveBeenCalled();
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it('does NOT call Tipalti when the mint flipped 0 rows (carriedForwardCents:0, rowCount:0)', async () => {
    // The advisory-lock 0-flip guard returns minted:false with a 0 net — this
    // is the losing-race shape. Must abort before Tipalti.
    mockMint.mockResolvedValueOnce({ minted: false, carriedForwardCents: 0, rowCount: 0 });

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/no confirmed app revenue/i);

    expect(mockPayTipalti).not.toHaveBeenCalled();
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it('aborts (no Tipalti) and reverts if a minted result somehow carries a 0 amount', async () => {
    // Belt-and-braces guard: minted:true but totalCents 0 must NOT reach Tipalti.
    mockMint.mockResolvedValueOnce({
      minted: true,
      payoutId: 'bba_payout_zero',
      totalCents: 0,
      rowCount: 0,
    });

    await expect(withdrawAppRevenue(OWNER)).rejects.toThrow(/no confirmed app revenue/i);

    expect(mockPayTipalti).not.toHaveBeenCalled();
    // Safe pre-money revert of whatever the mint touched.
    expect(mockRevert).toHaveBeenCalledWith({
      payoutId: 'bba_payout_zero',
      appOwnerUserId: OWNER,
    });
  });
});
