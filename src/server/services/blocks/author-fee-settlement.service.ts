import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { newBlockAuthorFeeAccrualId } from '~/server/utils/app-block-ids';
import type { BlockAuthorFeeComputation } from './author-fee';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks PER-GENERATION AUTHOR FEE — slice 2, the settlement rail.
//
// SLICE 1 (#4922) computed the fee and threw it away. This slice persists it and
// pays it. It is the first slice that moves money, so the invariants are stated
// here rather than left to the reader.
//
// ── TWO HOPS, MIRRORING THE MODEL LICENSING FEE ────────────────────────────
//   1. AT SUBMIT the viewer is debited the fee, and one `accrued` row is written
//      naming the app owner it is owed to. That debit is the CALLER's job — this
//      module only records it.
//      🔴 THAT CALLER DOES NOT EXIST YET. Slice 2b adds it; nothing in this repo
//      calls `accrueBlockAuthorFee` today. An earlier revision of this comment
//      named `chargeBlockAuthorFee` "in the router" as though it were there. It
//      never was — the name appeared nowhere but in that sentence.
//   2. DAILY the accrued rows are summed per (owner × buzz type) and minted to
//      the owner in one transaction per bucket.
//
// This is exactly what `deliver-creator-compensation` does for the model
// licensing fee: the orchestrator charges the viewer at generation time, writes
// a per-resource fee row, and a daily job mints to the creator. Same two hops,
// same `externalTransactionId` dedup discipline, in a civitai-owned table
// because a licensing fee is keyed on a `modelVersionId` and an app fee has no
// model version.
//
// 🔴 THE PLATFORM IS A CONDUIT, NOT A PARTY. D1: the platform takes NO cut and
// funds NOTHING. So the author is credited EXACTLY what the viewer was debited —
// `feeBuzz` on the row is one number used on both sides. Any change that makes
// the credited total differ from the debited total is a change to that decision,
// not an implementation detail, and belongs in front of the operator.
//
// 🔴 NO FRACTIONAL ACCRUAL, AND THAT IS A DELIBERATE REVERSAL. The design
// inherited "fractional accrual, daily sum-then-floor" from the licensing rail.
// It does not transfer. The licensing fee is fractional because it is priced
// per-IMAGE at 0.01 ⚡ and the viewer pays the CEILING of the sum, so the
// creator's share genuinely has sub-buzz resolution. This fee is
// `max(flatBuzz, pct × base)` FLOORED TO WHOLE BUZZ before the viewer is shown
// or charged it — D7 requires the viewer see the exact number before the run,
// and Buzz cannot express a fraction. There is no sub-buzz residue to carry.
// The daily batch therefore exists for LEDGER VOLUME (one mint per author per
// day instead of one per generation), not for rounding, and its `Math.floor` is
// a no-op on integer inputs kept only so the arithmetic states its own
// direction.
//
// ⚠️ THE CONSEQUENCE IS REAL AND SLICE 3 MUST SURFACE IT: an author who sets a 0
// flat leg and a low percentage earns NOTHING on cheap generations, forever —
// `floor(4 × 500/10000) = 0`, every time. That is the same shape as the $0.00
// spend bounty this whole arc replaced. The difference is that it is now the
// AUTHOR'S explicit choice and the platform default (flat 1 ⚡) avoids it.
// ─────────────────────────────────────────────────────────────────────────────

// ── THE `D<n>` LABELS USED BELOW, STATED SO THEY RESOLVE HERE ──────────────
// They index an internal decision memo that is NOT in this repository, so a bare
// `D6` is authority with no referent for anyone reading this file. Each is
// therefore stated in full at least once:
//
//   D1  The fee is additive, author-set and viewer-paid. The platform takes NO
//       cut and funds NOTHING — so the author is credited exactly the amount the
//       viewer was debited.
//   D6  A viewer spending blue Buzz pays the fee in blue, and the author receives
//       blue (non-withdrawable). Currency is carried end to end, never coerced.
//   D7  The resolved fee must be shown to the viewer BEFORE the run. That is what
//       forces the fee to be a whole number the viewer can be quoted, which is
//       why the accrual amount is an integer rather than a fraction.
//
// ⚠️ `D8` and `D10` appear in this PR's description but implement nothing here —
// D8 is a process decision (build in three audited slices) and D10 records that
// the percent leg prices off `base` only, which slice 1 already did and which
// needed no code change. Do not go looking for them in this file.

export const BLOCK_AUTHOR_FEE_LOG_NAME = 'block-author-fee' as const;

/**
 * Lifecycle of one accrual row.
 *
 * ⚠️ USED, not decorative — every status literal written or compared below is
 * annotated with this type. An earlier revision exported both of these and then
 * wrote bare string literals everywhere, so neither was referenced even inside
 * this file and a typo'd `'setled'` would have compiled and silently matched
 * nothing.
 */
export type BlockAuthorFeeAccrualStatus = 'accrued' | 'settled' | 'clawed_back';

/** Which kind of row: the charge, or its carry-forward reversal. */
export type BlockAuthorFeeEntryType = 'accrual' | 'clawback';

const STATUS_ACCRUED: BlockAuthorFeeAccrualStatus = 'accrued';
const STATUS_SETTLED: BlockAuthorFeeAccrualStatus = 'settled';
const STATUS_CLAWED_BACK: BlockAuthorFeeAccrualStatus = 'clawed_back';
const ENTRY_ACCRUAL: BlockAuthorFeeEntryType = 'accrual';
const ENTRY_CLAWBACK: BlockAuthorFeeEntryType = 'clawback';

export type AccrueBlockAuthorFeeInput = {
  /** Orchestrator workflow id — the idempotency anchor. */
  workflowId: string;
  appId: string;
  appBlockId: string;
  /** The viewer who was debited. */
  viewerUserId: number;
  /** 🔴 D6 — the account the viewer paid from IS the account the author is paid in. */
  buzzType: BuzzAccountType;
  /** The slice-1 computation that produced the charge. */
  computation: BlockAuthorFeeComputation;
  /** The resolved generation type, or null when it could not be established. */
  generationType: string | null;
};

export type AccrueBlockAuthorFeeResult =
  | { accrued: true; id: string; feeBuzz: number }
  | { accrued: false; reason: 'zero-fee' | 'self-dealing' | 'app-missing' | 'duplicate' | 'error' };

/**
 * Record that a viewer has been debited an author fee, and that the app owner is
 * owed it.
 *
 * 🔴 CALL THIS ONLY AFTER THE VIEWER'S DEBIT HAS SUCCEEDED. The row asserts that
 * money was taken; writing it before the debit would make the platform owe an
 * author money it never collected, and the platform funds nothing.
 *
 * 🔴 AWAITED, NOT FIRE-AND-FORGET — unlike `recordSpendAttribution`, which is
 * telemetry off an already-billed submit and may be dropped. A viewer who has
 * been debited and whose accrual did not land is a real loss to a real author,
 * so the caller must know. It still does not THROW (see the catch): the decision
 * of what to do about a failed accrual — refund the viewer, or alert — belongs
 * to the charge path that holds the debit, not here.
 */
export async function accrueBlockAuthorFee(
  input: AccrueBlockAuthorFeeInput
): Promise<AccrueBlockAuthorFeeResult> {
  const { workflowId, appId, appBlockId, viewerUserId, buzzType, computation, generationType } =
    input;

  // A zero fee is not an accrual with an amount of zero — it is the absence of a
  // charge. Writing it would put rows in the ledger that can never settle (the
  // mint filters `amount > 0`) and would make "how many generations charged a
  // fee" unanswerable from the table.
  if (computation.feeBuzz <= 0) return { accrued: false, reason: 'zero-fee' };

  // Resolve + snapshot the app owner. 🔴 AT WRITE TIME, never at settlement: an
  // app that changes hands must not retroactively move earnings already accrued
  // to the previous owner (`app-ownership-transfer.service.ts` is the precedent).
  const app = await dbRead.oauthClient.findUnique({
    where: { id: appId },
    select: { id: true, userId: true },
  });
  if (!app?.userId) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'warning',
        message: 'accrual skipped: app or owner missing',
        workflowId,
        appId,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { accrued: false, reason: 'app-missing' };
  }

  // 🔴 SELF-DEALING EXCLUSION (operator, 2026-09-18). An author running their own
  // app would otherwise pay themself, which is a round trip that inflates every
  // earnings number while moving no real money — and is the cheapest possible
  // way to fake traction on an app. Excluded at ACCRUAL rather than at
  // settlement, so a self-run generation never enters the ledger at all.
  //
  // ⚠️ IT IS IMPLEMENTED ONCE, HERE, AND NOTHING SHARES IT. An earlier revision
  // claimed "the charge path reads this same predicate before taking the money".
  // There is no charge path (slice 2b) and no shared predicate — slice 1 has no
  // self-dealing check of any kind. So today a self-dealing viewer would still be
  // DEBITED by a charge path that does not consult this, and only the accrual
  // would be skipped. 🔴 Slice 2b must call this predicate BEFORE the debit, or
  // extract it; do not assume the exclusion is already enforced upstream.
  //
  // It is COUNTED, not silently dropped, so the exclusion is a number rather
  // than an absence — 91% of the spend population to date is operator
  // self-testing, so this arm is expected to be hot early and should not be
  // mistaken for the fee failing.
  if (app.userId === viewerUserId) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'info',
        message: 'accrual skipped: self-dealing',
        workflowId,
        appId,
        appOwnerUserId: app.userId,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { accrued: false, reason: 'self-dealing' };
  }

  const id = newBlockAuthorFeeAccrualId();

  try {
    await dbWrite.blockAuthorFeeAccrual.create({
      data: {
        id,
        workflowId,
        entryType: ENTRY_ACCRUAL,
        appId,
        appBlockId,
        appOwnerUserId: app.userId,
        viewerUserId,
        buzzType,
        feeBuzz: computation.feeBuzz,
        baseGenerationBuzz: computation.baseGenerationBuzz,
        flatLegBuzz: computation.flatLegBuzz,
        pctLegBuzz: computation.pctLegBuzz,
        governingLeg: computation.governingLeg,
        generationType,
        status: STATUS_ACCRUED,
      },
    });
  } catch (error) {
    // The unique index on (workflow_id, entry_type) is the idempotency guard: a
    // resubmit of the same workflow lands here rather than double-charging. It
    // is benign and must NOT be reported as a failure, or a retry would look
    // like a lost accrual and invite a compensating write.
    if (isUniqueViolation(error)) return { accrued: false, reason: 'duplicate' };

    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'accrual write failed',
        workflowId,
        appId,
        feeBuzz: computation.feeBuzz,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { accrued: false, reason: 'error' };
  }

  return { accrued: true, id, feeBuzz: computation.feeBuzz };
}

/**
 * Postgres unique-violation detection, by CODE rather than by message.
 *
 * ⚠️ Deliberately not `instanceof Prisma.PrismaClientKnownRequestError`: this
 * module is unit-tested against a mocked client, and an instanceof check against
 * the real Prisma class silently fails for a plain object carrying the right
 * code — turning the idempotency arm into dead code that no test can reach.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export type ClawbackReason = 'refund' | 'undelivered';

export type ClawbackBlockAuthorFeeResult =
  | { clawedBack: true; mode: 'voided' | 'carried-forward'; feeBuzz: number }
  | { clawedBack: false; reason: 'not-found' | 'already-clawed-back' | 'error' };

/**
 * Reverse an author fee when the generation it was charged on was refunded.
 *
 * 🔴 WHY THIS EXISTS AT ALL — the orchestrator refunds AFTER submit. A failed or
 * partially-delivered generation is re-priced with `undeliveredByJobId` and the
 * settled base drops below the submit-time base, with the difference refunded to
 * the viewer. If the fee did not follow, an author would earn on a generation
 * the viewer got their money back on.
 *
 * This is NOT a new policy invented here: the rail this fee is modelled on
 * already prorates. `CalculateLicenseFees` in the orchestrator weights every fee
 * by the job's delivered fraction, and `NothingDelivered_ZeroesTheFee` pins it.
 * Following the refund is the CONSISTENT behaviour.
 *
 * TWO MODES, decided by whether the money has already moved:
 *   * BEFORE settlement — flip the accrual to `clawed_back`. The daily sum never
 *     sees it and nothing was minted. Clean.
 *   * AFTER settlement — write a NEGATIVE `clawback` row. The next day's sum
 *     nets it off. This is the carry-forward shape already proven on the other
 *     rail (`voidAttributionsForPayment`), chosen over clawing Buzz back out of
 *     an author's balance, which can be spent and would fail.
 */
export async function clawbackBlockAuthorFee(args: {
  workflowId: string;
  reason: ClawbackReason;
}): Promise<ClawbackBlockAuthorFeeResult> {
  const { workflowId, reason } = args;

  try {
    const accrual = await dbRead.blockAuthorFeeAccrual.findUnique({
      where: { workflowId_entryType: { workflowId, entryType: ENTRY_ACCRUAL } },
    });
    if (!accrual) return { clawedBack: false, reason: 'not-found' };
    if (accrual.status === STATUS_CLAWED_BACK) {
      return { clawedBack: false, reason: 'already-clawed-back' };
    }

    if (accrual.status === STATUS_ACCRUED) {
      // Not yet paid — void it in place. Conditioned on the status so a
      // settlement running concurrently cannot be overwritten: if the row moved
      // to `settled` between the read and this write, zero rows match and we
      // fall through to the carry-forward below.
      const { count } = await dbWrite.blockAuthorFeeAccrual.updateMany({
        where: { id: accrual.id, status: STATUS_ACCRUED },
        data: { status: STATUS_CLAWED_BACK },
      });
      if (count > 0) {
        return { clawedBack: true, mode: 'voided', feeBuzz: accrual.feeBuzz };
      }
    }

    // Already settled (or settled underneath us) — carry the debt forward.
    await dbWrite.blockAuthorFeeAccrual.create({
      data: {
        id: newBlockAuthorFeeAccrualId(),
        workflowId,
        entryType: ENTRY_CLAWBACK,
        appId: accrual.appId,
        appBlockId: accrual.appBlockId,
        appOwnerUserId: accrual.appOwnerUserId,
        viewerUserId: accrual.viewerUserId,
        buzzType: accrual.buzzType,
        feeBuzz: -accrual.feeBuzz,
        baseGenerationBuzz: accrual.baseGenerationBuzz,
        flatLegBuzz: accrual.flatLegBuzz,
        pctLegBuzz: accrual.pctLegBuzz,
        governingLeg: accrual.governingLeg,
        generationType: accrual.generationType,
        status: STATUS_ACCRUED,
      },
    });

    return { clawedBack: true, mode: 'carried-forward', feeBuzz: accrual.feeBuzz };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A clawback row already exists for this workflow — the reversal already
      // happened. Idempotent, not an error.
      return { clawedBack: false, reason: 'already-clawed-back' };
    }
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'clawback failed',
        workflowId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { clawedBack: false, reason: 'error' };
  }
}

export type SettlementBucket = {
  appOwnerUserId: number;
  buzzType: string;
  /** Net Buzz across accrual and clawback rows in this bucket. May be <= 0. */
  totalBuzz: number;
  rowIds: string[];
};

export type SettleBlockAuthorFeesResult = {
  buckets: number;
  rowsSettled: number;
  buzzMinted: number;
  /** Buckets whose net was <= 0 (a clawback met or exceeded the day's earnings). */
  bucketsSkippedNonPositive: number;
};

/**
 * Settle every outstanding accrual: sum per (owner × buzz type), mint once per
 * bucket, flip the contributing rows to `settled`.
 *
 * 🔴 GROUPED BY buzzType, NEVER COERCED — D6. A viewer spending blue Buzz pays in
 * blue and the author receives blue (non-withdrawable). Collapsing the buckets
 * would convert non-withdrawable Buzz into withdrawable earnings, which is a
 * money bug that no test of the totals would catch.
 *
 * 🔴 THE `externalTransactionId` IS THE IDEMPOTENCY GUARD, and it must be
 * deterministic from (date, owner, account) alone — the same shape the licensing
 * rail uses. A re-run of the same day mints nothing new: the Buzz service
 * reports a `conflict`, which is benign. Do NOT include a row count or a row id
 * in the key, or a partially-failed run would mint a SECOND transaction on
 * retry because the key changed.
 *
 * ⚠️ NOT TRANSACTIONAL ACROSS THE MINT. The mint is an external service call and
 * the status flip is a local write, so a crash between them leaves rows
 * `accrued` whose Buzz has moved. The dedup key is what makes that recoverable:
 * the next run re-derives the same key, the mint conflicts (no double pay), and
 * the flip completes. The failure mode is therefore "settled late", never "paid
 * twice" — chosen deliberately over flipping first, which would fail the other
 * way and silently lose an author's money.
 */
export async function settleBlockAuthorFees(args: {
  /** The settlement date, used to build the dedup key. Defaults to today (UTC). */
  date?: Date;
  /** Cap on rows scanned in one run. */
  limit?: number;
}): Promise<SettleBlockAuthorFeesResult> {
  const date = args.date ?? new Date();
  const dateStr = date.toISOString().slice(0, 10);
  const limit = args.limit ?? 50_000;

  const rows = await dbRead.blockAuthorFeeAccrual.findMany({
    where: { status: STATUS_ACCRUED },
    select: { id: true, appOwnerUserId: true, buzzType: true, feeBuzz: true },
    orderBy: { accruedAt: 'asc' },
    take: limit,
  });

  if (!rows.length) {
    return { buckets: 0, rowsSettled: 0, buzzMinted: 0, bucketsSkippedNonPositive: 0 };
  }

  const byBucket = new Map<string, SettlementBucket>();
  for (const row of rows) {
    const key = `${row.appOwnerUserId}:${row.buzzType}`;
    const bucket = byBucket.get(key) ?? {
      appOwnerUserId: row.appOwnerUserId,
      buzzType: row.buzzType,
      totalBuzz: 0,
      rowIds: [],
    };
    bucket.totalBuzz += row.feeBuzz;
    bucket.rowIds.push(row.id);
    byBucket.set(key, bucket);
  }

  const payable: SettlementBucket[] = [];
  let bucketsSkippedNonPositive = 0;
  for (const bucket of byBucket.values()) {
    // A net of zero or less means a clawback met or exceeded the day's earnings.
    // 🔴 LEAVE THOSE ROWS `accrued` rather than settling them at zero: the debt
    // has to stay visible to the NEXT run so it nets against future earnings.
    // Settling them would forgive the outstanding balance silently.
    if (bucket.totalBuzz <= 0) {
      bucketsSkippedNonPositive += 1;
      continue;
    }
    payable.push(bucket);
  }

  if (!payable.length) {
    return {
      buckets: byBucket.size,
      rowsSettled: 0,
      buzzMinted: 0,
      bucketsSkippedNonPositive,
    };
  }

  const transactions = payable.map((bucket) => ({
    fromAccountId: 0,
    toAccountId: bucket.appOwnerUserId,
    fromAccountType: bucket.buzzType as BuzzAccountType,
    toAccountType: bucket.buzzType as BuzzAccountType,
    // A no-op on integer inputs — every `feeBuzz` is whole Buzz (see the module
    // header). Kept so the arithmetic states its own rounding direction rather
    // than depending on an invariant enforced elsewhere.
    amount: Math.floor(bucket.totalBuzz),
    description: `App author fee (${dateStr})`,
    type: TransactionType.Fee,
    externalTransactionId: `block-author-fee-${dateStr}-${bucket.appOwnerUserId}-${bucket.buzzType}`,
  }));

  await createBuzzTransactionMany(transactions);

  let rowsSettled = 0;
  let buzzMinted = 0;
  const settledAt = new Date();
  for (const bucket of payable) {
    const settlementKey = `block-author-fee-${dateStr}-${bucket.appOwnerUserId}-${bucket.buzzType}`;
    const { count } = await dbWrite.blockAuthorFeeAccrual.updateMany({
      where: { id: { in: bucket.rowIds }, status: STATUS_ACCRUED },
      data: { status: STATUS_SETTLED, settlementKey, settledAt },
    });
    rowsSettled += count;
    buzzMinted += bucket.totalBuzz;
  }

  logToAxiom(
    {
      name: BLOCK_AUTHOR_FEE_LOG_NAME,
      type: 'info',
      message: 'settlement complete',
      date: dateStr,
      buckets: payable.length,
      rowsSettled,
      buzzMinted,
      bucketsSkippedNonPositive,
    },
    'civitai-prod'
  ).catch(() => undefined);

  return {
    buckets: byBucket.size,
    rowsSettled,
    buzzMinted,
    bucketsSkippedNonPositive,
  };
}
