import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the author-fee SETTLEMENT rail (slice 2) — the first App Blocks
 * surface that moves money. The properties worth pinning are the ones whose
 * failure is silent and financial:
 *
 *   - the author is credited EXACTLY what the viewer was debited (D1: the
 *     platform is a conduit and takes no cut)
 *   - blue Buzz settles as blue (D6) — a coerced bucket would convert
 *     non-withdrawable Buzz into withdrawable earnings and no total would change
 *   - the dedup key is deterministic from (date, owner, account) alone, so a
 *     re-run cannot mint twice
 *   - self-dealing never accrues
 *   - a clawback voids before settlement and carries forward after it
 *   - a bucket whose net went non-positive stays OWED, rather than being
 *     forgiven at zero
 *
 * Prisma, the Buzz service and the logger are mocked at the module boundary.
 */

const { mockDbRead, mockDbWrite, mockLog, mockCreateMany } = vi.hoisted(() => ({
  mockDbRead: {
    oauthClient: { findUnique: vi.fn() },
    blockAuthorFeeAccrual: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  mockDbWrite: {
    blockAuthorFeeAccrual: { create: vi.fn(), updateMany: vi.fn() },
  },
  mockLog: vi.fn(),
  mockCreateMany: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => mockCreateMany(...args),
}));

import {
  accrueBlockAuthorFee,
  clawbackBlockAuthorFee,
  settleBlockAuthorFees,
} from '../author-fee-settlement.service';
import type { BlockAuthorFeeComputation } from '../author-fee';

const APP_ID = 'app_test';
const APP_BLOCK_ID = 'apb_test';
const OWNER_ID = 999;
const VIEWER_ID = 100;
const WORKFLOW_ID = 'wf_test';

/**
 * A computation whose four numbers are PAIRWISE DISTINCT and none of which
 * equals another — so a mutant that writes the wrong field into the wrong column
 * cannot survive by coincidence. `feeBuzz` is 7, deliberately not equal to
 * either leg, which a naive `feeBuzz = max(...)` recomputation in the writer
 * would break.
 */
function fakeComputation(over: Partial<BlockAuthorFeeComputation> = {}) {
  return {
    feeBuzz: 7,
    baseGenerationBuzz: 53,
    flatLegBuzz: 3,
    pctLegBuzz: 5,
    governingLeg: 'pct' as const,
    source: 'default' as const,
    coarseType: 'textToImage',
    clamped: false,
    ...over,
  } satisfies BlockAuthorFeeComputation;
}

class FakePrismaKnownError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.oauthClient.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER_ID });
  mockDbWrite.blockAuthorFeeAccrual.create.mockResolvedValue({});
  mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 1 });
  mockCreateMany.mockResolvedValue(undefined);
});

describe('accrueBlockAuthorFee', () => {
  it('writes the computation through unchanged, and credits what was charged', async () => {
    const computation = fakeComputation();
    const result = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'yellow',
      computation,
      generationType: 'textToImage:txt2img',
    });

    expect(result).toEqual({ accrued: true, id: expect.any(String), feeBuzz: 7 });
    const data = mockDbWrite.blockAuthorFeeAccrual.create.mock.calls[0][0].data;
    // Each field lands in its OWN column. The fixture's values are pairwise
    // distinct so a transposition is visible here rather than averaging out.
    expect(data.feeBuzz).toBe(7);
    expect(data.baseGenerationBuzz).toBe(53);
    expect(data.flatLegBuzz).toBe(3);
    expect(data.pctLegBuzz).toBe(5);
    expect(data.governingLeg).toBe('pct');
    expect(data.appOwnerUserId).toBe(OWNER_ID);
    expect(data.viewerUserId).toBe(VIEWER_ID);
    expect(data.status).toBe('accrued');
    expect(data.entryType).toBe('accrual');
  });

  it('carries the buzz type through rather than defaulting it (D6)', async () => {
    await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'blue',
      computation: fakeComputation(),
      generationType: null,
    });
    expect(mockDbWrite.blockAuthorFeeAccrual.create.mock.calls[0][0].data.buzzType).toBe('blue');
  });

  it('refuses to accrue when the author is the viewer (self-dealing)', async () => {
    const result = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: OWNER_ID, // same person
      buzzType: 'yellow',
      computation: fakeComputation(),
      generationType: null,
    });
    expect(result).toEqual({ accrued: false, reason: 'self-dealing' });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('does not write a row for a zero fee', async () => {
    const result = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'yellow',
      computation: fakeComputation({ feeBuzz: 0, governingLeg: 'none' }),
      generationType: null,
    });
    expect(result).toEqual({ accrued: false, reason: 'zero-fee' });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('treats a unique violation as a duplicate, not a failure', async () => {
    mockDbWrite.blockAuthorFeeAccrual.create.mockRejectedValueOnce(
      new FakePrismaKnownError('P2002')
    );
    const result = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'yellow',
      computation: fakeComputation(),
      generationType: null,
    });
    expect(result).toEqual({ accrued: false, reason: 'duplicate' });
  });

  it('reports an error rather than throwing when the write fails', async () => {
    mockDbWrite.blockAuthorFeeAccrual.create.mockRejectedValueOnce(new Error('connection lost'));
    const result = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'yellow',
      computation: fakeComputation(),
      generationType: null,
    });
    expect(result).toEqual({ accrued: false, reason: 'error' });
  });
});

describe('settleBlockAuthorFees', () => {
  const accrual = (over: Record<string, unknown> = {}) => ({
    id: 'bafa_1',
    appOwnerUserId: OWNER_ID,
    buzzType: 'yellow',
    feeBuzz: 10,
    ...over,
  });

  it('mints the SUM per owner and flips the contributing rows', async () => {
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValue([
      accrual({ id: 'bafa_1', feeBuzz: 10 }),
      accrual({ id: 'bafa_2', feeBuzz: 7 }),
    ]);
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 2 });

    const result = await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    const txs = mockCreateMany.mock.calls[0][0];
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(17);
    expect(txs[0].toAccountId).toBe(OWNER_ID);
    expect(result.rowsSettled).toBe(2);
    expect(result.buzzMinted).toBe(17);
  });

  it('keeps blue and yellow in SEPARATE buckets and never coerces (D6)', async () => {
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValue([
      accrual({ id: 'bafa_1', buzzType: 'yellow', feeBuzz: 10 }),
      accrual({ id: 'bafa_2', buzzType: 'blue', feeBuzz: 4 }),
    ]);

    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    const txs = mockCreateMany.mock.calls[0][0];
    expect(txs).toHaveLength(2);
    const byType = Object.fromEntries(txs.map((t: any) => [t.toAccountType, t.amount]));
    expect(byType).toEqual({ yellow: 10, blue: 4 });
    // Both sides of every transaction stay in the same currency — a blue debit
    // must not become a yellow credit.
    for (const t of txs) expect(t.fromAccountType).toBe(t.toAccountType);
  });

  it('builds a dedup key from (date, owner, account) ONLY — not from the rows', async () => {
    // Two runs over DIFFERENT row sets for the same owner/day must produce the
    // SAME externalTransactionId, or a partially-failed run mints twice on retry.
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValueOnce([
      accrual({ id: 'bafa_1', feeBuzz: 10 }),
    ]);
    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });
    const firstKey = mockCreateMany.mock.calls[0][0][0].externalTransactionId;

    mockCreateMany.mockClear();
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValueOnce([
      accrual({ id: 'bafa_9', feeBuzz: 10 }),
      accrual({ id: 'bafa_8', feeBuzz: 3 }),
    ]);
    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });
    const secondKey = mockCreateMany.mock.calls[0][0][0].externalTransactionId;

    expect(secondKey).toBe(firstKey);
    expect(firstKey).toBe(`block-author-fee-2026-09-18-${OWNER_ID}-yellow`);
  });

  it('holds a bucket whose net went non-positive instead of forgiving it', async () => {
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValue([
      accrual({ id: 'bafa_1', feeBuzz: 5 }),
      accrual({ id: 'bafa_2', feeBuzz: -9 }), // a carried-forward clawback
    ]);

    const result = await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(result.bucketsSkippedNonPositive).toBe(1);
    expect(result.rowsSettled).toBe(0);
    // 🔴 The rows stay `accrued` so the debt nets against future earnings.
    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany).not.toHaveBeenCalled();
  });

  it('no-ops on an empty scan', async () => {
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValue([]);
    const result = await settleBlockAuthorFees({});
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      buckets: 0,
      rowsSettled: 0,
      buzzMinted: 0,
      bucketsSkippedNonPositive: 0,
    });
  });

  it('mints BEFORE flipping status, so a crash settles late rather than paying twice', async () => {
    const order: string[] = [];
    mockCreateMany.mockImplementationOnce(async () => {
      order.push('mint');
    });
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockImplementationOnce(async () => {
      order.push('flip');
      return { count: 1 };
    });
    mockDbRead.blockAuthorFeeAccrual.findMany.mockResolvedValue([accrual()]);

    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(order).toEqual(['mint', 'flip']);
  });
});

describe('clawbackBlockAuthorFee', () => {
  it('voids in place when the accrual has not settled yet', async () => {
    mockDbRead.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
      id: 'bafa_1',
      status: 'accrued',
      feeBuzz: 7,
    });
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 1 });

    const result = await clawbackBlockAuthorFee({ workflowId: WORKFLOW_ID, reason: 'refund' });

    expect(result).toEqual({ clawedBack: true, mode: 'voided', feeBuzz: 7 });
    // No carry-forward row — nothing was paid, so there is nothing to net.
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('carries a NEGATIVE row forward when the accrual already settled', async () => {
    mockDbRead.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
      id: 'bafa_1',
      status: 'settled',
      feeBuzz: 7,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      appOwnerUserId: OWNER_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'blue',
      baseGenerationBuzz: 53,
      flatLegBuzz: 3,
      pctLegBuzz: 5,
      governingLeg: 'pct',
      generationType: 'textToImage:txt2img',
    });

    const result = await clawbackBlockAuthorFee({ workflowId: WORKFLOW_ID, reason: 'undelivered' });

    expect(result).toEqual({ clawedBack: true, mode: 'carried-forward', feeBuzz: 7 });
    const data = mockDbWrite.blockAuthorFeeAccrual.create.mock.calls[0][0].data;
    expect(data.entryType).toBe('clawback');
    expect(data.feeBuzz).toBe(-7); // the SIGN is the whole point
    expect(data.status).toBe('accrued'); // so the next settlement run nets it
    expect(data.buzzType).toBe('blue'); // reversal returns the same currency
  });

  it('falls through to carry-forward when the row settles underneath it', async () => {
    // The read saw `accrued`, but the conditional update matched 0 rows because a
    // settlement run flipped it in between. Without the fallthrough the fee would
    // be paid and never reversed.
    mockDbRead.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
      id: 'bafa_1',
      status: 'accrued',
      feeBuzz: 7,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      appOwnerUserId: OWNER_ID,
      viewerUserId: VIEWER_ID,
      buzzType: 'yellow',
      baseGenerationBuzz: 53,
      flatLegBuzz: 3,
      pctLegBuzz: 5,
      governingLeg: 'pct',
      generationType: null,
    });
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 0 });

    const result = await clawbackBlockAuthorFee({ workflowId: WORKFLOW_ID, reason: 'refund' });

    expect(result).toEqual({ clawedBack: true, mode: 'carried-forward', feeBuzz: 7 });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on an already-clawed-back accrual', async () => {
    mockDbRead.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
      id: 'bafa_1',
      status: 'clawed_back',
      feeBuzz: 7,
    });
    const result = await clawbackBlockAuthorFee({ workflowId: WORKFLOW_ID, reason: 'refund' });
    expect(result).toEqual({ clawedBack: false, reason: 'already-clawed-back' });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('reports not-found for a workflow that never accrued', async () => {
    mockDbRead.blockAuthorFeeAccrual.findUnique.mockResolvedValue(null);
    const result = await clawbackBlockAuthorFee({ workflowId: 'wf_nope', reason: 'refund' });
    expect(result).toEqual({ clawedBack: false, reason: 'not-found' });
  });
});
