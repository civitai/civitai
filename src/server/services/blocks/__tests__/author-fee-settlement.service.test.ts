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
  const DAY = new Date('2026-09-17T09:00:00Z'); // the accrual day
  const RUN = new Date('2026-09-18T02:30:00Z'); // the day the job runs

  const accrual = (over: Record<string, unknown> = {}) => ({
    id: 'bafa_1',
    appOwnerUserId: OWNER_ID,
    buzzType: 'yellow',
    feeBuzz: 10,
    ...over,
  });

  /** One accrual day, then exhausted — the shape the day loop walks. */
  function oneDay(rows: Record<string, unknown>[], day: Date = DAY) {
    mockDbWrite.blockAuthorFeeAccrual.findFirst
      .mockResolvedValueOnce({ accruedAt: day })
      .mockResolvedValue(null);
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);
  }

  it('mints the SUM per owner and flips the contributing rows', async () => {
    oneDay([accrual({ id: 'bafa_1', feeBuzz: 10 }), accrual({ id: 'bafa_2', feeBuzz: 7 })]);
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 2 });

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    const tx = mockCreateMany.mock.calls[0][0][0];
    expect(tx.amount).toBe(17);
    expect(tx.toAccountId).toBe(OWNER_ID);
    expect(result.rowsSettled).toBe(2);
    expect(result.buzzMinted).toBe(17);
  });

  it('🔴 keys on the ACCRUAL day, not the day the job ran', async () => {
    // The defect this replaces: the key named the RUN day, so a row whose flip
    // failed was re-minted under a DIFFERENT key the next day — paid twice.
    oneDay([accrual()]);

    await settleBlockAuthorFees({ date: RUN });

    const key = mockCreateMany.mock.calls[0][0][0].externalTransactionId;
    expect(key).toBe(`block-author-fee-2026-09-17-${OWNER_ID}-yellow`);
    expect(key).not.toContain('2026-09-18');
  });

  it('🔴 re-derives the SAME key on a later run — a deferred retry cannot pay twice', async () => {
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: RUN });
    const first = mockCreateMany.mock.calls[0][0][0].externalTransactionId;

    // Same unflipped row, settled a week later. The key must not move.
    vi.clearAllMocks();
    mockCreateMany.mockImplementation(async (txs: unknown[]) => ({
      transactions: txs.map((_, i) => ({ id: `tx_${i}` })),
      conflicts: [],
    }));
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 1 });
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: new Date('2026-09-25T02:30:00Z') });

    expect(mockCreateMany.mock.calls[0][0][0].externalTransactionId).toBe(first);
  });

  it('keeps blue and yellow in SEPARATE buckets and never coerces (D6)', async () => {
    oneDay([
      accrual({ id: 'bafa_1', buzzType: 'yellow', feeBuzz: 10 }),
      accrual({ id: 'bafa_2', buzzType: 'blue', feeBuzz: 4 }),
    ]);

    await settleBlockAuthorFees({ date: RUN });

    expect(mockCreateMany).toHaveBeenCalledTimes(2); // one call per bucket
    const txs = mockCreateMany.mock.calls.map((c: any) => c[0][0]);
    const byType = Object.fromEntries(txs.map((t: any) => [t.toAccountType, t.amount]));
    expect(byType).toEqual({ yellow: 10, blue: 4 });
    for (const t of txs) expect(t.fromAccountType).toBe(t.toAccountType);
  });

  it('🔴 SKIPS an oversized accrual day whole rather than minting a partial bucket', async () => {
    // A cut bucket is how money is lost: the next run would flip the remainder on
    // a conflict without ever paying for it.
    oneDay([accrual({ id: 'a' }), accrual({ id: 'b' }), accrual({ id: 'c' })]);

    const result = await settleBlockAuthorFees({ date: RUN, limit: 2 });

    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany).not.toHaveBeenCalled();
    expect(result.daysTruncated).toBe(1);
    expect(result.rowsSettled).toBe(0);
  });

  it('leaves a DROPPED bucket accrued, and settles its peers anyway', async () => {
    // Per-bucket minting is what makes this answerable: an earlier revision
    // batched them, could not tell which dropped, and flipped nothing — leaving
    // already-paid buckets to be re-minted later.
    oneDay([
      accrual({ id: 'bafa_1', appOwnerUserId: 111, feeBuzz: 10 }),
      accrual({ id: 'bafa_2', appOwnerUserId: 222, feeBuzz: 4 }),
    ]);
    mockCreateMany
      .mockResolvedValueOnce({ transactions: [], conflicts: [] }) // owner 111 dropped
      .mockResolvedValueOnce({ transactions: [{ id: 'tx' }], conflicts: [] }); // 222 paid
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 1 });

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany.mock.calls[0][0].where.id.in).toEqual([
      'bafa_2',
    ]);
    expect(result.rowsSettled).toBe(1);
  });

  it('counts a CONFLICT as settled — that exact key already moved the money', async () => {
    oneDay([accrual()]);
    mockCreateMany.mockResolvedValueOnce({ transactions: [], conflicts: [{ id: 'c0' }] });

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany).toHaveBeenCalledTimes(1);
    expect(result.rowsSettled).toBe(1);
  });

  it('only considers days strictly BEFORE the run day', async () => {
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: RUN });
    const where = mockDbWrite.blockAuthorFeeAccrual.findFirst.mock.calls[0][0].where;
    expect(where.status).toBe('accrued');
    expect(where.accruedAt.lt.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('scans exactly one UTC day at a time', async () => {
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: RUN });
    const where = mockDbWrite.blockAuthorFeeAccrual.findMany.mock.calls[0][0].where;
    expect(where.accruedAt.gte.toISOString()).toBe('2026-09-17T00:00:00.000Z');
    expect(where.accruedAt.lt.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('does not claim buzz for a bucket a concurrent run already flipped', async () => {
    oneDay([accrual()]);
    mockDbWrite.blockAuthorFeeAccrual.updateMany.mockResolvedValue({ count: 0 });

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(result.rowsSettled).toBe(0);
    expect(result.buzzMinted).toBe(0);
  });

  it('uses ONE key for both the mint and the row stamp', async () => {
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: RUN });
    const minted = mockCreateMany.mock.calls[0][0][0].externalTransactionId;
    const stamped =
      mockDbWrite.blockAuthorFeeAccrual.updateMany.mock.calls[0][0].data.settlementKey;
    expect(stamped).toBe(minted);
  });

  it('no-ops when there is nothing accrued', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findFirst.mockResolvedValue(null);
    const result = await settleBlockAuthorFees({ date: RUN });
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ buckets: 0, rowsSettled: 0, buzzMinted: 0, daysTruncated: 0 });
  });
});
