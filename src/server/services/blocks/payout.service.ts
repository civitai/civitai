import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { OnboardingSteps } from '~/server/common/enums';
import { isAppBlocksPayoutEnabled } from '~/server/services/app-blocks-flag';
import {
  getRevenueForOwner,
  mintPayoutForOwner,
  revertPayoutMint,
} from '~/server/services/blocks/buzz-attribution.service';
import { payToTipaltiAccount } from '~/server/services/user-payment-configuration.service';
import { getWithdrawalRefCode } from '~/server/utils/creator-program.utils';
import { newBlockPayoutWithdrawalId, newUlid } from '~/server/utils/app-block-ids';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '~/server/utils/errorHandling';
import { Flags } from '~/shared/utils/flags';
import { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';

const PAYOUT_LOG_NAME = 'block-revenue-payout';

/**
 * Minimum disbursable balance, in USD cents. Mirrors the creator-program
 * `minBuzzWithdrawal` ($100) so the two rails share a withdrawal floor — keeps
 * Tipalti batch volume sane and matches the publisher-facing "$100 minimum"
 * copy. 10_000 cents = $100.
 */
export const MIN_APP_REVENUE_PAYOUT_CENTS = 10_000;

export type WithdrawAppRevenueResult = {
  withdrawalId: string;
  payoutId: string;
  amountCents: number;
  paymentBatchId: string;
  paymentRefCode: string;
};

/**
 * PR1 — publisher-initiated, full-balance withdrawal of App-Block revenue
 * share over the SEPARATE Tipalti rail.
 *
 * "Separate rail" = the money is the publisher's confirmed `block_buzz_
 * attribution` share (USD cents, already net of the rate-card platform split),
 * NOT Buzz. It is disbursed via Tipalti directly and NEVER credited into the
 * externally-owned Buzz cash accounts (cashSettled/cashPending) — so it is not
 * subject to the creator-program pool cap or the 30% fee, and it preserves the
 * existing Tipalti 1099-NEC reporting path. No `createBuzzTransaction` /
 * `cashSettled` burn happens here (contrast `withdrawCash`), which is exactly
 * why the compensating revert below is a pure DB rollback — no Buzz to refund.
 *
 * Sequence (idempotent + retryable):
 *   a. FLAG GATE FIRST — refuse unless `app-blocks-payout-enabled` is on. With
 *      it off (the default), nothing past here runs: no mint, no Tipalti.
 *   b. Preconditions: user not banned; Tipalti payable (tipaltiPaymentsEnabled
 *      + a real withdrawal method ≠ NoPM); confirmed net ≥ $100.
 *   c. Generate a fresh ULID up front and use it as BOTH the mint period_key
 *      AND the withdrawal id, so each attempt is globally unique and a retry
 *      after a revert can't collide with the (deleted) prior period.
 *   d. mintPayoutForOwner(periodKey) — flips this owner's confirmed net to
 *      paid_out under a fresh ledger row. If !minted (net≤0 / already paid),
 *      abort WITHOUT calling Tipalti (nothing to disburse).
 *   e. payToTipaltiAccount(amount = totalCents/100, byUserId:-1) and record the
 *      tracking row.
 *   g. COMPENSATING REVERT on ANY failure after the mint — un-flip the rows +
 *      delete the ledger row (revertPayoutMint) so the publisher keeps the
 *      balance and can retry. This is the load-bearing correctness property.
 */
export async function withdrawAppRevenue(userId: number): Promise<WithdrawAppRevenueResult> {
  // a. FLAG GATE — must be first. Nothing moves until this is explicitly on.
  if (!(await isAppBlocksPayoutEnabled())) {
    throw throwBadRequestError('App Blocks revenue payouts are not enabled');
  }

  // b. Preconditions ------------------------------------------------------
  // Ban check: a globally-banned user, or one banned from the creator program
  // (same Tipalti payment infrastructure), cannot withdraw.
  const user = await dbRead.user.findFirst({
    where: { id: userId },
    select: { id: true, bannedAt: true, onboarding: true },
  });
  if (!user) throw throwAuthorizationError('User not found');
  if (user.bannedAt) throw throwAuthorizationError('User is banned');
  if (Flags.hasFlag(user.onboarding, OnboardingSteps.BannedCreatorProgram)) {
    throw throwAuthorizationError('User is banned from payouts');
  }

  // Tipalti-payable — the SAME preconditions withdrawCash enforces. We reuse
  // them so app-revenue payouts ride the identical, already-vetted Tipalti
  // payable surface (tax forms, 1099-NEC, payee account).
  const userPaymentConfiguration = await dbRead.userPaymentConfiguration.findUnique({
    where: { userId },
  });
  if (!userPaymentConfiguration?.tipaltiPaymentsEnabled) {
    throw throwBadRequestError('User is not payable. Please complete payment setup.');
  }
  const method = userPaymentConfiguration.tipaltiWithdrawalMethod;
  if (!method || method === CashWithdrawalMethod.NoPM) {
    throw throwBadRequestError(
      'We could not determine your Tipalti payment method. Please update it and check back.'
    );
  }

  // Confirmed net balance ≥ $100. getRevenueForOwner's `confirmed` bucket
  // shareCents already nets clawbacks (negative confirmed rows) — same set
  // mintPayoutForOwner will aggregate, so this gate and the mint agree.
  const { summary } = await getRevenueForOwner({ ownerUserId: userId });
  const confirmedNetCents = summary.confirmed.shareCents;
  if (confirmedNetCents < MIN_APP_REVENUE_PAYOUT_CENTS) {
    throw throwInsufficientFundsError(
      `App revenue balance is below the $${(MIN_APP_REVENUE_PAYOUT_CENTS / 100).toFixed(
        0
      )} minimum withdrawal.`
    );
  }

  // c. Unique request id (drives mint period_key + withdrawal id + refCode). --
  const withdrawalId = newBlockPayoutWithdrawalId();
  const periodKey = `withdraw:${newUlid()}`;
  const refCode = getWithdrawalRefCode(withdrawalId, userId);

  // d. MINT — flips confirmed → paid_out under a fresh ledger row. After this
  // line we OWE the publisher a disbursement or a revert. -------------------
  const mint = await mintPayoutForOwner({ appOwnerUserId: userId, periodKey });
  if (!mint.minted) {
    // Net non-positive (e.g. a clawback landed between the gate and the mint)
    // or the period was somehow already paid. Either way: nothing to disburse,
    // nothing was flipped to pay out — abort cleanly without touching Tipalti.
    logToAxiom(
      {
        name: PAYOUT_LOG_NAME,
        type: 'info',
        message: `withdraw aborted before Tipalti (nothing to pay) for owner ${userId}`,
        userId,
        periodKey,
        mint,
      },
      'webhooks'
    ).catch(() => null);
    throw throwInsufficientFundsError('No confirmed App revenue available to withdraw.');
  }

  const { payoutId, totalCents } = mint;

  // e + g. Disburse, recording the tracking row. ANY failure past the mint
  // triggers the compensating revert so the publisher keeps their balance. ---
  try {
    const { paymentBatchId, paymentRefCode } = await payToTipaltiAccount({
      requestId: refCode,
      toUserId: userId,
      // Tipalti takes DOLLARS, not cents (mirrors withdrawCash).
      amount: totalCents / 100,
      description: `App Blocks revenue payout ${refCode}`,
      byUserId: -1, // the bank
    });

    // Tracking record. Written AFTER the Tipalti batch so a failed disbursement
    // never leaves a row claiming money was sent; if THIS write fails we still
    // revert the mint (publisher keeps balance) and surface the error.
    await dbWrite.blockPayoutWithdrawal.create({
      data: {
        id: withdrawalId,
        appOwnerUserId: userId,
        payoutId,
        amountCents: totalCents,
        method,
        refCode: paymentRefCode,
        status: 'pending_approval',
        paymentBatchId,
        note: 'Payment waiting for Moderator approval',
      },
    });

    logToAxiom(
      {
        name: PAYOUT_LOG_NAME,
        type: 'info',
        message: `withdrew App revenue ${withdrawalId} for owner ${userId}`,
        userId,
        withdrawalId,
        payoutId,
        totalCents,
        paymentBatchId,
        paymentRefCode,
      },
      'webhooks'
    ).catch(() => null);

    return {
      withdrawalId,
      payoutId,
      amountCents: totalCents,
      paymentBatchId,
      paymentRefCode,
    };
  } catch (e) {
    // COMPENSATING REVERT. No Buzz/cash moved, so this is a pure DB rollback:
    // un-flip the paid_out rows → confirmed and delete the ledger row, in one
    // transaction. The publisher's confirmed balance is restored exactly and
    // they can retry (the next attempt mints under a fresh period_key).
    let revertError: unknown = null;
    try {
      await revertPayoutMint({ payoutId, appOwnerUserId: userId });
    } catch (re) {
      revertError = re;
    }

    // Best-effort audit row of the failed-then-reverted attempt. The payoutId
    // FK is ON DELETE SET NULL so the revert's ledger delete won't drop this.
    try {
      await dbWrite.blockPayoutWithdrawal.create({
        data: {
          id: withdrawalId,
          appOwnerUserId: userId,
          payoutId: revertError ? payoutId : null,
          amountCents: totalCents,
          method,
          refCode,
          status: 'reverted',
          note: `Disbursement failed; mint ${
            revertError ? 'REVERT FAILED — manual intervention required' : 'reverted'
          }: ${(e as Error)?.message ?? 'unknown error'}`,
        },
      });
    } catch {
      // swallow — the revert (balance restoration) is what matters; the audit
      // row is secondary and must never mask the original error.
    }

    logToAxiom(
      {
        name: PAYOUT_LOG_NAME,
        type: 'error',
        message: `App revenue withdrawal FAILED for owner ${userId} — mint ${
          revertError ? 'REVERT FAILED' : 'reverted'
        }`,
        userId,
        withdrawalId,
        payoutId,
        totalCents,
        error: e,
        revertError,
      },
      'webhooks'
    ).catch(() => null);

    throw e;
  }
}
