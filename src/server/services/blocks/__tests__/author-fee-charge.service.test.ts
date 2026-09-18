import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the author-fee VIEWER-CHARGE path (slice 2b) — quote, debit,
 * accrue, reverse.
 *
 * ── WHAT KIND OF COVERAGE THIS IS, STATED HONESTLY ──────────────────────────
 * `author-fee-charge.service.ts` is a NEW module, so nothing in this file could
 * have been RED at `origin/main` for any reason except the import failing. These
 * are NEW-FEATURE guards, not regression guards, and they must not be counted as
 * the latter. The genuinely red-at-base guard for this change is
 * `src/server/services/__tests__/no-divergent-author-fee-base.test.ts`, which
 * enumerates the router call sites and finds ZERO charge sites at the base.
 *
 * What makes the guards below real is the MUTATION SWEEP recorded in the PR
 * body: each rule was broken on purpose and the named test went red with its own
 * assertion.
 *
 * ── THE PROPERTIES WORTH PINNING ────────────────────────────────────────────
 * Every one of them fails SILENTLY and FINANCIALLY:
 *
 *   - the fee can never exceed what the caller reserved, so it can never escape
 *     the viewer's per-call budget, daily cap or per-app CONSENT BUDGET
 *   - a path that reserved nothing charges nothing, whatever the realized base says
 *   - self-dealing is refused BEFORE the debit, not after it — slice 2a's
 *     exclusion ran only on the accrual, so a charge path that skipped it would
 *     take the money and then decline to owe anyone
 *   - a debit is reconciled BY COUNT: `createBuzzTransactionMany` drops an
 *     `insufficientFunds` result from BOTH arrays without throwing, so "it did
 *     not throw" says nothing about whether money moved
 *   - a landed debit whose accrual failed is REFUNDED — including when the accrual
 *     THREW rather than returning a reason — or the platform silently keeps money
 *     it is only a conduit for (D1)
 *   - a reversal deletes only a row whose accrual day is still OPEN, and only the
 *     caller whose guarded DELETE matched issues the refund
 *
 * ── WHAT IS AND IS NOT MOCKED ───────────────────────────────────────────────
 * The Buzz service, the Flipt flag, Prisma and the logger are mocked at the
 * module boundary. `accrueBlockAuthorFee` is NOT mocked, deliberately: the
 * expensive defects on this path live in the SEAM between the charge and the
 * accrual (a charge that self-deals, an accrual failure nobody refunds), and a
 * mocked accrual cannot express either. That also means Prisma's `oauthClient`
 * mock is what drives the self-dealing arms end to end.
 *
 * 🔴 PRISMA IS MOCKED AT THE MODULE BOUNDARY, SO A GREEN RUN HERE IS NOT A CLAIM
 * THAT ANY OF THIS WORKS AGAINST A REAL DATABASE. No test in this file has ever
 * touched `block_author_fee_accrual`.
 */

const { mockLog, mockCreateMany, mockFlag } = vi.hoisted(() => ({
  mockLog: vi.fn(),
  mockCreateMany: vi.fn(),
  mockFlag: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => mockCreateMany(...args),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorFeeEnabled: () => mockFlag(),
}));

import {
  blockAuthorFeeChargeKey,
  blockAuthorFeeReversalKey,
  chargeBlockAuthorFee,
  quoteBlockAuthorFee,
  reverseBlockAuthorFee,
} from '../author-fee-charge.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) => {
  mockLog(...args);
  return Promise.resolve(null);
});

const APP_ID = 'app_charge';
const APP_BLOCK_ID = 'apb_charge';
const OWNER_ID = 941;
const VIEWER_ID = 137;
const WORKFLOW_ID = 'wf_charge';

/**
 * A base that makes the fee UNAMBIGUOUS under the platform config
 * (1 ⚡ flat / 5% of base): `floor(400 × 500 / 10000) = 20`, so the percentage
 * leg governs and 20 shares no value with the flat leg, the default percentage,
 * the basis-point scale, or any reservation figure used below. A mutant that
 * reaches for a constant instead of the computed fee cannot land on 20.
 */
const BASE_BUZZ = 400;
const EXPECTED_FEE = 20;

/** Every `...Once` queue in this suite, reset explicitly. */
function resetOnceQueues() {
  mockCreateMany.mockReset();
  mockFlag.mockReset();
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbWrite.blockAuthorFeeAccrual.create.mockReset();
  mockDbWrite.blockAuthorFeeAccrual.findUnique.mockReset();
  mockDbWrite.blockAuthorFeeAccrual.deleteMany.mockReset();
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 clearAllMocks CLEARS CALL HISTORY BUT NOT `mockResolvedValueOnce` QUEUES —
  // those are implementations, and only a reset drops them. Every mock this suite
  // feeds with `...Once` is reset above, or a queue left over by one test is
  // consumed by the next and the suite becomes order-dependent.
  resetOnceQueues();
  mockFlag.mockResolvedValue(true);
  mockDbRead.oauthClient.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER_ID });
  mockDbWrite.blockAuthorFeeAccrual.create.mockResolvedValue({});
  // 🔴 THE FAKE MATCHES THE REAL CONTRACT. `createBuzzTransactionMany` returns
  // `{ transactions, conflicts }` and does NOT throw on a per-transaction
  // failure — a dropped transaction is simply absent from both arrays. A fake
  // that resolved to `undefined` could express neither a conflict nor a drop,
  // which is structurally why those are the two arms worth testing.
  mockCreateMany.mockImplementation(async (txs: unknown[]) => ({
    transactions: txs.map((_, i) => ({ id: `tx_${i}` })),
    conflicts: [],
  }));
});

function chargeArgs(over: Record<string, unknown> = {}) {
  return {
    workflowId: WORKFLOW_ID,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    viewerUserId: VIEWER_ID,
    buzzType: 'yellow' as const,
    baseGenerationBuzz: BASE_BUZZ,
    priceIsCap: false,
    generationType: 'textToImage:txt2img',
    reservedAuthorFeeBuzz: EXPECTED_FEE,
    ...over,
  };
}

function quoteArgs(over: Record<string, unknown> = {}) {
  return {
    baseGenerationBuzz: BASE_BUZZ,
    priceIsCap: false,
    generationType: 'textToImage:txt2img',
    appId: APP_ID,
    viewerUserId: VIEWER_ID,
    workflowLabel: WORKFLOW_ID,
    ...over,
  };
}

/** The one debit transaction the charge path submits, or undefined. */
function debitTx() {
  const call = mockCreateMany.mock.calls.find(
    (c) => (c[0] as { externalTransactionId: string }[])[0].fromAccountId !== 0
  );
  return call?.[0][0];
}

/** The one refund transaction, or undefined. */
function refundTx() {
  const call = mockCreateMany.mock.calls.find(
    (c) => (c[0] as { fromAccountId: number }[])[0].fromAccountId === 0
  );
  return call?.[0][0];
}

describe('quoteBlockAuthorFee — pricing the fee INTO the reservation', () => {
  it('prices the fee off the whatIf BASE and returns the payee', async () => {
    const quote = await quoteBlockAuthorFee(quoteArgs());
    // 20 is computed by hand from the platform rule: max(1, floor(400 × 5%)).
    expect(quote).toEqual({
      charge: true,
      feeBuzz: EXPECTED_FEE,
      appOwnerUserId: OWNER_ID,
      computation: expect.objectContaining({ feeBuzz: EXPECTED_FEE, baseGenerationBuzz: 400 }),
    });
  });

  it('🔴 is DARK behind the flag, and reads it before the database', async () => {
    mockFlag.mockResolvedValue(false);
    const quote = await quoteBlockAuthorFee(quoteArgs());
    expect(quote).toEqual({ charge: false, reason: 'flag-disabled' });
    // The ordering half: with the flag off nothing may cost a query. A copy of
    // the pricing hoisted above the flag read would leave this call behind.
    expect(mockDbRead.oauthClient.findUnique).not.toHaveBeenCalled();
  });

  it('a flag read that throws is not permission to charge anyone', async () => {
    mockFlag.mockRejectedValue(new Error('flipt unreachable'));
    expect(await quoteBlockAuthorFee(quoteArgs())).toEqual({
      charge: false,
      reason: 'flag-disabled',
    });
  });

  it('refuses a CAP-priced generation, and does so before it looks at the base', async () => {
    // Both provisional: a cap price AND no base. `price-is-cap` must win, or the
    // recoverable `base-unavailable` population acquires a silent bias.
    const quote = await quoteBlockAuthorFee(
      quoteArgs({ priceIsCap: true, baseGenerationBuzz: null })
    );
    expect(quote).toEqual({ charge: false, reason: 'price-is-cap' });
  });

  it('refuses when the orchestrator surfaced no base', async () => {
    expect(await quoteBlockAuthorFee(quoteArgs({ baseGenerationBuzz: null }))).toEqual({
      charge: false,
      reason: 'base-unavailable',
    });
  });

  it('a zero fee is the ABSENCE of a charge, and costs no payee query', async () => {
    // `chat-completion` is 0/0 in the platform table.
    const quote = await quoteBlockAuthorFee(quoteArgs({ generationType: 'chat-completion' }));
    expect(quote).toEqual({ charge: false, reason: 'zero-fee' });
    expect(mockDbRead.oauthClient.findUnique).not.toHaveBeenCalled();
  });

  it('🔴 refuses SELF-DEALING at quote time, so no fee is ever reserved for it', async () => {
    const quote = await quoteBlockAuthorFee(quoteArgs({ viewerUserId: OWNER_ID }));
    expect(quote).toEqual({ charge: false, reason: 'self-dealing' });
  });

  it('refuses when the app or its owner cannot be resolved', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue(null);
    expect(await quoteBlockAuthorFee(quoteArgs())).toEqual({
      charge: false,
      reason: 'app-missing',
    });
  });

  it('degrades to no-fee rather than throwing when the payee lookup fails', async () => {
    mockDbRead.oauthClient.findUnique.mockRejectedValue(new Error('connection lost'));
    expect(await quoteBlockAuthorFee(quoteArgs())).toEqual({ charge: false, reason: 'error' });
  });
});

describe('chargeBlockAuthorFee — the debit', () => {
  it('debits the viewer, credits the platform conduit, and writes the accrual', async () => {
    const result = await chargeBlockAuthorFee(chargeArgs());

    expect(result).toEqual({ charged: true, feeBuzz: EXPECTED_FEE, accrualId: expect.any(String) });
    const tx = debitTx();
    expect(tx.fromAccountId).toBe(VIEWER_ID);
    expect(tx.toAccountId).toBe(0);
    expect(tx.amount).toBe(EXPECTED_FEE);
    // D6 — the account the generation drained IS the fee's currency, on both legs.
    expect(tx.fromAccountType).toBe('yellow');
    expect(tx.toAccountType).toBe('yellow');
    expect(tx.externalTransactionId).toBe(blockAuthorFeeChargeKey(WORKFLOW_ID));

    // D1 — the author is owed exactly what the viewer was debited.
    const row = mockDbWrite.blockAuthorFeeAccrual.create.mock.calls[0][0].data;
    expect(row.feeBuzz).toBe(EXPECTED_FEE);
    expect(row.appOwnerUserId).toBe(OWNER_ID);
    expect(row.viewerUserId).toBe(VIEWER_ID);
    expect(row.buzzType).toBe('yellow');
  });

  it('🔴 a path that RESERVED NOTHING charges nothing, whatever the realized base says', async () => {
    // The structural bound. `baseGenerationBuzz` here would price a 20 ⚡ fee.
    const result = await chargeBlockAuthorFee(chargeArgs({ reservedAuthorFeeBuzz: 0 }));
    expect(result).toEqual({ charged: false, reason: 'not-reserved' });
    expect(mockCreateMany).not.toHaveBeenCalled();
    // Not even the flag is read — nothing below the bound may run.
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('🔴 NEVER charges more than was reserved (the consent-budget escape)', async () => {
    // Realized fee 20, reserved 6: the whatIf priced a cheaper generation than the
    // submit realized. The viewer is billed 6, the number every gate was measured
    // against. 6 is deliberately not a divisor of 20 and not any module constant.
    const result = await chargeBlockAuthorFee(chargeArgs({ reservedAuthorFeeBuzz: 6 }));
    expect(result).toEqual({ charged: true, feeBuzz: 6, accrualId: expect.any(String) });
    expect(debitTx().amount).toBe(6);
    // The ROW carries the CHARGED number, or the settlement rail would mint the
    // unclamped one and the author would be paid money the viewer never lost.
    expect(mockDbWrite.blockAuthorFeeAccrual.create.mock.calls[0][0].data.feeBuzz).toBe(6);
  });

  it('charges the REALIZED fee when it is below the reservation', async () => {
    // Reserved 50, realized 20 → the viewer keeps the difference. The clamp is a
    // ceiling, not a floor: a mutant that used the reserve unconditionally bills 50.
    const result = await chargeBlockAuthorFee(chargeArgs({ reservedAuthorFeeBuzz: 50 }));
    expect(result).toEqual({
      charged: true,
      feeBuzz: EXPECTED_FEE,
      accrualId: expect.any(String),
    });
    expect(debitTx().amount).toBe(EXPECTED_FEE);
  });

  it('🔴 refuses SELF-DEALING BEFORE the debit, not after it', async () => {
    // Slice 2a's exclusion lived only in the accrual writer, so a charge path that
    // did not consult it would take the money and then decline to owe anyone.
    const result = await chargeBlockAuthorFee(chargeArgs({ viewerUserId: OWNER_ID }));
    expect(result).toEqual({ charged: false, reason: 'self-dealing' });
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('does not charge a cap-priced generation', async () => {
    const result = await chargeBlockAuthorFee(chargeArgs({ priceIsCap: true }));
    expect(result).toEqual({ charged: false, reason: 'price-is-cap' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('does not charge when the realized response carried no base', async () => {
    const result = await chargeBlockAuthorFee(chargeArgs({ baseGenerationBuzz: null }));
    expect(result).toEqual({ charged: false, reason: 'base-unavailable' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('🔴 a DROPPED debit is a failure, and it neither throws nor appears in either array', async () => {
    // The insufficient-funds shape: the client reports it by OMISSION. A reader
    // that trusted "it did not throw" would accrue a fee nobody paid.
    mockCreateMany.mockResolvedValue({ transactions: [], conflicts: [] });
    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({ charged: false, reason: 'debit-failed' });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('a CONFLICT means the money already moved — it accrues rather than failing', async () => {
    mockCreateMany.mockResolvedValue({ transactions: [], conflicts: [{ id: 'dup' }] });
    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({ charged: true, feeBuzz: EXPECTED_FEE, accrualId: expect.any(String) });
  });

  it('a throwing debit charges nothing and does not throw out', async () => {
    mockCreateMany.mockRejectedValue(new Error('buzz service down'));
    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({ charged: false, reason: 'debit-failed' });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('🔴 REFUNDS the viewer when the debit landed but the accrual did not', async () => {
    // The one pair D1 forbids in both directions: the viewer paid and no row says
    // who is owed it, so the platform keeps money it is only a conduit for.
    mockDbWrite.blockAuthorFeeAccrual.create.mockRejectedValue(new Error('connection lost'));
    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({ charged: false, reason: 'accrual-failed' });

    const refund = refundTx();
    expect(refund.fromAccountId).toBe(0);
    expect(refund.toAccountId).toBe(VIEWER_ID);
    expect(refund.amount).toBe(EXPECTED_FEE);
    // 🔴 THE REVERSAL KEY, NOT A FRESH ONE — a terminal reversal of the same
    // workflow later must CONFLICT here rather than refund a second time.
    expect(refund.externalTransactionId).toBe(blockAuthorFeeReversalKey(WORKFLOW_ID));
  });

  it('🔴 REFUNDS the viewer when the accrual THREW after the debit landed', async () => {
    // 🔴 RED AT `1672a1e3cc`: the `accrueBlockAuthorFee` call sat outside every
    // `try`, so this rejection escaped `chargeBlockAuthorFee` entirely and this
    // test failed by the awaited call rejecting rather than by an assertion.
    //
    // The mechanism is not exotic. `accrueBlockAuthorFee` re-resolves the payee
    // through `resolveBlockAuthorFeePayee`, whose `dbRead.oauthClient.findUnique`
    // is documented to PROPAGATE on a database failure — deliberately, so a
    // charge path that cannot establish a payee does not proceed as though it
    // had. By the time it runs, the debit has already landed. So: the FIRST
    // lookup (the quote's) resolves and the SECOND (the accrual's) rejects.
    mockDbRead.oauthClient.findUnique
      .mockResolvedValueOnce({ id: APP_ID, userId: OWNER_ID })
      .mockRejectedValueOnce(new Error('connection lost'));

    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({ charged: false, reason: 'accrual-failed' });

    // The debit landed …
    expect(debitTx().amount).toBe(EXPECTED_FEE);
    // … and the viewer got it back, under the REVERSAL key so a later terminal
    // reversal of the same workflow conflicts instead of refunding twice.
    const refund = refundTx();
    expect(refund.fromAccountId).toBe(0);
    expect(refund.toAccountId).toBe(VIEWER_ID);
    expect(refund.amount).toBe(EXPECTED_FEE);
    expect(refund.externalTransactionId).toBe(blockAuthorFeeReversalKey(WORKFLOW_ID));

    const line = mockLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((l) => l.message === 'accrual threw after the debit landed — refunding the viewer');
    expect(line).toMatchObject({ viewerUserId: VIEWER_ID, feeBuzz: EXPECTED_FEE });
  });

  it('a DUPLICATE accrual is the same state as a conflict — no refund', async () => {
    const dup = Object.assign(new Error('P2002'), { code: 'P2002' });
    mockDbWrite.blockAuthorFeeAccrual.create.mockRejectedValue(dup);
    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({ charged: true, feeBuzz: EXPECTED_FEE, accrualId: null });
    expect(refundTx()).toBeUndefined();
  });

  it('the charge key and the reversal key share no namespace', () => {
    // A settlement key is `block-author-fee-<day>-<owner>-<currency>`; a bare
    // `block-author-fee-` prefix here would put a workflow id and a settlement
    // tuple in one namespace, where a collision moves money to the wrong side.
    expect(blockAuthorFeeChargeKey('w')).toBe('block-author-fee-charge-w');
    expect(blockAuthorFeeReversalKey('w')).toBe('block-author-fee-reversal-w');
    expect(blockAuthorFeeChargeKey('w')).not.toBe(blockAuthorFeeReversalKey('w'));
  });
});

describe('reverseBlockAuthorFee — the fee follows the refund', () => {
  /**
   * 🔴 A FIXED CLOCK, BECAUSE THE GUARD IS A DAY BOUNDARY. `reverseBlockAuthorFee`
   * refuses any row whose ACCRUAL DAY is complete — that is the structural
   * statement of "a mint may already have landed for this row's bucket", since the
   * settlement rail only ever scans rows accrued strictly before midnight UTC of
   * its own run day. Reading the real clock here would make every test below flip
   * at 00:00 UTC.
   *
   * `NOW` is mid-morning; `SAME_DAY` is half an hour after the midnight that
   * precedes it, and `PRIOR_DAY` an hour before that midnight. Neither is a
   * boundary value, so a mutant that swaps `<` for `<=` is not what these catch —
   * they catch the guard being absent.
   */
  const NOW = new Date('2026-09-18T10:00:00.000Z');
  const DAY_START = new Date('2026-09-18T00:00:00.000Z');
  const SAME_DAY = new Date('2026-09-18T00:30:00.000Z');
  const PRIOR_DAY = new Date('2026-09-17T23:00:00.000Z');

  const accruedRow = {
    id: 'bafa_1',
    status: 'accrued',
    viewerUserId: VIEWER_ID,
    buzzType: 'blue',
    feeBuzz: 13,
    accruedAt: SAME_DAY,
  };

  // The common case, and the one the conservative day guard must NOT over-reach
  // into: a workflow that reaches a terminal state on the day it ran. `SAME_DAY`
  // is half an hour past midnight, so it exercises the guard's OPEN side rather
  // than sitting comfortably mid-afternoon.
  it('refunds the viewer and deletes the unsettled row', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue(accruedRow);
    mockDbWrite.blockAuthorFeeAccrual.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'failed',
      now: NOW,
    });

    expect(result).toEqual({ reversed: true, feeBuzz: 13 });
    const refund = refundTx();
    expect(refund.fromAccountId).toBe(0);
    expect(refund.toAccountId).toBe(VIEWER_ID);
    expect(refund.amount).toBe(13);
    // D6 carried through the reversal too — a blue fee refunds as blue, or a
    // failed generation would mint withdrawable Buzz out of free Buzz.
    expect(refund.toAccountType).toBe('blue');
    expect(refund.externalTransactionId).toBe(blockAuthorFeeReversalKey(WORKFLOW_ID));
  });

  it('🔴 REFUSES a row whose ACCRUAL DAY IS COMPLETE, even though its status reads `accrued`', async () => {
    // 🔴 RED AT `1672a1e3cc`, WHERE THIS RETURNED `{reversed:true, feeBuzz:13}`
    // AND ISSUED A REFUND.
    //
    // The guard used to be spelled on `status`, and `status` cannot answer the
    // question. The settlement rail MINTS at its `createBuzzTransactionMany` and
    // only flips the status at the `updateMany` after it, so between those two
    // statements the money is already the author's while the row still reads
    // `accrued`. And the reachable arm is not that race: when the flip THROWS,
    // settlement increments `flipFailures` and leaves the rows `accrued` until the
    // next nightly run — so a status-only guard deterministically double-pays for
    // ~24h (author minted, viewer refunded, platform funding the gap, which D1
    // forbids).
    //
    // This row is exactly that state: minted-or-mintable, status still `accrued`.
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
      ...accruedRow,
      status: 'accrued',
      accruedAt: PRIOR_DAY,
    });
    // 🔴 THE DELETE IS ARMED TO SUCCEED ON PURPOSE. Leaving it unconfigured would
    // make this test red at the base for the wrong reason — the destructure of an
    // undefined result throwing into the catch — rather than because the base
    // DELETED THE ROW AND REFUNDED THE VIEWER on a fee the author may already have
    // been minted. Armed, the base reaches `{reversed:true, feeBuzz:13}` and the
    // refund transaction is actually issued, which is the defect.
    mockDbWrite.blockAuthorFeeAccrual.deleteMany.mockResolvedValue({ count: 1 });
    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'failed',
      now: NOW,
    });
    expect(result).toEqual({ reversed: false, reason: 'settlement-eligible' });
    expect(mockDbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();

    // The log has to carry the pair that separates "already minted" from
    // "refused conservatively" — the row's own status.
    const line = mockLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((l) => l.message === 'fee accrual day is settleable — not reversed');
    expect(line).toMatchObject({ rowStatus: 'accrued', feeBuzz: 13, viewerUserId: VIEWER_ID });
  });

  it('🔴 the DELETE CLAIM carries the day boundary as well as the status', async () => {
    // 🔴 RED AT `1672a1e3cc`: the claim was `{ workflowId, status }` only.
    //
    // ⚠️ WHAT THIS PINS IS THE WHERE SHAPE, NOT A RACE THIS CLAUSE CLOSES — AN
    // EARLIER VERSION OF THIS COMMENT SAID "the row can become settleable between
    // the read and the delete", AND IT CANNOT. `reverseBlockAuthorFee` freezes
    // `now` before the read and `accrued_at` is written once by the column default
    // and never updated, so the boundary comparison has the same answer at the
    // check and at the claim. `status` is the clause that closes a real race (a
    // concurrent flip or a concurrent observer's delete can move it). The boundary
    // is carried into the claim as defence-in-depth — it costs nothing and is what
    // a future caller recomputing the clock would need — and this test pins that
    // it is carried, which is the property a refactor would drop.
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue(accruedRow);
    mockDbWrite.blockAuthorFeeAccrual.deleteMany.mockResolvedValue({ count: 1 });
    await reverseBlockAuthorFee({ workflowId: WORKFLOW_ID, terminalStatus: 'failed', now: NOW });
    expect(mockDbWrite.blockAuthorFeeAccrual.deleteMany.mock.calls[0][0].where).toEqual({
      workflowId: WORKFLOW_ID,
      status: 'accrued',
      accruedAt: { gte: DAY_START },
    });
  });

  it('🔴 refuses a SETTLED row — the money is already the author’s', async () => {
    // The second layer, pinned as a UNIT property rather than as a production
    // scenario.
    //
    // ⚠️ AN EARLIER VERSION OF THIS COMMENT NAMED THE WRONG MECHANISM — it said
    // this state arises "if a settlement run is mid-flight", and mid-flight is NOT
    // sufficient. The flip only ever writes rows the scan selected, i.e. rows
    // whose accrual day is already COMPLETE, and the eligibility guard refuses
    // those first. So `already-settled` is unreachable in production as the guards
    // are ordered today: reaching it needs the settling app's clock a whole UTC
    // day ahead of the reversing app's, or a manual `settleBlockAuthorFees({ date
    // })` run with a future date. An operator alerting on its log line would get
    // permanent silence. The refusal must still hold without the day guard having
    // caught it — they are different claims — and that ordering-independence is
    // what this test pins.
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue({
      ...accruedRow,
      status: 'settled',
      accruedAt: SAME_DAY,
    });
    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'canceled',
      now: NOW,
    });
    expect(result).toEqual({ reversed: false, reason: 'already-settled' });
    expect(mockDbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('🔴 only the caller whose DELETE matched refunds (concurrent terminal polls)', async () => {
    // The row was read as `accrued` and then settled — or claimed by a concurrent
    // poll — between the two statements. Without the count check BOTH callers
    // would refund the same fee.
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue(accruedRow);
    mockDbWrite.blockAuthorFeeAccrual.deleteMany.mockResolvedValue({ count: 0 });
    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'failed',
      now: NOW,
    });
    expect(result).toEqual({ reversed: false, reason: 'no-accrual' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('no-ops for a workflow that never accrued a fee', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue(null);
    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'expired',
      now: NOW,
    });
    expect(result).toEqual({ reversed: false, reason: 'no-accrual' });
    expect(mockDbWrite.blockAuthorFeeAccrual.deleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('🔴 a DROPPED refund is reported, not swallowed as success', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockResolvedValue(accruedRow);
    mockDbWrite.blockAuthorFeeAccrual.deleteMany.mockResolvedValue({ count: 1 });
    mockCreateMany.mockResolvedValue({ transactions: [], conflicts: [] });
    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'failed',
      now: NOW,
    });
    expect(result).toEqual({ reversed: false, reason: 'refund-failed' });
    // The row is already gone, so this log line is the ONLY recovery handle —
    // it must carry the amount and the account.
    const line = mockLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((l) => l.message === 'fee refund did not land — viewer is still charged');
    expect(line).toMatchObject({ viewerUserId: VIEWER_ID, feeBuzz: 13, buzzType: 'blue' });
  });

  it('does not throw when the lookup fails', async () => {
    mockDbWrite.blockAuthorFeeAccrual.findUnique.mockRejectedValue(new Error('connection lost'));
    const result = await reverseBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      terminalStatus: 'failed',
      now: NOW,
    });
    expect(result).toEqual({ reversed: false, reason: 'refund-failed' });
  });
});
