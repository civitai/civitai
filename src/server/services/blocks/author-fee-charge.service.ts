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
import { blockAuthorFeeChargedCounter, blockAuthorFeeQuotedCounter } from '~/server/prom/client';

import {
  computeBlockAuthorFee,
  BLOCK_AUTHOR_FEE_PRICE_IS_CAP,
  BLOCK_AUTHOR_FEE_BASE_UNAVAILABLE,
  BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL,
} from './author-fee';
import type { BlockAuthorFeeComputation, BlockAuthorFeeConfig } from './author-fee';
import { blockGenerationCoarseType } from './generation-type';

/**
 * The `workflowLabel` both ESTIMATE call sites pass; the two gating sites pass
 * the block's external id instead. It is what `surface` on
 * `blockAuthorFeeQuotedCounter` is derived from.
 *
 * 🔴 BOTH ESTIMATE SITES IMPORT THIS, AND THAT IMPORT IS THE ONLY THING HOLDING
 * THE LABEL TOGETHER. An earlier revision left them spelling `'estimate'` and
 * claimed the pairing was "pinned behaviourally by
 * `blocks.router.workflow.test.ts`". It was not: that file never mentions
 * `workflowLabel`, and a round-1 audit proved the gap by mutation — rewriting
 * both router literals to `'whatif'` left 482/482 tests green while the entire
 * unbounded estimate population silently moved onto the `gating` series. A
 * shared import cannot drift that way; a sentence about a test can.
 *
 * The GATING side needs no equivalent: both gating sites pass
 * `blockExternalId`, which `composeBlockExternalId` /
 * `mintServerBlockExternalId` always prefix with `blk`/`bls`, so a gating caller
 * cannot produce this value by construction.
 *
 * ⚠️ Deliberately NOT `as const`: `workflowLabel` is a plain `string` on both
 * signatures, so widening buys nothing and a literal type would only make a
 * future non-estimate caller's error message harder to read.
 */
export const BLOCK_AUTHOR_FEE_ESTIMATE_LABEL = 'estimate';

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
  /**
   * 🔴 NOT LOG-ONLY — AND IT SAID SO UNTIL A ROUND-2 AUDIT. This string has three
   * readers: the log lines, the payee resolver (as `workflowId`), and — since the
   * quote counter shipped — the `surface` LABEL on
   * `block_author_fee_quoted_total`, which is derived from whether it equals
   * `BLOCK_AUTHOR_FEE_ESTIMATE_LABEL`.
   *
   * So do NOT re-spell it for log readability: an estimate caller that stops
   * passing the estimate label moves its whole population onto the `gating`
   * series. A whatIf has no workflow id, which is why callers pass a stable
   * label at all; both estimate sites import the constant rather than spelling
   * it, and both are pinned in `blocks.router.workflow.test.ts`.
   */
  workflowLabel: string;
  /**
   * DISCLOSURE-ONLY caller: the result is shown to a viewer and then discarded,
   * never gated, reserved or charged against.
   *
   * 🔴 IT CHANGES NO PRICING, AND THAT IS THE POINT — every arm below runs
   * identically, and the value RETURNED is byte-for-byte what an unflagged call
   * returns. A variant that changed the return would re-create estimate/submit
   * divergence one layer down, which is the exact defect the disclosure exists to
   * remove; the flag is named for what it does so it cannot be mistaken for one.
   *
   * WHAT IT SUPPRESSES: every per-call log write on this quote path — the two
   * SKIP lines inside `resolveBlockAuthorFeePayee`, and this function's OWN
   * `catch` below. The estimate path is unbounded (per parameter change, no rate
   * limit, no idempotency key) while a submit is once per real generation, so a
   * write here is multiplied by an unknown factor and a write there is not.
   *
   * 🔴 THE `catch` IS THE ARM THAT MATTERS MOST, AND IT WAS LEFT OUT OF THE FIRST
   * VERSION OF THIS FLAG — named `suppressSkipLogs`, which is why it reached only
   * the skips. It is the arm reached when `resolveBlockAuthorFeePayee`'s
   * `dbRead.oauthClient.findUnique` THROWS — a replica failure, pool exhaustion,
   * a statement timeout — which that function deliberately propagates. So its
   * firing rate is a function of how broken the database is, and before this
   * change it put an unconditional `console.error` (a SYNCHRONOUS write when
   * stderr is a pipe, which it is in a container) plus an HTTP ingest on an
   * unbounded surface, at exactly the moment a pod can least afford either.
   *
   * Nothing diagnostic is lost. Both estimate arms quote the SAME row through the
   * SAME query as the submit, so any failure visible here is visible there too —
   * where it is logged unsuppressed, once per real generation, which is the
   * better signal anyway because it cannot be drowned by estimate volume.
   */
  suppressQuoteLogs?: boolean;
  config?: BlockAuthorFeeConfig;
}): Promise<BlockAuthorFeeQuote> {
  const quote = await quoteBlockAuthorFeeUncounted(args);
  // 🔴 ONE INSTRUMENTATION POINT, ON PURPOSE — the function below has SEVEN
  // return arms, and a counter repeated at each of them is a seven-site ledger
  // that will be right at six of them. Counting the RESULT instead makes an
  // uncounted arm structurally impossible, including one added later.
  //
  // 🔴 `surface` IS DERIVED FROM `workflowLabel`, NOT FROM `suppressQuoteLogs`,
  // AND AN EARLIER REVISION OF THIS LINE GOT IT WRONG IN A WAY THE TESTS COULD
  // NOT SEE. `suppressQuoteLogs` is set at ONE of the two estimate call sites
  // (the `kind:'step'` estimate) and NOT at the other (the workflow estimate), so deriving from it
  // reported a genuine estimate as `gating`. The tests passed because they
  // asserted the label against the flag the test itself passed — the
  // expectation was taken from the implementation rather than from the router.
  // `workflowLabel` is `'estimate'` at both estimate sites and the external id at
  // both gating sites (the two submits), so it discriminates all four.
  //
  // ⚠️ THAT MAKES THE LABEL A CLAIM ABOUT A STRING THE ROUTER PASSES, AND THE
  // ONLY THING ENFORCING IT IS THAT BOTH ESTIMATE SITES NOW IMPORT
  // `BLOCK_AUTHOR_FEE_ESTIMATE_LABEL` RATHER THAN SPELLING `'estimate'`.
  //
  // 🔴 AN EARLIER REVISION OF THIS COMMENT CLAIMED IT WAS "pinned behaviourally
  // by `blocks.router.workflow.test.ts`, which drives the real router". THAT WAS
  // FALSE, and a round-1 audit proved it by mutation: changing both router
  // literals to `'whatif'` left 482/482 tests green. That file contains no
  // reference to `workflowLabel` at all. A guard a comment CLAIMS and the tree
  // does not have is worse than no guard, because it stops the next reader
  // looking — which is exactly the failure the paragraph above describes, one
  // level up. The coupling is now structural (a shared import) instead of a
  // sentence about a test.
  //
  // The GATING side needs no such pin: both gating sites (the two SUBMIT paths) pass
  // `blockExternalId`, which `composeBlockExternalId` /
  // `mintServerBlockExternalId` always prefix with `blk`/`bls`, so a gating
  // caller cannot produce `'estimate'` by construction.
  //
  // Wrapped, because every sibling `blockAuthorFee*` inc in `author-fee.ts`
  // (`:658`, `:675`, `:693`) is, under the comment "swallow — telemetry must
  // never back-pressure the caller". This runs on a live money path; a
  // prom-client throw here must not be what fails a charge.
  try {
    blockAuthorFeeQuotedCounter.inc({
      // 🔴 DERIVED FROM THE ARGUMENT, NOT FROM THE COMPUTATION — so the type is
      // present on every arm where it is DERIVABLE, not only on the charging
      // one. Reading it off `quote.computation` labelled `zero-fee`,
      // `self-dealing` and `app-missing` as `unknown` even though those arms
      // return AFTER the computation exists, which made
      // `{outcome="zero-fee"}` unable to separate `chat-completion` (0/0 by
      // design) from a type that SHOULD be priced and is not — the exact
      // per-type tuning question this counter is for. It also matches what the
      // charge wrapper does, so the two agree.
      coarse_type:
        blockGenerationCoarseType(args.generationType) ?? BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL,
      outcome: quote.charge ? 'quoted' : quote.reason,
      surface: args.workflowLabel === BLOCK_AUTHOR_FEE_ESTIMATE_LABEL ? 'disclosure' : 'gating',
    });
  } catch {
    // swallow — telemetry must never back-pressure the caller
  }
  return quote;
}

/** The quote itself. Wrapped by `quoteBlockAuthorFee`, which counts its result. */
async function quoteBlockAuthorFeeUncounted(
  // 🔴 DERIVED FROM THE PUBLIC SIGNATURE, NOT RESTATED. Restating it type-checked
  // clean in ONE direction: `quoteBlockAuthorFeeUncounted(args)` passes a
  // variable, so TypeScript's excess-property check does not apply, and a field
  // added to the public type but not the inner one was silently ignored here.
  args: Parameters<typeof quoteBlockAuthorFee>[0]
): Promise<BlockAuthorFeeQuote> {
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
      // `resolveBlockAuthorFeePayee`'s own parameter stays named for what IT
      // does — its two skip lines. This one is wider by exactly this function's
      // `catch`, which is why the two names differ rather than one being reused.
      suppressSkipLogs: args.suppressQuoteLogs,
    });
    if (!payee.payee) return { charge: false, reason: payee.reason };

    return {
      charge: true,
      feeBuzz: computation.feeBuzz,
      appOwnerUserId: payee.appOwnerUserId,
      computation,
    };
  } catch (error) {
    // 🔴 SUPPRESSED FOR A DISCLOSURE-ONLY CALLER, AND ONLY THE WRITE IS — the
    // return below is unconditional, so the fee degrades to "not charged" on
    // every caller alike. See `suppressQuoteLogs` for why this arm in particular
    // must not write on an unbounded surface: it fires when the database is
    // already failing.
    if (!args.suppressQuoteLogs) {
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
    }
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
  const result = await chargeBlockAuthorFeeUncounted(args);
  // Same single-point rule as the quote above: NINE return arms, counted once on
  // the result. `coarse_type` is resolved from the generation type rather than
  // from a computation, because the skip arms return before one exists.
  //
  // 🔴 THIS IS THE ONE COUNTER ON THIS PATH THAT NOTHING ELSE ANSWERS. All 12
  // `logToAxiom` sites in this file log a FAILURE, a SKIP or a REVERSAL — there
  // is NO success log — so "is the fee charging anyone, and when it skips, why"
  // is otherwise answerable only by querying `block_author_fee_accrual`. That is
  // why this survived round 0 while three siblings did not.
  //
  // Wrapped for the same reason as the quote counter above: every sibling inc in
  // `author-fee.ts` is, and this runs after a real Buzz debit.
  try {
    blockAuthorFeeChargedCounter.inc({
      coarse_type:
        blockGenerationCoarseType(args.generationType) ?? BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL,
      outcome: result.charged ? 'charged' : result.reason,
    });
  } catch {
    // swallow — telemetry must never back-pressure the caller
  }
  return result;
}

/** The charge itself. Wrapped by `chargeBlockAuthorFee`, which counts its result. */
async function chargeBlockAuthorFeeUncounted(
  /** Derived, not restated — see `quoteBlockAuthorFeeUncounted`. */
  args: Parameters<typeof chargeBlockAuthorFee>[0]
): Promise<ChargeBlockAuthorFeeResult> {
  const { workflowId, appId, appBlockId, viewerUserId, buzzType } = args;

  // THE STRUCTURAL BOUND, AND IT IS FIRST. Nothing below — not the flag read, not
  // the payee query, not the debit — may run for a path that reserved no fee.
  const reserved = args.reservedAuthorFeeBuzz;
  if (!(typeof reserved === 'number' && Number.isFinite(reserved) && reserved > 0)) {
    return { charged: false, reason: 'not-reserved' };
  }

  // Re-price against the REALIZED base and re-resolve the payee. This is where
  // the self-dealing exclusion is read BEFORE the debit: the quote returns
  // `self-dealing` without a fee, and this function returns before it moves any
  // money.
  //
  // 🔴 THE *UNCOUNTED* QUOTE, DELIBERATELY — THIS IS THE FIFTH CALLER AND IT
  // MUST NOT LAND ON `block_author_fee_quoted_total`. It used to call the
  // counted wrapper, so every charge that got past `not-reserved` ALSO
  // incremented `quoted_total{surface="gating"}` — inflating the denominator of
  // `charged_total / quoted_total{surface="gating"}` by up to 2×, and
  // asymmetrically, since only submits that reserved a fee got the second
  // count. It also made the help string's "gating = the submit-time quote"
  // false, and mixed pre-submit decisions with post-submit ones under the same
  // label.
  //
  // Nothing is lost by not counting it: this quote's outcome is returned
  // verbatim as the charge's `reason` on the very next line, so
  // `charged_total{outcome=...}` already carries it — counting here recorded the
  // same decision twice on two different series.
  //
  // ⚠️ The comment above the quote counter enumerates the callers by SURFACE, and
  // this one is neither: it is a re-price, not a quote anybody is shown or
  // gated on.
  const quote = await quoteBlockAuthorFeeUncounted({
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
    // 🔴 THE ESTIMATE-VS-CHARGE DIVERGENCE IS MEASURED BY THE AXIOM LINE BELOW,
    // AND DELIBERATELY NOT BY A COUNTER. A round-0 audit killed the counter that
    // briefly sat here, and the reasoning is worth keeping so it is not re-added:
    //
    //   - This log carries strictly MORE than a counter could — `reservedBuzz`,
    //     `realizedBuzz`, `chargedBuzz`, `workflowId`, `appId`. The MAGNITUDE and
    //     IDENTITY of a divergence are what diagnose an under-quote; a bare count
    //     is not.
    //   - The counter's justification was that "the estimate surface is unbounded,
    //     so a rate derived from logs is unreliable". That argument is about the
    //     QUOTE path. This code is inside `chargeBlockAuthorFee`, AFTER a
    //     successful debit — measured at ~1 charge/day — where it does not hold.
    //     It was an argument imported from somewhere it was true.
    //   - Its documented reading was "a RATIO against
    //     `block_author_fee_charged_total`", and at this volume that denominator
    //     is routinely 0 over 24h.
    //
    // If the fee's volume grows by orders of magnitude, revisit — but measure the
    // volume first, which is the step that was skipped.
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
         * 🔴 UNREACHABLE UNDER CORRECT CLOCKS AS THE TWO GUARDS ARE ORDERED
         * TODAY, so its log line (`fee already settled — not reversed`) should be
         * NEAR-SILENT — and if it DOES fire, app-clock skew is the first thing to
         * suspect, not the thing to rule out. The eligibility guard runs
         * FIRST, and the only writer of `status = 'settled'` is the settlement
         * flip, which can only touch rows it scanned — rows with
         * `accruedAt < utcDayStart(runClock)`, i.e. exactly the rows the
         * eligibility guard has already refused. Reaching this arm therefore
         * needs `utcDayStart(T_reverser) <= accruedAt < utcDayStart(T_settler)`:
         * the two app clocks only have to land on DIFFERENT UTC DAYS, NOT a whole
         * day apart. Against the 02:30 UTC settlement schedule a ~2.5 h lag on the
         * reversing app's clock suffices, and in the abstract a sub-second
         * straddle of midnight does — an ordinary NTP failure on one pod, not an
         * exotic one. A manual
         * `settleBlockAuthorFees({ date })` run with a date AHEAD of the
         * reverser's clock reaches it too — the precondition recorded on
         * `settlementBoundary`.
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
