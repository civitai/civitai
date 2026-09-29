import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the author-fee ACCRUAL LEDGER (slice 2a).
 *
 * 🔴 SCOPE, STATED BECAUSE THIS SUITE USED TO BE WIDER. It pins hop 1 only —
 * writing a row that records a debit already taken. It pins NOTHING about money
 * moving, because in this slice nothing does: `settleBlockAuthorFees`, its 25
 * tests and its cron went to `zach/app-blocks-author-fee-slice2b`, held back
 * until a charge path exists to supply rows. A reader looking here for the
 * dedup-key or bucket-currency properties will not find them, and that is the
 * split, not a gap.
 *
 * The properties this suite does pin are the ones whose failure is silent and
 * financial at WRITE time:
 *
 *   - the computation is written through unchanged, so the author is owed
 *     EXACTLY what the viewer was debited (D1: the platform is a conduit and
 *     takes no cut)
 *   - the buzz type is carried, never defaulted (D6) — a coerced row would
 *     later convert non-withdrawable Buzz into withdrawable earnings
 *   - self-dealing never accrues
 *   - a unique violation is a DUPLICATE, not a failure, so a resubmit of the
 *     same workflow cannot be mistaken for a lost accrual and compensated
 *
 * The clawback was retired in round 0 (zero production callers, and its
 * carry-forward arm unreachable until something had settled), so there is
 * nothing here pinning a reversal — slice 2b brings both back together.
 *
 * Prisma and the logger are mocked at the module boundary. 🔴 The Buzz service
 * is NOT mocked here, and must not be: this module's graph does not reach it,
 * and mocking a service the code under test cannot call would read as coverage
 * of a payment path this slice does not have.
 */

const { mockLog } = vi.hoisted(() => ({
  mockLog: vi.fn(),
}));

import { accrueBlockAuthorFee, resolveBlockAuthorFeePayee } from '../author-fee-accrual.service';
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
  // 🔴 clearAllMocks CLEARS CALL HISTORY BUT NOT `mockResolvedValueOnce` QUEUES —
  // those are implementations, and only a reset drops them. Every mock this suite
  // feeds with `...Once` must therefore be reset explicitly, or a queue left over
  // by one test is consumed by the next and the suite becomes order-dependent.
  //
  // `create` is the only such mock left after the settlement suite moved to slice
  // 2b — it is fed `mockRejectedValueOnce` by two tests below. The three day-loop
  // mocks that used to be reset here (`findFirst`, `findMany`, `updateMany`) went
  // with that suite; nothing in this file reads them, so resetting them would be a
  // guard against a queue no test can fill.
  mockDbWrite.blockAuthorFeeAccrual.create.mockReset();
  mockDbRead.oauthClient.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER_ID });
  mockDbWrite.blockAuthorFeeAccrual.create.mockResolvedValue({});
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

/**
 * `suppressSkipLogs` — the DISCLOSURE callers' log switch.
 *
 * 🔴 THIS SUITE EXISTS BECAUSE A STRUCTURAL GUARD SURVIVED THE MUTATION THAT
 * BROKE IT. `no-divergent-author-fee-base.test.ts` pins that exactly the two
 * DISCLOSING quote sites pass `suppressSkipLogs: true` — a source-text check on
 * the CALL. Making this function ignore the argument entirely (a one-line
 * `const suppressSkipLogs = false;` shadowing the destructure) left that guard,
 * and all 619 tests, completely green: the call site still read correctly while
 * the flag did nothing. That is the "a structural check type-checks past a wrong
 * argument" hole this file's sibling ledger names, reproduced exactly.
 *
 * So the pair is deliberate and BOTH halves are required: the ledger owns WHICH
 * sites pass it, and these own WHETHER IT DOES ANYTHING.
 *
 * Why the flag is worth having at all: both skip arms call `logToAxiom`, which
 * does an unconditional `console.error` — a synchronous write when stderr is a
 * pipe, which it is in a container — plus an HTTP ingest. The two ESTIMATE arms
 * that resolve the payee are unbounded (per parameter change, no rate limit),
 * and this file's own note records that ~91% of the spend population is operator
 * self-testing, i.e. the self-dealing arm is the hot one.
 */
describe('resolveBlockAuthorFeePayee — suppressSkipLogs', () => {
  beforeEach(() => mockLog.mockClear());

  /** The two arms that log. Each is a distinct branch, so both are driven. */
  const SKIP_ARMS = [
    { arm: 'self-dealing', owner: VIEWER_ID, reason: 'self-dealing' },
    { arm: 'app-missing', owner: null, reason: 'app-missing' },
  ] as const;

  for (const { arm, owner, reason } of SKIP_ARMS) {
    it(`logs the ${arm} skip by DEFAULT (positive control)`, async () => {
      // 🔴 THE POSITIVE CONTROL IS NOT OPTIONAL HERE. Without it, "0 log calls"
      // under suppression is indistinguishable from a probe wired to nothing —
      // a resolver that never logged on either path would pass the suppression
      // assertion below while proving nothing.
      mockDbRead.oauthClient.findUnique.mockResolvedValue(
        owner === null ? null : { id: APP_ID, userId: owner }
      );
      const result = await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: VIEWER_ID,
        workflowId: WORKFLOW_ID,
      });
      expect(result).toEqual({ payee: false, reason });
      expect(mockLog).toHaveBeenCalledTimes(1);
    });

    it(`🔴 suppresses the ${arm} skip log, and returns the SAME answer`, async () => {
      mockDbRead.oauthClient.findUnique.mockResolvedValue(
        owner === null ? null : { id: APP_ID, userId: owner }
      );
      const result = await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: VIEWER_ID,
        workflowId: WORKFLOW_ID,
        suppressSkipLogs: true,
      });
      // 🔴 THE RESOLUTION IS UNCHANGED. The flag governs what is WRITTEN, never
      // what is RETURNED — a variant that changed the answer would re-create
      // estimate/submit divergence one layer down, which is the exact defect the
      // disclosure exists to remove.
      expect(result).toEqual({ payee: false, reason });
      expect(mockLog).not.toHaveBeenCalled();
    });
  }

  it('never logs on the PAYEE-FOUND path, with or without the flag', async () => {
    // Establishes that the two tests above are about the SKIP arms specifically,
    // not about the function being chatty in general.
    //
    // 🔴 SERIALISED, AND THE CONCURRENT FORM WAS GREEN BY MICROTASK ORDERING
    // ALONE. This drove both arms through `Promise.all`, over a MODULE-LEVEL
    // `mockLog` that each arm `mockClear()`s — so arm B's clear could erase a log
    // call arm A had just made, and `expect(mockLog).not.toHaveBeenCalled()`
    // would pass on evidence that had been deleted rather than never produced.
    // A shared spy makes "no calls" and "calls someone else wiped"
    // indistinguishable; running the arms one at a time is what makes the zero
    // mean anything. `mockDbRead.oauthClient.findUnique` is shared the same way.
    for (const suppress of [undefined, true] as const) {
      mockLog.mockClear();
      mockDbRead.oauthClient.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER_ID });
      const r = await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: VIEWER_ID,
        workflowId: WORKFLOW_ID,
        suppressSkipLogs: suppress,
      });
      expect(r, `suppressSkipLogs: ${suppress}`).toEqual({
        payee: true,
        appOwnerUserId: OWNER_ID,
      });
      expect(mockLog, `suppressSkipLogs: ${suppress}`).not.toHaveBeenCalled();
    }
  });
});
