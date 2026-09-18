import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { isAppBlocksAuthorFeeEnabled } from '~/server/services/app-blocks-flag';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import {
  accrueBlockAuthorFee,
  resolveBlockAuthorFeePayee,
  BLOCK_AUTHOR_FEE_LOG_NAME,
  STATUS_ACCRUED,
} from './author-fee-accrual.service';
import { isSettlementEligible, settlementBoundary } from './author-fee-settlement.service';
import {
  computeBlockAuthorFee,
  BLOCK_AUTHOR_FEE_PRICE_IS_CAP,
  BLOCK_AUTHOR_FEE_BASE_UNAVAILABLE,
} from './author-fee';
import type { BlockAuthorFeeComputation, BlockAuthorFeeConfig } from './author-fee';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks PER-GENERATION AUTHOR FEE — slice 2b, THE VIEWER-CHARGE PATH.
//
// Slice 1 computed the fee and threw it away. Slice 2a (#4944) persisted the
// ACCRUAL LEDGER — and only that; the settlement rail ships in THIS change, in
// `author-fee-settlement.service.ts`, alongside the caller that gives it rows.
// This file is that caller: it prices the fee before the spend guardrails run,
// debits the viewer after the orchestrator has accepted the work, writes the
// accrual row, and reverses both when the generation does not survive.
//
// ── 🔴 THE FEE IS PRICED INTO THE RESERVATION, NEVER DEBITED OUTSIDE IT ──────
// This is the one safety property the design review found missing, and it is
// what the two-function split exists for. The submit order on every path is
//
//     whatIf quote  →  budget gate + reservations  →  submitWorkflow  →  charge
//
// If the fee were debited at the end without appearing at the start, it would
// escape EVERY guardrail those reservations implement: the token's per-call
// `buzzBudget`, the viewer's per-(user, UTC-day) platform cap, the viewer's OWN
// per-app CONSENT BUDGET, the per-app aggregate anti-Sybil cap and the
// dev-tunnel session backstop. A viewer who consented to spend N Buzz per day on
// an app would be charged N plus however much author fee the app's own
// configuration asked for — i.e. the consent budget would bound the part of the
// price the app does NOT control and leave the part it DOES control unbounded.
//
// So:
//   * `quoteBlockAuthorFee` runs against the WHATIF response, and the caller adds
//     its `feeBuzz` to the number every gate and every reservation is taken
//     against.
//   * `chargeBlockAuthorFee` runs against the REALIZED submit response, and takes
//     `reservedAuthorFeeBuzz` — what the quote actually got reserved — as a HARD
//     CEILING. `charged = min(reserved, realized)`.
//
// 🔴 THE CEILING IS WHAT MAKES THE PROPERTY STRUCTURAL RATHER THAN CONVENTIONAL.
// A submit path that reserves nothing passes 0 and can then charge nothing, no
// matter what the realized base says — so "did this path remember to price the
// fee in?" has a mechanical answer instead of resting on a reviewer noticing.
// Two of the four submit paths are in exactly that state on purpose; see
// `chargeBlockAuthorFee`.
//
// ── THE MONEY SHAPE ─────────────────────────────────────────────────────────
// Viewer → account 0 at submit (`TransactionType.Fee`), account 0 → author on the
// daily settlement run. The platform is a CONDUIT, not a party (D1): the author
// is credited exactly what the viewer was debited, and account 0 is a way-station
// rather than a share. A reversal is account 0 → viewer (`TransactionType.Refund`)
// and only ever for a row that has NOT settled.
//
// ── DARK ────────────────────────────────────────────────────────────────────
// `quoteBlockAuthorFee` reads `app-blocks-author-fee-enabled` FIRST and
// fail-closed. With the flag off it returns a non-charging quote before touching
// the database, so no fee is reserved, and a zero reservation then makes the
// charge structurally impossible. Merging this changes nothing until the flag is
// flipped.
// ─────────────────────────────────────────────────────────────────────────────

/** Why a quote or a charge did not produce money. */
export type BlockAuthorFeeSkip =
  | 'flag-disabled'
  | 'price-is-cap'
  | 'base-unavailable'
  | 'zero-fee'
  | 'self-dealing'
  | 'app-missing'
  | 'not-reserved'
  | 'debit-failed'
  | 'accrual-failed'
  | 'error';

export type BlockAuthorFeeQuote =
  | {
      charge: true;
      /** Whole Buzz to add to the reservation. Always > 0. */
      feeBuzz: number;
      appOwnerUserId: number;
      computation: BlockAuthorFeeComputation;
    }
  | { charge: false; reason: BlockAuthorFeeSkip };

/**
 * Price this generation's author fee BEFORE the spend guardrails run.
 *
 * Called with the WHATIF response's `cost.base` / `cost.variable`. The returned
 * `feeBuzz` is what the caller must add to the number it gates and reserves
 * against; it is also the ceiling `chargeBlockAuthorFee` will be held to.
 *
 * 🔴 THE FLAG IS READ FIRST, FAIL-CLOSED, AND BEFORE THE DATABASE. Every other
 * arm below either costs a query (`resolveBlockAuthorFeePayee`) or emits a
 * counter, and neither may happen on a generation the fee is not enabled for.
 *
 * 🔴 SELF-DEALING IS RESOLVED HERE, NOT ONLY AT ACCRUAL. Slice 2a's exclusion
 * lived inside the accrual writer, so a charge path that did not consult it would
 * debit an author for running their own app and then decline the accrual — the
 * viewer pays and nobody is owed. Resolving the payee at QUOTE time means a
 * self-dealing generation never even has a fee reserved, so the money is never
 * inside the reservation to be taken. `chargeBlockAuthorFee` re-resolves it
 * immediately before the debit as well, because the two calls are seconds apart
 * and an ownership transfer in between must land on the safe side.
 *
 * TOTAL AND NON-THROWING. This runs on the generation submit path, before the
 * orchestrator has been asked for anything. A flag-read failure, a database
 * failure or anything else degrades to "no fee", never to a failed generation.
 */
export async function quoteBlockAuthorFee(args: {
  /** 🔴 `WorkflowCost.base` from the WHATIF response. Never `.total`. */
  baseGenerationBuzz: number | null | undefined;
  /** `WorkflowCost.variable` — true when the quoted price is a CAP. */
  priceIsCap: boolean | null | undefined;
  generationType: unknown;
  appId: string;
  viewerUserId: number;
  /** Log-only; a whatIf has no workflow id, so callers pass a stable label. */
  workflowLabel: string;
  config?: BlockAuthorFeeConfig;
}): Promise<BlockAuthorFeeQuote> {
  try {
    if (!(await isAppBlocksAuthorFeeEnabled())) return { charge: false, reason: 'flag-disabled' };
  } catch {
    // A flag read that will not resolve is not permission to charge anyone.
    return { charge: false, reason: 'flag-disabled' };
  }

  try {
    // 🔴 A CAP-PRICED GENERATION IS NOT CHARGED, AND THE CHECK PRECEDES THE BASE.
    // `WorkflowCost.variable` means the quoted price is a ceiling the viewer is
    // billed up front and refunded down from. A percentage of it is a fee on money
    // they do not ultimately spend, and the flat leg is a toll on a job that may
    // have done almost nothing. Slice 1 recorded this as the current answer and
    // flagged the policy (charge on the settled cost / charge and refund pro rata /
    // charge nothing) as slice 2's to decide. THE DECISION IS: charge nothing. It
    // is the only one of the three that cannot take money the viewer gets back,
    // and the settled-cost variant needs a terminal-time charge path this slice
    // deliberately does not build.
    if (args.priceIsCap === true) return { charge: false, reason: BLOCK_AUTHOR_FEE_PRICE_IS_CAP };

    const base = args.baseGenerationBuzz;
    if (typeof base !== 'number' || !Number.isFinite(base)) {
      return { charge: false, reason: BLOCK_AUTHOR_FEE_BASE_UNAVAILABLE };
    }

    const computation = computeBlockAuthorFee({
      baseGenerationBuzz: base,
      generationType: args.generationType,
      config: args.config,
    });
    // A zero fee is the ABSENCE of a charge, not a charge of zero — the same rule
    // the accrual writer applies, for the same reason. Checked before the payee
    // lookup so a 0/0 generation type (`chat-completion`) costs no query.
    if (computation.feeBuzz <= 0) return { charge: false, reason: 'zero-fee' };

    const payee = await resolveBlockAuthorFeePayee({
      appId: args.appId,
      viewerUserId: args.viewerUserId,
      workflowId: args.workflowLabel,
    });
    if (!payee.payee) return { charge: false, reason: payee.reason };

    return {
      charge: true,
      feeBuzz: computation.feeBuzz,
      appOwnerUserId: payee.appOwnerUserId,
      computation,
    };
  } catch (error) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'fee quote failed — generation proceeds with no fee',
        appId: args.appId,
        workflowId: args.workflowLabel,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { charge: false, reason: 'error' };
  }
}

export type ChargeBlockAuthorFeeResult =
  | { charged: true; feeBuzz: number; accrualId: string | null }
  | { charged: false; reason: BlockAuthorFeeSkip };

/**
 * Debit the viewer the author fee for a generation the orchestrator has accepted,
 * and record the accrual that says who is owed it.
 *
 * 🔴 CALLED AFTER A RESOLVED SUBMIT, NEVER BEFORE. A fee taken for a generation
 * that then failed to submit is a charge for nothing; the orchestrator's own
 * response is the first moment the work is real.
 *
 * 🔴 `reservedAuthorFeeBuzz` IS A CEILING, NOT A HINT — AND 0 MEANS NEVER. It is
 * whatever `quoteBlockAuthorFee` returned to the caller and the caller then
 * folded into its budget gate and its reservations. `charged = min(reserved,
 * realized)`, so:
 *   * a path that priced no fee (0) can never take one, whatever the realized
 *     base says. TWO OF THE FOUR SUBMIT PATHS ARE DELIBERATELY IN THIS STATE:
 *     `submitCustomComfyWorkflow` takes no whatIf quote at all (its ceiling IS
 *     the app's declared `maxBuzz`) and `submitPassThroughStepWorkflow`'s quote
 *     helper returns a total only. Neither has a pre-submit `cost.base` to price
 *     a fee from, so neither reserves one, so neither charges one. They still
 *     call this function with 0 so the population of submit paths that route
 *     their fee through one place stays CLOSED and a future path that gains a
 *     base changes one argument rather than re-deriving the rule.
 *   * a realized base that moved UP between the whatIf and the submit charges the
 *     RESERVED amount, not the realized one. The viewer is never billed past what
 *     their consent budget was measured against.
 *
 * ⚠️ WHAT THE CLAMP DOES TO THE ROW, STATED BECAUSE IT IS NOT TIDY. The accrual
 * stores `fee_buzz` = the amount CHARGED, while `flat_leg_buzz` / `pct_leg_buzz` /
 * `governing_leg` describe the price that was COMPUTED. On a clamped charge those
 * disagree, and `feeBuzz === max(flatLeg, pctLeg)` — an invariant that holds
 * inside `computeBlockAuthorFee` — does NOT hold on the row. That is deliberate:
 * D1 says the author is credited exactly what the viewer was debited, and the
 * settlement rail pays `fee_buzz`, so `fee_buzz` must be the charged number. The
 * clamp is logged (`feeClampedToReserve`) so the disagreement is explainable
 * rather than mysterious. There is no column for it; adding one is a hand-applied
 * migration, which is an operator action.
 *
 * 🔴 RECONCILED BY COUNT, NOT BY ABSENCE OF A THROW. `createBuzzTransactionMany`
 * does NOT throw on a per-transaction failure: an `insufficientFunds` result is
 * dropped from BOTH the `transactions` and `conflicts` arrays, so the money did
 * not move and nothing says so. A viewer short of the fee is the ordinary case
 * here, not an exotic one — they just paid for a generation. So the accrual is
 * written only when `transactions.length + conflicts.length === 1`.
 *
 * 🔴 A LANDED DEBIT WITH A FAILED ACCRUAL IS REFUNDED, IMMEDIATELY — AND THAT
 * INCLUDES AN ACCRUAL THAT THREW. That pair means the viewer paid and nobody is
 * owed, i.e. the platform silently keeps the money — the one outcome D1 forbids
 * in both directions. The refund reuses the reversal key, so a later terminal
 * reversal of the same workflow conflicts instead of refunding twice.
 *
 * 🔴 THE THROWN ARM IS NOT HYPOTHETICAL, AND AN EARLIER REVISION LEFT IT OUTSIDE
 * EVERY `try`. `accrueBlockAuthorFee` calls `resolveBlockAuthorFeePayee`, whose
 * `dbRead.oauthClient.findUnique` is documented to PROPAGATE — deliberately, so a
 * charge path that cannot establish the payee does not proceed as though it had.
 * By the time it runs here the debit has already landed, so an escaping rejection
 * charged the viewer, wrote no accrual, issued no refund, and surfaced in the
 * router as a failed generation the viewer had nonetheless paid for. It is routed
 * into the same refund branch `accrual.reason === 'error'` takes.
 *
 * ⚠️ AND THE DIRECTION THIS PAIR OPENS, STATED BECAUSE THE REFUND DOES NOT CLOSE
 * IT. The refund goes out under the REVERSAL key while the debit stands under the
 * CHARGE key, so a re-submit of the SAME `workflowId` conflicts on the charge key
 * — which counts as `landed` by design — and can then accrue successfully. The
 * viewer is net square (debited once, refunded once, debited zero more times) but
 * an accrual now exists, and settling it pays the author out of platform funds.
 * Reaching it needs a retry under an identical orchestrator workflow id after an
 * accrual failure; it is not closed here because closing it means reading the
 * refund's own conflict state back, which the client does not report.
 *
 * TOTAL AND NON-THROWING, INCLUDING THE ACCRUAL. The submit has already succeeded
 * and its response is owed to the block; a fee failure must never turn a completed
 * generation into an error.
 */
export async function chargeBlockAuthorFee(args: {
  /** The orchestrator workflow id — the idempotency anchor for the whole fee. */
  workflowId: string;
  appId: string;
  appBlockId: string;
  viewerUserId: number;
  /** 🔴 D6 — the account the viewer's generation drained IS the fee's currency. */
  buzzType: BuzzAccountType;
  /** 🔴 `WorkflowCost.base` from the REALIZED submit response. Never `.total`. */
  baseGenerationBuzz: number | null | undefined;
  /** `WorkflowCost.variable` from the same response. */
  priceIsCap: boolean | null | undefined;
  generationType: string | null;
  /** 🔴 The quote this path actually reserved. A hard ceiling; 0 forbids a charge. */
  reservedAuthorFeeBuzz: number;
  config?: BlockAuthorFeeConfig;
}): Promise<ChargeBlockAuthorFeeResult> {
  const { workflowId, appId, appBlockId, viewerUserId, buzzType } = args;

  // THE STRUCTURAL BOUND, AND IT IS FIRST. Nothing below — not the flag read, not
  // the payee query, not the debit — may run for a path that reserved no fee.
  const reserved = args.reservedAuthorFeeBuzz;
  if (!(typeof reserved === 'number' && Number.isFinite(reserved) && reserved > 0)) {
    return { charged: false, reason: 'not-reserved' };
  }

  // Re-price against the REALIZED base and re-resolve the payee. This is where
  // the self-dealing exclusion is read BEFORE the debit: `quoteBlockAuthorFee`
  // returns `self-dealing` without a fee, and this function returns before it
  // moves any money.
  const quote = await quoteBlockAuthorFee({
    baseGenerationBuzz: args.baseGenerationBuzz,
    priceIsCap: args.priceIsCap,
    generationType: args.generationType,
    appId,
    viewerUserId,
    workflowLabel: workflowId,
    config: args.config,
  });
  if (!quote.charge) return { charged: false, reason: quote.reason };

  const feeBuzz = Math.min(reserved, quote.feeBuzz);
  if (feeBuzz <= 0) return { charged: false, reason: 'zero-fee' };

  let landed = false;
  try {
    const result = await createBuzzTransactionMany([
      {
        fromAccountId: viewerUserId,
        toAccountId: 0,
        fromAccountType: buzzType,
        toAccountType: buzzType,
        amount: feeBuzz,
        description: 'App author fee',
        type: TransactionType.Fee,
        externalTransactionId: blockAuthorFeeChargeKey(workflowId),
      },
    ]);
    // A CONFLICT is the idempotency guard — this workflow's fee already moved —
    // and counts as landed, because the money is where it should be. A DROP
    // (neither array) is a failure the client reports no other way.
    landed = (result?.transactions?.length ?? 0) + (result?.conflicts?.length ?? 0) > 0;
  } catch (error) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'fee debit threw — no fee charged',
        workflowId,
        appId,
        viewerUserId,
        feeBuzz,
        // `mapError` names 400/404/409 explicitly; 401, 403, 408, 429 and every
        // 5xx collapse into one fixed string, so the status is the only thing
        // that separates a permanent auth failure from a transient outage.
        threwStatus: getBuzzApiStatus(error) ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { charged: false, reason: 'debit-failed' };
  }

  if (!landed) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'warning',
        message: 'fee debit did not land — no fee charged',
        workflowId,
        appId,
        viewerUserId,
        buzzType,
        feeBuzz,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { charged: false, reason: 'debit-failed' };
  }

  if (feeBuzz !== quote.feeBuzz) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'warning',
        message: 'fee clamped to the reserved amount',
        workflowId,
        appId,
        feeClampedToReserve: true,
        reservedBuzz: reserved,
        realizedBuzz: quote.feeBuzz,
        chargedBuzz: feeBuzz,
      },
      'civitai-prod'
    ).catch(() => undefined);
  }

  // 🔴 WRAPPED, AND THE DEBIT ABOVE IS WHY. `accrueBlockAuthorFee` re-resolves
  // the payee through a read that PROPAGATES on a database failure (its own
  // docblock says so), and every statement from here down runs with the viewer's
  // money already taken. An unwrapped rejection therefore escapes to the router
  // with the viewer charged, no accrual row and no refund. A throw is treated
  // exactly like `reason: 'error'` — the refund branch below — because it
  // describes the same state.
  let accrual: Awaited<ReturnType<typeof accrueBlockAuthorFee>>;
  try {
    accrual = await accrueBlockAuthorFee({
      workflowId,
      appId,
      appBlockId,
      viewerUserId,
      buzzType,
      // 🔴 THE CHARGED AMOUNT, not the computed one — see the clamp note above.
      computation: { ...quote.computation, feeBuzz },
      generationType: args.generationType,
    });
  } catch (error) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'accrual threw after the debit landed — refunding the viewer',
        workflowId,
        appId,
        viewerUserId,
        feeBuzz,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    await refundBlockAuthorFee({ workflowId, viewerUserId, buzzType, feeBuzz });
    return { charged: false, reason: 'accrual-failed' };
  }

  if (accrual.accrued) return { charged: true, feeBuzz, accrualId: accrual.id };

  // A DUPLICATE means a prior attempt already wrote this workflow's row, which is
  // the same state a conflict on the debit describes: the fee is charged and the
  // author is owed. Nothing to undo.
  if (accrual.reason === 'duplicate') return { charged: true, feeBuzz, accrualId: null };

  // Everything else: the viewer was debited and no row says who is owed it. Give
  // the money back rather than let the platform keep it.
  logToAxiom(
    {
      name: BLOCK_AUTHOR_FEE_LOG_NAME,
      type: 'error',
      message: 'fee debited but accrual failed — refunding the viewer',
      workflowId,
      appId,
      viewerUserId,
      feeBuzz,
      accrualReason: accrual.reason,
    },
    'civitai-prod'
  ).catch(() => undefined);
  await refundBlockAuthorFee({ workflowId, viewerUserId, buzzType, feeBuzz });
  return { charged: false, reason: 'accrual-failed' };
}

/**
 * What a reversal attempt did.
 *
 * ⚠️ `no-accrual` COVERS TWO STATES, deliberately not separated: the workflow
 * never accrued a fee at all, and the boundary-guarded `deleteMany` matched
 * nothing because a concurrent observer claimed the row first. Neither leaves
 * money to recover and neither is actionable differently, so splitting them
 * would put a distinction in the public result that no caller can use.
 */
export type ReverseBlockAuthorFeeResult =
  | { reversed: true; feeBuzz: number }
  | {
      reversed: false;
      reason:
        | 'no-accrual'
        /**
         * The row's `status` column reads `settled` — the flip confirmed.
         *
         * 🔴 UNREACHABLE IN PRODUCTION AS THE TWO GUARDS ARE ORDERED TODAY, AND
         * AN OPERATOR ALERTING ON ITS LOG LINE (`fee already settled — not
         * reversed`) WOULD GET PERMANENT SILENCE. The eligibility guard runs
         * FIRST, and the only writer of `status = 'settled'` is the settlement
         * flip, which can only touch rows it scanned — rows with
         * `accruedAt < utcDayStart(runClock)`, i.e. exactly the rows the
         * eligibility guard has already refused. Reaching this arm therefore
         * needs the settling app's clock to sit a whole UTC day ahead of the
         * reversing app's (app-clock skew across midnight), or a manual
         * `settleBlockAuthorFees({ date })` run with a date AHEAD of the
         * reverser's clock — the precondition recorded on `settlementBoundary`.
         * Kept as a second layer whose ordering-independence is pinned by test,
         * not as an ordinary operational distinction.
         */
        | 'already-settled'
        /**
         * 🔴 The row's accrual day is COMPLETE, so a mint may already have landed
         * for it whatever its status says. Counted separately from
         * `already-settled` on purpose: that one is "the flip confirmed", this one
         * is "the flip is not evidence either way".
         */
        | 'settlement-eligible'
        | 'refund-failed';
    };

/**
 * Give an author fee back when the generation it was charged for did not survive.
 *
 * 🔴 THE FEE FOLLOWS THE GENERATION. The orchestrator refunds a workflow that
 * failed, expired or was cancelled — in full when it delivered nothing, prorated
 * by undelivered output blobs otherwise. An author fee left standing on such a
 * workflow would charge the viewer for an app's contribution to work they did not
 * receive, and would pay the author out of it on the next settlement run.
 *
 * 🔴 THE DELETE IS THE LOCK. `pollWorkflow` reaches a terminal status on every
 * subsequent poll, and both cancel procedures (`cancelWorkflow` and
 * `cancelAppWorkflow`) can run alongside it, so this is called repeatedly and
 * concurrently for one workflow. The `deleteMany` is guarded on `status =
 * 'accrued'` AND on the mint-eligibility boundary below, so exactly one caller can
 * ever see `count === 1`, and only that caller issues the refund. The refund's
 * `externalTransactionId` is a second layer, not the first.
 *
 * 🔴 A ROW WHOSE ACCRUAL DAY IS COMPLETE IS NOT REVERSED, AND THE GUARD IS THE
 * DAY — NOT THE `status` WORD. Taking back money already minted to the author is a
 * CLAWBACK, which slice 2a retired deliberately and which needs a negative-row
 * shape the `fee_buzz > 0` CHECK forbids. But `status` cannot decide it: the
 * settlement rail MINTS at its `createBuzzTransactionMany` and only flips the
 * status at the `updateMany` after it, so between those two statements the money
 * is the author's while the row still reads `accrued`.
 *
 * ⚠️ AND THE REACHABLE ARM IS NOT THAT RACE. When the flip throws, settlement
 * increments `flipFailures` and leaves the rows `accrued` UNTIL THE NEXT NIGHTLY
 * RUN — so a status-only guard would let every reversal in that ~24h window refund
 * a viewer for a fee the author had already been minted, with the platform funding
 * the gap. D1 forbids exactly that.
 *
 * So the refusal is `isSettlementEligible(row.accruedAt, now)`: the rail only ever
 * scans rows accrued STRICTLY BEFORE midnight UTC of its own run day, so a row
 * accrued in the CURRENT UTC day is invisible to every settlement run and no mint
 * can have been attempted for it. That is a structural property of the row, taken
 * from the settlement rail's own boundary function rather than re-spelled here.
 * `status !== 'accrued'` is kept as a second layer, not the first.
 *
 * ⚠️ IT IS DELIBERATELY CONSERVATIVE, AND THAT COSTS SOMETHING. A row accrued at
 * 23:59 UTC whose workflow terminates at 00:01 is refused even though nothing has
 * minted: the viewer stays charged for a generation the orchestrator refunded.
 * That is the direction that cannot double-pay, and it is the only one available
 * without a claim COLUMN the reversal can read — the obvious candidate,
 * `settlement_key`, is forbidden on an unsettled row by
 * `block_author_fee_accrual_settled_key_check`, so a pre-mint claim needs a schema
 * change and every migration here is hand-applied per environment.
 *
 * ⚠️ REQUIREMENT 4 IS THEREFORE TIME-BOUNDED, AND NOTHING ELSE SAYS SO. A fee
 * accrued on day D stops being reversible at **00:00 UTC on D+1** — the instant
 * the row's accrual day completes. NOT when the settlement job runs: that job's
 * 02:30 UTC schedule is irrelevant to this guard, which is
 * `accruedAt < utcDayStart(now)` and flips at midnight whether or not any run has
 * happened or minted anything. Worked case: a fee accrued `2026-09-18T14:00Z`
 * whose workflow is polled `failed` at `2026-09-19T01:00Z` is REFUSED — the job
 * has not run, nothing has minted, and the fee is still not reversible. A
 * workflow that reaches a terminal state on the UTC day it ran is always still
 * reversible, which is the overwhelming majority.
 *
 * ⚠️ WHAT THE BOUNDARY DOES NOT ELIMINATE: both sides read their own clock, so a
 * reversal evaluating just before midnight and a settlement run starting just
 * after it are separated by skew rather than by a lock. Seconds at one instant a
 * day, against the ~24h window it replaces.
 *
 * ⚠️ WHAT THIS DOES NOT COVER, SO IT IS NOT MISTAKEN FOR COVERAGE: a SUCCEEDED
 * workflow that the orchestrator prorates for partially-undelivered output. Its
 * terminal status is `succeeded`, nothing on this path observes the proration,
 * and the fee stays at full. Charging pro rata would need the settled cost at
 * terminal time, which this slice has no path to read.
 *
 * TOTAL AND NON-THROWING — it runs off a poll whose contract is to return a
 * snapshot.
 */
export async function reverseBlockAuthorFee(args: {
  workflowId: string;
  /** The terminal status that drove the reversal. Log-only. */
  terminalStatus: string;
  /** Injectable clock, so the mint-eligibility boundary is testable. */
  now?: Date;
}): Promise<ReverseBlockAuthorFeeResult> {
  const { workflowId, terminalStatus } = args;
  // 🔴 READ ONCE, USED BY BOTH THE CHECK AND THE CLAIM. Recomputing it at the
  // `deleteMany` would let the boundary move between the two statements, which is
  // the whole class of defect this guard exists to close.
  const now = args.now ?? new Date();
  try {
    const row = await dbWrite.blockAuthorFeeAccrual.findUnique({
      where: { workflowId },
      select: {
        id: true,
        status: true,
        viewerUserId: true,
        buzzType: true,
        feeBuzz: true,
        accruedAt: true,
      },
    });
    if (!row) return { reversed: false, reason: 'no-accrual' };
    // 🔴 THE STRUCTURAL GUARD, AND IT PRECEDES THE STATUS ONE. A complete accrual
    // day means the settlement rail may already have minted this row's bucket,
    // whether or not the flip that records it has run. See the docblock.
    if (isSettlementEligible(row.accruedAt, now)) {
      logToAxiom(
        {
          name: BLOCK_AUTHOR_FEE_LOG_NAME,
          type: 'warning',
          message: 'fee accrual day is settleable — not reversed',
          workflowId,
          terminalStatus,
          feeBuzz: row.feeBuzz,
          viewerUserId: row.viewerUserId,
          // The distinguishing pair an operator needs to tell "already minted"
          // from "refused conservatively": the row still reads `accrued` in the
          // second case.
          rowStatus: row.status,
          // No `instanceof Date` defence: `isSettlementEligible` on the line above
          // already called `.getTime()` on this value unguarded, so a non-`Date`
          // would have thrown into the catch before reaching here.
          accruedAt: row.accruedAt.toISOString(),
        },
        'civitai-prod'
      ).catch(() => undefined);
      return { reversed: false, reason: 'settlement-eligible' };
    }
    if (row.status !== STATUS_ACCRUED) {
      logToAxiom(
        {
          name: BLOCK_AUTHOR_FEE_LOG_NAME,
          type: 'warning',
          message: 'fee already settled — not reversed',
          workflowId,
          terminalStatus,
          feeBuzz: row.feeBuzz,
          viewerUserId: row.viewerUserId,
        },
        'civitai-prod'
      ).catch(() => undefined);
      return { reversed: false, reason: 'already-settled' };
    }

    // The atomic claim, and the two clauses are NOT doing the same work.
    //
    // `status` closes a REAL race: a concurrent settlement flip (or a concurrent
    // observer's own delete) can move it between the read above and this
    // statement, so re-asserting it here is what makes exactly one caller see
    // `count === 1` and issue the refund.
    //
    // ⚠️ `accruedAt` IS BELT-AND-BRACES, NOT A SECOND RACE CLOSED — AN EARLIER
    // COMMENT HERE SAID IT WAS RE-ASSERTED "for the same reason `status` is", AND
    // THAT WAS FALSE. `now` is frozen above, and `accrued_at` is written once by
    // the column default and never updated by any writer, so
    // `accruedAt < settlementBoundary(now)` evaluates identically at the check and
    // at this claim: the clause cannot change any outcome reachable from here.
    // What makes the row safe is the CHECK above — a row whose accrual day is
    // still open is invisible to every settlement scan, so no mint can have been
    // attempted for it. The clause is kept because it costs nothing and carries
    // the structural property into the statement that acts on it, which is what a
    // future caller recomputing the clock would need.
    const { count } = await dbWrite.blockAuthorFeeAccrual.deleteMany({
      where: {
        workflowId,
        status: STATUS_ACCRUED,
        // 🔴 Only a row whose accrual day is still OPEN may be claimed — no
        // settlement run can have minted it. Same boundary the rail scans on.
        accruedAt: { gte: settlementBoundary(now) },
      },
    });
    // ⚠️ `no-accrual` HERE MEANS "THE CLAIM LOST", NOT "THERE WAS NO ROW" — the
    // row was read moments ago. It shares the reason with the genuine
    // never-accrued case on purpose (see the type): both leave nothing to recover
    // and neither is actionable differently, and adding a third reason would put a
    // distinction in the public result that no caller can act on.
    if (count < 1) return { reversed: false, reason: 'no-accrual' };

    const refunded = await refundBlockAuthorFee({
      workflowId,
      viewerUserId: row.viewerUserId,
      buzzType: row.buzzType as BuzzAccountType,
      feeBuzz: row.feeBuzz,
    });
    if (!refunded) return { reversed: false, reason: 'refund-failed' };

    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'info',
        message: 'fee reversed',
        workflowId,
        terminalStatus,
        viewerUserId: row.viewerUserId,
        buzzType: row.buzzType,
        feeBuzz: row.feeBuzz,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { reversed: true, feeBuzz: row.feeBuzz };
  } catch (error) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'fee reversal failed',
        workflowId,
        terminalStatus,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { reversed: false, reason: 'refund-failed' };
  }
}

/**
 * Return one workflow's fee to the viewer. Reconciled BY COUNT for the same
 * reason the debit is — a dropped refund is invisible in the return value.
 *
 * ⚠️ THE ROW IS ALREADY GONE WHEN THIS RUNS, on the reversal path. A refund that
 * does not land therefore leaves the viewer charged with no row to retry from,
 * which is why it is logged at `error` with the amount and the account: that log
 * line is the only recovery handle. The alternative ordering — refund, then
 * delete — trades it for the worse failure, a refunded viewer whose row settles
 * and pays the author out of platform funds.
 */
async function refundBlockAuthorFee(args: {
  workflowId: string;
  viewerUserId: number;
  buzzType: BuzzAccountType;
  feeBuzz: number;
}): Promise<boolean> {
  const { workflowId, viewerUserId, buzzType, feeBuzz } = args;
  try {
    const result = await createBuzzTransactionMany([
      {
        fromAccountId: 0,
        toAccountId: viewerUserId,
        fromAccountType: buzzType,
        toAccountType: buzzType,
        amount: feeBuzz,
        description: 'App author fee refund',
        type: TransactionType.Refund,
        externalTransactionId: blockAuthorFeeReversalKey(workflowId),
      },
    ]);
    const landed = (result?.transactions?.length ?? 0) + (result?.conflicts?.length ?? 0) > 0;
    if (landed) return true;
  } catch (error) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'fee refund threw — viewer is still charged',
        workflowId,
        viewerUserId,
        buzzType,
        feeBuzz,
        threwStatus: getBuzzApiStatus(error) ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return false;
  }

  logToAxiom(
    {
      name: BLOCK_AUTHOR_FEE_LOG_NAME,
      type: 'error',
      message: 'fee refund did not land — viewer is still charged',
      workflowId,
      viewerUserId,
      buzzType,
      feeBuzz,
    },
    'civitai-prod'
  ).catch(() => undefined);
  return false;
}

/**
 * The viewer-debit idempotency key. ONE spelling, workflow-derived, so
 * `submitWorkflow`'s own internal retry and a client resubmit under the same
 * orchestrator `externalId` collapse onto one charge.
 *
 * 🔴 THE PREFIX IS DISTINCT FROM THE SETTLEMENT KEY'S ON PURPOSE. Settlement
 * builds `block-author-fee-<day>-<owner>-<currency>`; a bare `block-author-fee-`
 * prefix here would put a workflow id and a settlement tuple in one namespace,
 * where a collision moves money to the wrong side of the ledger.
 */
export function blockAuthorFeeChargeKey(workflowId: string): string {
  return `block-author-fee-charge-${workflowId}`;
}

/** The reversal key. Shared by the accrual-failure refund and the terminal reversal. */
export function blockAuthorFeeReversalKey(workflowId: string): string {
  return `block-author-fee-reversal-${workflowId}`;
}
