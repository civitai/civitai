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
 *
 * The clawback was retired in round 0 (zero production callers, and its
 * carry-forward arm unreachable until something had settled), so there is
 * nothing here pinning a reversal — slice 2b brings both back together.
 *
 * Prisma, the Buzz service and the logger are mocked at the module boundary.
 */

const { mockLog, mockCreateMany } = vi.hoisted(() => ({
  mockLog: vi.fn(),
  mockCreateMany: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => mockCreateMany(...args),
}));

import { accrueBlockAuthorFee, settleBlockAuthorFees } from '../author-fee-settlement.service';
import type { BlockAuthorFeeComputation } from '../author-fee';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) => {
  mockLog(...args);
  return Promise.resolve(null);
});

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
  // 🔴 THE FAKE MATCHES THE REAL CONTRACT. `createBuzzTransactionMany` returns
  // `{ transactions, conflicts }` and does NOT throw on a per-transaction
  // failure. An earlier revision resolved it to `undefined`, which could express
  // neither a conflict nor a silent drop — and that is structurally why the two
  // most expensive defects on this path had no test at all. By default every
  // submitted transaction succeeds; a test that wants a drop says so explicitly.
  mockCreateMany.mockImplementation(async (txs: unknown[]) => ({
    transactions: txs.map((_, i) => ({ id: `tx_${i}` })),
    conflicts: [],
  }));
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
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([
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
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([
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
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValueOnce([
      accrual({ id: 'bafa_1', feeBuzz: 10 }),
    ]);
    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });
    const firstKey = mockCreateMany.mock.calls[0][0][0].externalTransactionId;

    mockCreateMany.mockClear();
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValueOnce([
      accrual({ id: 'bafa_9', feeBuzz: 10 }),
      accrual({ id: 'bafa_8', feeBuzz: 3 }),
    ]);
    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });
    const secondKey = mockCreateMany.mock.calls[0][0][0].externalTransactionId;

    expect(secondKey).toBe(firstKey);
    expect(firstKey).toBe(`block-author-fee-2026-09-18-${OWNER_ID}-yellow`);
  });

  it('flips NOTHING when the mint did not reconcile — a drop must not read as paid', async () => {
    // createBuzzTransactionMany does not throw on a per-transaction failure: an
    // insufficient-funds or otherwise-rejected bucket is dropped from BOTH
    // arrays. If we flipped anyway the author would never be paid while the
    // ledger asserted they were, and `accrued` was the only handle left.
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([
      accrual({ id: 'bafa_1', appOwnerUserId: 111, feeBuzz: 10 }),
      accrual({ id: 'bafa_2', appOwnerUserId: 222, feeBuzz: 4 }),
    ]);
    mockCreateMany.mockResolvedValueOnce({ transactions: [{ id: 'tx_0' }], conflicts: [] }); // 1 of 2

    const result = await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany).not.toHaveBeenCalled();
    expect(result.rowsSettled).toBe(0);
    expect(result.buzzMinted).toBe(0);
  });

  it('counts a CONFLICT as settled — the money already moved under that key', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([accrual({ feeBuzz: 10 })]);
    mockCreateMany.mockResolvedValueOnce({ transactions: [], conflicts: [{ id: 'c0' }] });

    const result = await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany).toHaveBeenCalledTimes(1);
    expect(result.rowsSettled).toBe(1);
  });

  it('only settles rows accrued BEFORE the day boundary', async () => {
    // This is the half that makes the date-scoped dedup key correct. Without it a
    // second run on the same day sweeps up rows accrued since the first run and
    // mints them under a key that already conflicted — money silently lost.
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([accrual()]);

    await settleBlockAuthorFees({ date: new Date('2026-09-18T14:37:00Z') });

    const where = mockDbWrite.blockAuthorFeeAccrual.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('accrued');
    // Midnight UTC of the settled day — NOT the call time, or rows accruing
    // during the run would be swept in.
    expect(where.accruedAt.lt.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('does not claim buzz for a bucket a concurrent run already flipped', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([accrual({ feeBuzz: 10 })]);
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 0 });

    const result = await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(result.rowsSettled).toBe(0);
    // The job logs this as "buzz minted"; counting it here would assert a payment
    // this run did not make.
    expect(result.buzzMinted).toBe(0);
  });

  it('uses ONE key for both the mint and the row stamp', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([accrual({ feeBuzz: 10 })]);

    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    const minted = mockCreateMany.mock.calls[0][0][0].externalTransactionId;
    const stamped =
      mockDbWrite.blockAuthorFeeAccrual.updateMany.mock.calls[0][0].data.settlementKey;
    expect(stamped).toBe(minted);
  });

  it('no-ops on an empty scan', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([]);
    const result = await settleBlockAuthorFees({});
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ buckets: 0, rowsSettled: 0, buzzMinted: 0 });
  });

  it('mints BEFORE flipping status, so a crash settles late rather than paying twice', async () => {
    const order: string[] = [];
    mockCreateMany.mockImplementationOnce(async (txs: unknown[]) => {
      order.push('mint');
      return { transactions: txs.map((_, i) => ({ id: `tx_${i}` })), conflicts: [] };
    });
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockImplementationOnce(async () => {
      order.push('flip');
      return { count: 1 };
    });
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([accrual()]);

    await settleBlockAuthorFees({ date: new Date('2026-09-18T00:00:00Z') });

    expect(order).toEqual(['mint', 'flip']);
  });
});
