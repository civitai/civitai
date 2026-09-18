import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the author-fee ACCRUAL LEDGER (slice 2a).
 *
 * 🔴 SCOPE, STATED BECAUSE THIS SUITE USED TO BE WIDER. It pins hop 1 only —
 * writing a row that records a debit already taken. It pins NOTHING about money
 * moving: `settleBlockAuthorFees` and its 25 tests are slice 2b, in
 * `author-fee-settlement.service.test.ts`. A reader looking here for the
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

import { accrueBlockAuthorFee } from '../author-fee-accrual.service';
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
