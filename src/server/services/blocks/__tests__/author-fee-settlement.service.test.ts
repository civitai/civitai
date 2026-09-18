import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the author-fee SETTLEMENT rail (slice 2b) — the first App Blocks
 * surface that moves money. The properties worth pinning are the ones whose
 * failure is silent and financial:
 *
 *   - the author is credited EXACTLY what the viewer was debited (D1: the
 *     platform is a conduit and takes no cut)
 *   - blue Buzz settles as blue (D6) — a coerced bucket would convert
 *     non-withdrawable Buzz into withdrawable earnings and no total would change
 *   - the dedup key is deterministic from (ACCRUAL DAY, owner, account) alone,
 *     so a re-run — an hour later, a day later, or after a month with the flag
 *     off — cannot mint twice
 *   - a day the loop cannot finish does not block the days behind it
 *
 * 🔴 THE ACCRUAL HALF IS NOT TESTED HERE. `accrueBlockAuthorFee` and its six
 * tests live in `author-fee-accrual.service.test.ts` on slice 2a, which this
 * branch builds on. This suite exercises hop 2 only.
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

import { settleBlockAuthorFees } from '../author-fee-settlement.service';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbWrite = dbMock.dbWrite;
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) => {
  mockLog(...args);
  return Promise.resolve(null);
});

const OWNER_ID = 999;

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 clearAllMocks CLEARS CALL HISTORY BUT NOT `mockResolvedValueOnce` QUEUES —
  // those are implementations, and only a reset drops them. Every mock this suite
  // feeds with `...Once` must therefore be reset explicitly, or a queue left over
  // by one test is consumed by the next and the suite becomes order-dependent.
  // Found the moment the multi-day tests landed: a leftover day queue made
  // 'no-ops when there is nothing accrued' mint a transaction.
  mockDbWrite.blockAuthorFeeAccrual.findFirst.mockReset();
  mockDbWrite.blockAuthorFeeAccrual.findMany.mockReset();
  mockDbWrite.blockAuthorFeeAccrual.updateMany.mockReset();
  mockCreateMany.mockReset();
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
    days([[day, rows]]);
  }

  /**
   * N accrual days in order, then exhausted.
   *
   * 🔴 THIS EXISTS BECAUSE `oneDay` ALONE MADE THE LOOP STRUCTURALLY UNTESTED. An
   * audit round found that every settlement test used the single-day helper, so
   * the loop body ran exactly once in every test — the multi-day walk, the cursor,
   * `maxDays` and the continue-vs-break semantics were all unexercised, and a
   * mutation sweep over them would have killed nothing. The defect that shipped
   * under that blind spot was a day the loop could never advance past, which
   * blocked every later day forever.
   */
  function days(plan: [Date, Record<string, unknown>[]][]) {
    let ff = mockDbWrite.blockAuthorFeeAccrual.findFirst;
    let fm = mockDbWrite.blockAuthorFeeAccrual.findMany;
    for (const [day, rows] of plan) {
      ff = ff.mockResolvedValueOnce({ accruedAt: day });
      fm = fm.mockResolvedValueOnce(rows);
    }
    ff.mockResolvedValue(null);
    fm.mockResolvedValue([]);
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

  it('🔴 the FLIP is guarded on `status: accrued`, and the guard is asserted on the WHERE', async () => {
    // ⚠️ THE TEST ABOVE NAMES THIS SCENARIO AND CANNOT SEE THE GUARD. It simulates
    // "a concurrent run already flipped these rows" with
    // `updateMany.mockResolvedValue({ count: 0 })`, which is a fact about the MOCK
    // and is true whatever the WHERE clause says. Measured: deleting
    // `status: STATUS_ACCRUED` from the flip's `where` left the entire suite
    // green — a guard whose description covered a relationship while its body
    // inspected nothing.
    //
    // Without the clause the flip is `id IN (…)` alone, so a run whose rows were
    // settled by a concurrent run between the scan and the flip re-stamps them
    // with THIS run's `settlementKey` and `settledAt`, overwriting the key that
    // records which mint actually paid them. Row→mint traceability is the only
    // way to answer "was this fee paid, and by which transaction".
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: RUN });

    const call = mockDbWrite.blockAuthorFeeAccrual.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: expect.any(Array) }, status: 'accrued' });
    expect(call.where.id.in.length).toBeGreaterThan(0);
  });

  it('uses ONE key for both the mint and the row stamp', async () => {
    oneDay([accrual()]);
    await settleBlockAuthorFees({ date: RUN });
    const minted = mockCreateMany.mock.calls[0][0][0].externalTransactionId;
    const stamped =
      mockDbWrite.blockAuthorFeeAccrual.updateMany.mock.calls[0][0].data.settlementKey;
    expect(stamped).toBe(minted);
  });

  it('walks MULTIPLE accrual days in one run, keying each on its own day', async () => {
    days([
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'a', feeBuzz: 3 })]],
      [new Date('2026-09-16T09:00:00Z'), [accrual({ id: 'b', feeBuzz: 5 })]],
    ]);

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    const keys = mockCreateMany.mock.calls.map((c: any) => c[0][0].externalTransactionId);
    expect(keys).toEqual([
      `block-author-fee-2026-09-15-${OWNER_ID}-yellow`,
      `block-author-fee-2026-09-16-${OWNER_ID}-yellow`,
    ]);
    expect(result.buckets).toBe(2);
  });

  it('🔴 an OVERSIZED day does not block the days behind it', async () => {
    // The defect this pins: with no cursor the oversized day stayed "the oldest"
    // forever, so every later day was blocked permanently and the only recovery
    // was a code change and a deploy.
    days([
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'x' }), accrual({ id: 'y' })]],
      [new Date('2026-09-16T09:00:00Z'), [accrual({ id: 'z', feeBuzz: 5 })]],
    ]);

    const result = await settleBlockAuthorFees({ date: RUN, limit: 1 });

    expect(result.daysTruncated).toBe(1);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany.mock.calls[0][0][0].externalTransactionId).toContain('2026-09-16');
  });

  it('🔴 a persistently DROPPED bucket does not block the days behind it', async () => {
    days([
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'x', appOwnerUserId: 111 })]],
      [new Date('2026-09-16T09:00:00Z'), [accrual({ id: 'z', appOwnerUserId: 222, feeBuzz: 5 })]],
    ]);
    mockCreateMany
      .mockResolvedValueOnce({ transactions: [], conflicts: [] })
      .mockResolvedValueOnce({ transactions: [{ id: 'tx' }], conflicts: [] });

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    expect(result.rowsSettled).toBe(1);
  });

  it('a THROWN mint is treated as a drop, and its peers still settle', async () => {
    // The buzz client throws on any non-2xx and does not retry a 5xx. Unwrapped,
    // bucket 1 would abort buckets 2..N, the day loop and the completion log.
    oneDay([
      accrual({ id: 'bafa_1', appOwnerUserId: 111, feeBuzz: 10 }),
      accrual({ id: 'bafa_2', appOwnerUserId: 222, feeBuzz: 4 }),
    ]);
    mockCreateMany
      .mockRejectedValueOnce(new Error('BuzzApiError: 503'))
      .mockResolvedValueOnce({ transactions: [{ id: 'tx' }], conflicts: [] });

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(result.rowsSettled).toBe(1);
    expect(mockDbWrite.blockAuthorFeeAccrual.updateMany.mock.calls[0][0].where.id.in).toEqual([
      'bafa_2',
    ]);
  });

  it('advances the cursor past each day rather than re-selecting it', async () => {
    days([
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'a' })]],
      [new Date('2026-09-16T09:00:00Z'), [accrual({ id: 'b' })]],
    ]);

    await settleBlockAuthorFees({ date: RUN });

    const gte = mockDbWrite.blockAuthorFeeAccrual.findFirst.mock.calls.map((c: any) =>
      c[0].where.accruedAt.gte.toISOString()
    );
    expect(gte[0]).toBe('1970-01-01T00:00:00.000Z');
    expect(gte[1]).toBe('2026-09-16T00:00:00.000Z');
    expect(gte[2]).toBe('2026-09-17T00:00:00.000Z');
  });

  it('a day that EMPTIES under the loop does not end the run', async () => {
    // findFirst reports a day, a concurrent run settles it before findMany, and
    // this run sees 0 rows. `break` there would abandon every later day for the
    // rest of the run; the cursor has already moved past it, so `continue` cannot
    // spin.
    days([
      [new Date('2026-09-15T09:00:00Z'), []],
      [new Date('2026-09-16T09:00:00Z'), [accrual({ id: 'z', feeBuzz: 5 })]],
    ]);

    const result = await settleBlockAuthorFees({ date: RUN });

    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany.mock.calls[0][0][0].externalTransactionId).toContain('2026-09-16');
    expect(result.rowsSettled).toBe(1);
  });

  it('stops after maxDays even with more days outstanding', async () => {
    days([
      [new Date('2026-09-13T09:00:00Z'), [accrual({ id: 'a' })]],
      [new Date('2026-09-14T09:00:00Z'), [accrual({ id: 'b' })]],
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'c' })]],
    ]);

    const result = await settleBlockAuthorFees({ date: RUN, maxDays: 2 });

    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    expect(result.buckets).toBe(2);
  });

  it('a THROWN flip does not abort the run, and is logged as money-moved-rows-not', async () => {
    // The mint was wrapped; the flip one statement below it was not, so the very
    // sentence justifying the wrap stayed true of the next call.
    oneDay([
      accrual({ id: 'bafa_1', appOwnerUserId: 111, feeBuzz: 10 }),
      accrual({ id: 'bafa_2', appOwnerUserId: 222, feeBuzz: 4 }),
    ]);
    mockDbWrite.blockAuthorFeeAccrual.updateMany
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValue({ count: 1 });

    const result = await settleBlockAuthorFees({ date: RUN });

    // Both buckets were minted; the second still flipped despite the first throwing.
    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    expect(result.rowsSettled).toBe(1);
    const logged = mockLog.mock.calls.map((c: any) => c[0].message);
    expect(logged).toContain(
      'settled rows may not have been flipped — mint landed, flip did not confirm'
    );
    // The one counter that means money moved without a settled row.
    expect(result.flipFailures).toBe(1);
  });

  it('logs the buzz STATUS on a dropped mint, not just the mapped message', async () => {
    // mapError collapses every non-2xx into one generic TRPCError message, so a
    // permanent 400 and a transient 503 otherwise produce byte-identical lines
    // forever. Unpinned, a mutant nulling this field SURVIVED the sweep.
    // 🔴 THE FIXTURE MUST BE A REAL `BuzzApiError`, AND THE ASSERTION MUST READ THE
    // VALUE. An earlier version of this test used a plain Error carrying a
    // `status` property and asserted `toHaveProperty('threwStatus')` — a
    // single-argument existence check. `getBuzzApiStatus` returns undefined for
    // that shape, so the field logged `null`, and a mutant replacing the whole
    // expression with `null` SURVIVED while the test passed. It was reported as
    // closing that gap and did not.
    oneDay([accrual()]);
    mockCreateMany.mockRejectedValueOnce(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error ocurred, please try again later',
        cause: new BuzzApiError(503, 'Service Unavailable'),
      })
    );

    await settleBlockAuthorFees({ date: RUN });

    const drop = mockLog.mock.calls
      .map((c: any) => c[0])
      .find((l: any) => l.message === 'bucket mint did not land — left accrued for retry');
    expect(drop).toBeDefined();
    expect(drop.threwStatus).toBe(503);
  });

  it('bounds the loop from maxDays when maxIterations is not supplied', async () => {
    // The DEFAULT was unpinned: a mutant replacing it with MAX_SAFE_INTEGER
    // survived the sweep.
    //
    // 🔴 THE DAY SUPPLY IS FINITE ON PURPOSE. An earlier version of this test fed
    // the same stuck day forever, so the mutant was "killed" only by HANGING the
    // suite — 43s, `tests 0ms`, no named failure, and indistinguishable from a
    // CI timeout. It was also a mock artifact: in production the cursor is
    // monotonic and bounded by `boundary`, so the loop always terminates and an
    // unbounded default could never hang. With a finite supply the mutant fails
    // an ASSERTION instead: 20 stuck days are available, the derived bound stops
    // at 8, and MAX_SAFE_INTEGER would report 20.
    const stuck = Array.from({ length: 20 }, (_, i) => [
      new Date(Date.UTC(2026, 7, i + 1, 9)),
      [accrual({ id: `s${i}a` }), accrual({ id: `s${i}b` })],
    ]) as [Date, Record<string, unknown>[]][];
    days(stuck);

    const result = await settleBlockAuthorFees({ date: RUN, limit: 1, maxDays: 2 });

    // Never productive, so maxDays cannot bind; the derived maxIterations (2 * 4)
    // is the only thing that stops it short of all 20.
    expect(result.daysTruncated).toBe(8);
  });

  it('🔴 accumulated STUCK days do not starve the productive ones', async () => {
    // maxDays counts productive days only. With three permanently-oversized days
    // ahead of a good one and maxDays: 1, the good day must still settle —
    // otherwise N stuck days eventually consume the whole budget and settlement
    // stops for everyone, which is what the cursor was added to prevent.
    days([
      [new Date('2026-09-13T09:00:00Z'), [accrual({ id: 'a' }), accrual({ id: 'b' })]],
      [new Date('2026-09-14T09:00:00Z'), [accrual({ id: 'c' }), accrual({ id: 'd' })]],
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'e' }), accrual({ id: 'f' })]],
      [new Date('2026-09-16T09:00:00Z'), [accrual({ id: 'g', feeBuzz: 5 })]],
    ]);

    const result = await settleBlockAuthorFees({ date: RUN, limit: 1, maxDays: 1 });

    expect(result.daysTruncated).toBe(3);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany.mock.calls[0][0][0].externalTransactionId).toContain('2026-09-16');
  });

  it('🔴 a day on which every bucket DROPPED is not counted productive', async () => {
    // The second stuck arm. The oversized arm was excluded because it continues
    // before the counter; this one reached it, so a permanently-rejected owner
    // burned one productive-day slot per day and thirty of them would stop
    // settlement for everyone — the failure the productive count exists to
    // prevent, named by its comment but not covered by its test.
    days([
      [new Date('2026-09-13T09:00:00Z'), [accrual({ id: 'a', appOwnerUserId: 111 })]],
      [new Date('2026-09-14T09:00:00Z'), [accrual({ id: 'b', appOwnerUserId: 111 })]],
      [new Date('2026-09-15T09:00:00Z'), [accrual({ id: 'c', appOwnerUserId: 222, feeBuzz: 5 })]],
    ]);
    mockCreateMany
      .mockResolvedValueOnce({ transactions: [], conflicts: [] }) // day 1 dropped
      .mockResolvedValueOnce({ transactions: [], conflicts: [] }) // day 2 dropped
      .mockResolvedValueOnce({ transactions: [{ id: 'tx' }], conflicts: [] });

    // maxDays: 1 — the two dropped days must not consume it.
    const result = await settleBlockAuthorFees({ date: RUN, maxDays: 1 });

    expect(mockCreateMany).toHaveBeenCalledTimes(3);
    expect(result.rowsSettled).toBe(1);
    expect(mockCreateMany.mock.calls[2][0][0].externalTransactionId).toContain('2026-09-15');
  });

  it('maxIterations bounds the loop when every day is stuck', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findFirst.mockResolvedValue({
      accruedAt: new Date('2026-09-15T09:00:00Z'),
    });
    mockDbWrite.blockAuthorFeeAccrual.findMany.mockResolvedValue([
      accrual({ id: 'a' }),
      accrual({ id: 'b' }),
    ]);

    const result = await settleBlockAuthorFees({
      date: RUN,
      limit: 1,
      maxDays: 5,
      maxIterations: 3,
    });

    // Never productive, so maxDays never binds — maxIterations is what stops it.
    expect(result.daysTruncated).toBe(3);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('no-ops when there is nothing accrued', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findFirst.mockResolvedValue(null);
    const result = await settleBlockAuthorFees({ date: RUN });
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      buckets: 0,
      rowsSettled: 0,
      buzzMinted: 0,
      daysTruncated: 0,
      flipFailures: 0,
    });
  });
});
