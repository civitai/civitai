import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { newBlockAuthorFeeAccrualId } from '~/server/utils/app-block-ids';
import type { BlockAuthorFeeComputation } from './author-fee';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks PER-GENERATION AUTHOR FEE — slice 2a, the ACCRUAL LEDGER ONLY.
//
// SLICE 1 (#4922) computed the fee and threw it away. This slice persists it.
// 🔴 IT DOES NOT PAY ANYONE — this module writes ledger rows and nothing else.
// The name of this file is the whole claim it makes: accrual.
//
// ── TWO HOPS, MIRRORING THE MODEL LICENSING FEE — THIS FILE IS HOP 1 ───────
//   1. AT SUBMIT the viewer is debited the fee, and one `accrued` row is written
//      naming the app owner it is owed to. That debit is the CALLER's job — this
//      module only records it. The caller is `chargeBlockAuthorFee` in
//      `author-fee-charge.service.ts` (slice 2b), which debits the viewer and
//      then awaits this function; it is the only production caller.
//   2. DAILY the accrued rows are summed per (owner × buzz type × accrual day)
//      and minted to the owner — `settleBlockAuthorFees` in
//      `author-fee-settlement.service.ts`, driven by the
//      `settle-block-author-fees` job.
//
// 🔴 BOTH HOPS ARE STILL DARK, AND THE ACCURATE FORM OF THE CLAIM IS NARROWER
// THAN "EVERY MONEY-MOVING ENTRY POINT" — AN EARLIER REVISION SAID THAT AND IT IS
// FALSE. Every entry point that can CREATE AN OBLIGATION is behind
// `app-blocks-author-fee-enabled`, which is `enabled: false`: the charge path
// reads that flag before it prices anything, so with the flag off no fee is
// quoted, no fee is reserved, no viewer is debited and this table stays empty —
// which is also why the settlement rail has nothing to settle.
//
// `reverseBlockAuthorFee` DOES move money — it refunds the viewer through
// `createBuzzTransactionMany` — and reads NO flag, so it is not an exception to
// the narrower claim by accident; it is outside it deliberately. 🔴 GATING IT
// WOULD STRAND REFUNDS for every accrual already written the moment the flag were
// turned off, which is exactly when a reversal matters most: a gate that can only
// ever KEEP money the viewer is owed is the wrong direction. The flag exists to
// stop a fee being CREATED, not to stop one being given back.
//
// Its cost with the flag off is one `dbWrite` `findUnique` per terminal
// observation that is NOT `succeeded` — all three observers gate on
// `TERMINAL_BLOCK_WORKFLOW_STATUSES.has(status) && status !== 'succeeded'`, so
// the ordinary completing generation never reaches it, and the two cancel paths
// carry that same compound guard rather than calling unconditionally.
// Behaviourally inert today (the table is empty, so it returns `no-accrual` and
// moves nothing), but it is a real query on a real path and the claim has to say
// so.
//
// The two-hop shape is exactly what `deliver-creator-compensation` does for the
// model licensing fee: the orchestrator charges the viewer at generation time,
// writes a per-resource fee row, and a daily job mints to the creator. Same two
// hops, same `externalTransactionId` dedup discipline, in a civitai-owned table
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
// day instead of one per generation), not for rounding. (An earlier revision
// carried a defensive `Math.floor` here and a sentence explaining it; the floor
// was removed and the sentence outlived it by one commit. `fee_buzz` is an
// INTEGER column, so there is nothing to round.)
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
 * annotated with this type. An earlier revision exported this and then wrote
 * bare string literals everywhere, so it was not referenced even inside this
 * file and a typo'd `'setled'` would have compiled and silently matched nothing.
 *
 * 🔴 THERE IS NO `clawed_back` STATE AND NO `entry_type` AXIS, AND SLICE 2b DID
 * NOT ADD ONE — an earlier revision of this comment predicted it would. The
 * reversal path (`reverseBlockAuthorFee`) DELETES an unsettled row instead of
 * marking it, for two reasons: the `status` column carries a CHECK constrained to
 * exactly `('accrued','settled')` and every migration on this database is applied
 * BY HAND per environment, so a third state is an operator action, not a code
 * change; and a DELETE guarded on `status = 'accrued'` is the atomic claim that
 * makes the reversal idempotent under concurrent terminal observations — exactly
 * one caller can delete a row, so exactly one can refund.
 *
 * ⚠️ THE CONSEQUENCE, STATED RATHER THAN HIDDEN: a reversed generation leaves NO
 * row behind, so this table cannot answer "how many fees were reversed". That
 * number lives only in the `block-author-fee` Axiom stream
 * (`message: 'fee reversed'`). A SETTLED row is never reversed and never deleted
 * — see `reverseBlockAuthorFee`.
 */
export type BlockAuthorFeeAccrualStatus = 'accrued' | 'settled';

export const STATUS_ACCRUED: BlockAuthorFeeAccrualStatus = 'accrued';
/**
 * ⚠️ NOTHING IN THIS MODULE EVER WRITES OR READS THIS VALUE. It is exported
 * because the `status` column it names is a CHECK-constrained two-state enum, and
 * its writer is `settleBlockAuthorFees`. Declaring it here keeps ONE spelling of
 * the literal across the accrual, settlement and reversal paths — the alternative
 * is each re-declaring `'settled'`, and a typo there matches no row and fails
 * silently.
 */
export const STATUS_SETTLED: BlockAuthorFeeAccrualStatus = 'settled';

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

/** Who this app's fee is owed to, or why nobody is. */
export type BlockAuthorFeePayee =
  | { payee: true; appOwnerUserId: number }
  | { payee: false; reason: 'app-missing' | 'self-dealing' };

/**
 * Resolve the app owner a fee is owed to, and refuse when that owner IS the
 * viewer.
 *
 * 🔴 THIS IS THE ONE SPELLING OF THE SELF-DEALING EXCLUSION, AND EXTRACTING IT
 * IS THE WHOLE POINT. Slice 2a implemented the check inside the accrual writer
 * and said so in a comment addressed to slice 2b: *"today a self-dealing viewer
 * would still be DEBITED by a charge path that does not consult this, and only
 * the accrual would be skipped. Slice 2b must call this predicate BEFORE the
 * debit, or extract it."* This is that extraction. `chargeBlockAuthorFee` calls
 * it before it moves any money, and `accrueBlockAuthorFee` still calls it on the
 * write side — one function, two callers, so the two can no longer disagree.
 *
 * ⚠️ THE ACCRUAL-SIDE CALL IS NOT REDUNDANT AND MUST NOT BE DELETED AS SUCH.
 * `accrueBlockAuthorFee` is exported and its contract is "record that a debit
 * happened"; a future caller that is not `chargeBlockAuthorFee` would otherwise
 * write a self-dealing row. It is defence in depth against a CALLER, not against
 * this function.
 *
 * 🔴 WHY THE OWNER IS RESOLVED HERE RATHER THAN IN THE CHARGE SERVICE. The
 * ownership-gate ledger (`app-access.call-site-ledger.test.ts`) enumerates every
 * production file that reads an app's owner and fails on GROWTH. Keeping the read
 * in this already-enumerated file keeps that population closed; a second copy in
 * a new file would be a new gate site AND a second spelling of the exclusion.
 *
 * Total and non-throwing on the exclusion arms; a database error propagates,
 * because a charge path that cannot establish the payee must not proceed to a
 * debit as though it had.
 */
export async function resolveBlockAuthorFeePayee(args: {
  appId: string;
  viewerUserId: number;
  /** Carried onto the log lines only, so a skip is traceable to a generation. */
  workflowId: string;
}): Promise<BlockAuthorFeePayee> {
  const { appId, viewerUserId, workflowId } = args;

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
    return { payee: false, reason: 'app-missing' };
  }

  // 🔴 SELF-DEALING EXCLUSION (operator, 2026-09-18). An author running their own
  // app would otherwise pay themself, which is a round trip that inflates every
  // earnings number while moving no real money — and is the cheapest possible
  // way to fake traction on an app.
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
    return { payee: false, reason: 'self-dealing' };
  }

  return { payee: true, appOwnerUserId: app.userId };
}

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

  // 🔴 THE SELF-DEALING EXCLUSION AND THE OWNER SNAPSHOT ARE ONE SHARED
  // PREDICATE — see `resolveBlockAuthorFeePayee`. Slice 2a implemented it inline
  // here and recorded that a charge path would have to call it BEFORE the debit
  // or extract it. It is extracted, and `chargeBlockAuthorFee` calls it before it
  // takes any money; this call is the write-side belt for any OTHER caller of
  // this exported function, not a second copy of the rule.
  const payee = await resolveBlockAuthorFeePayee({ appId, viewerUserId, workflowId });
  if (!payee.payee) return { accrued: false, reason: payee.reason };

  const id = newBlockAuthorFeeAccrualId();

  try {
    await dbWrite.blockAuthorFeeAccrual.create({
      data: {
        id,
        workflowId,
        appId,
        appBlockId,
        appOwnerUserId: payee.appOwnerUserId,
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
    // The unique index on workflow_id is the idempotency guard: a
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
