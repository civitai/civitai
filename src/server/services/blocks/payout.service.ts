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
import {
  getBlockPayoutRefCode,
  newBlockPayoutWithdrawalId,
  newUlid,
} from '~/server/utils/app-block-ids';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
} from '~/server/utils/errorHandling';
import { Flags } from '~/shared/utils/flags';
import { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';

const PAYOUT_LOG_NAME = 'block-revenue-payout';

/**
 * Dedicated ALERTABLE log name (audit #4). Emitted ONLY on the one unsafe
 * branch: Tipalti accepted the payment batch but the subsequent DB row-update
 * (status → pending_approval) failed, so money has moved but our tracking row
 * is not in its expected terminal-pending state. We deliberately do NOT revert
 * in this branch (money is already gone — see #3 ordering), so this needs human
 * eyes. Wire a Prometheus/Loki alert rule to match this exact `name` so it pages
 * (no in-process goalert hook exists for money paths; the convention is a
 * distinct logToAxiom name an alert rule keys on — see manage-alerts skill).
 */
const PAYOUT_CRITICAL_LOG_NAME = 'block-revenue-payout-critical-sent-not-recorded';

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
 * Sequence (idempotent + retryable; audit #3 SAFE ORDERING — mirrors
 * withdrawCash's shape so there is NO "revert after money already sent" window):
 *   a. FLAG GATE FIRST — refuse unless `app-blocks-payout-enabled` is on. With
 *      it off (the default), nothing past here runs: no mint, no Tipalti.
 *   b. Preconditions: user not banned; Tipalti payable (tipaltiPaymentsEnabled
 *      + a real withdrawal method ≠ NoPM); confirmed net ≥ $100.
 *   c. Create the `block_payout_withdrawal` tracking row in 'processing' FIRST,
 *      carrying the withdrawalId + refCode, so the Tipalti webhook can ALWAYS
 *      find a row to reconcile against (no row-after-Tipalti race).
 *   d. mintPayoutForOwner — serialized per-owner by an advisory lock; flips this
 *      owner's confirmed net to paid_out under a fresh ledger row. If !minted
 *      (net≤0 / already paid / 0-flip), mark the row 'no_balance' and abort with
 *      NO Tipalti call (nothing to disburse).
 *   e. payToTipaltiAccount(amount = totalCents/100, byUserId:-1).
 *        - ON FAILURE (no money moved): revertPayoutMint (un-flip rows + delete
 *          the ledger row) + mark the row 'failed' → balance restored, retryable.
 *        - ON SUCCESS: update the row → 'pending_approval' with paymentBatchId/
 *          paymentRefCode. If THAT update fails (money already sent): DO NOT
 *          revert — emit the CRITICAL alertable signal and leave rows paid_out;
 *          the row already exists (from step c) so the webhook still reconciles.
 *
 * The load-bearing property: a revert (which restores the publisher's balance)
 * is only ever reachable on the pre-disbursement failure path. We never restore
 * a balance for money that actually left.
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

  // c. Unique request id + refCode, and the tracking ROW FIRST (audit #3). -----
  // The row is created in 'processing' BEFORE the mint/Tipalti so the webhook
  // can always find a row to reconcile against (keyed on the stored refCode).
  // refCode uses the dedicated BPW prefix (NOT 'CW') so the Tipalti webhook
  // routes it to the block-payout handler, not the creator-program one (#2).
  const withdrawalId = newBlockPayoutWithdrawalId();
  const periodKey = `withdraw:${newUlid()}`;
  const refCode = getBlockPayoutRefCode(withdrawalId);

  await dbWrite.blockPayoutWithdrawal.create({
    data: {
      id: withdrawalId,
      appOwnerUserId: userId,
      payoutId: null,
      amountCents: 0, // unknown until the mint claims rows; set on disburse.
      method,
      refCode,
      status: 'processing',
      note: 'Withdrawal initiated',
    },
  });

  // d. MINT — serialized per-owner by an advisory lock inside mintPayoutForOwner.
  // Flips confirmed → paid_out under a fresh ledger row, OR returns minted:false
  // (net≤0 / already paid / 0-flip). On !minted: nothing was claimed, so abort
  // before Tipalti and mark the tracking row 'no_balance'. -----------------------
  const mint = await mintPayoutForOwner({ appOwnerUserId: userId, periodKey });
  if (!mint.minted) {
    await dbWrite.blockPayoutWithdrawal
      .update({
        where: { id: withdrawalId },
        data: { status: 'no_balance', note: 'No confirmed App revenue available to withdraw' },
      })
      .catch(() => null);
    logToAxiom(
      {
        name: PAYOUT_LOG_NAME,
        type: 'info',
        message: `withdraw aborted before Tipalti (nothing to pay) for owner ${userId}`,
        userId,
        withdrawalId,
        periodKey,
        mint,
      },
      'webhooks'
    ).catch(() => null);
    throw throwInsufficientFundsError('No confirmed App revenue available to withdraw.');
  }

  const { payoutId, totalCents, rowCount } = mint;

  // Belt-and-braces against blocker #1: a minted result must carry a positive
  // amount backed by flipped rows. mintPayoutForOwner already guarantees this
  // (advisory lock + 0-flip guard), but assert here so a payable amount can
  // NEVER reach Tipalti without rows behind it.
  if (totalCents <= 0 || rowCount <= 0) {
    // This is not a money-moved state (Tipalti hasn't been called), so revert is
    // safe: un-flip whatever the mint touched + delete the ledger row.
    await revertPayoutMint({ payoutId, appOwnerUserId: userId }).catch(() => null);
    await dbWrite.blockPayoutWithdrawal
      .update({
        where: { id: withdrawalId },
        data: { status: 'failed', payoutId: null, note: 'Mint returned no payable rows' },
      })
      .catch(() => null);
    throw throwBadRequestError('No confirmed App revenue available to withdraw.');
  }

  // e. DISBURSE. ------------------------------------------------------------
  let paymentBatchId: string;
  let paymentRefCode: string;
  try {
    ({ paymentBatchId, paymentRefCode } = await payToTipaltiAccount({
      requestId: refCode,
      toUserId: userId,
      // Tipalti takes DOLLARS, not cents (mirrors withdrawCash).
      amount: totalCents / 100,
      description: `App Blocks revenue payout ${refCode}`,
      byUserId: -1, // the bank
    }));
  } catch (e) {
    // FAILURE BEFORE money moved → safe to restore the balance. Compensating
    // revert (un-flip rows → confirmed + delete the ledger row), then mark the
    // tracking row 'failed'. The publisher keeps their balance and can retry.
    let revertError: unknown = null;
    try {
      await revertPayoutMint({ payoutId, appOwnerUserId: userId });
    } catch (re) {
      revertError = re;
    }

    await dbWrite.blockPayoutWithdrawal
      .update({
        where: { id: withdrawalId },
        data: {
          // Revert succeeded → ledger row gone → clear the FK. Revert FAILED →
          // keep the linkage so an operator can find the orphaned ledger row.
          payoutId: revertError ? payoutId : null,
          amountCents: totalCents,
          status: 'failed',
          note: `Disbursement failed; mint ${
            revertError ? 'REVERT FAILED — manual intervention required' : 'reverted'
          }: ${(e as Error)?.message ?? 'unknown error'}`,
        },
      })
      .catch(() => null);

    logToAxiom(
      {
        name: revertError ? PAYOUT_CRITICAL_LOG_NAME : PAYOUT_LOG_NAME,
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

  // f. SUCCESS → record the terminal pending-approval state. -----------------
  // Money has ALREADY moved. If THIS update fails we must NOT revert (we'd
  // restore a balance that was disbursed). The row already exists (step c) so
  // the webhook can still reconcile; we emit a CRITICAL alertable signal and
  // leave the rows paid_out. (#3 hard-case elimination + #4 alert.)
  try {
    await dbWrite.blockPayoutWithdrawal.update({
      where: { id: withdrawalId },
      data: {
        payoutId,
        amountCents: totalCents,
        status: 'pending_approval',
        paymentBatchId,
        // Keep `refCode` as the BPW refCode we SENT (the webhook-lookup key);
        // store what Tipalti echoed separately. They're equal today
        // (payToTipaltiAccount slices requestId to 16 chars == our refCode), but
        // recording both keeps reconciliation robust if Tipalti ever transforms.
        paymentRefCode,
        note: 'Payment waiting for Moderator approval',
      },
    });
  } catch (updateErr) {
    logToAxiom(
      {
        name: PAYOUT_CRITICAL_LOG_NAME,
        type: 'error',
        message: `CRITICAL: Tipalti payment SENT but block_payout_withdrawal row update FAILED for owner ${userId} — money moved, row not in pending_approval. Manual reconciliation required.`,
        userId,
        withdrawalId,
        payoutId,
        totalCents,
        paymentBatchId,
        paymentRefCode,
        error: updateErr,
      },
      'webhooks'
    ).catch(() => null);
    // Money is out the door; surface success to the caller (the disbursement
    // happened) rather than tripping a retry that would double-pay. The webhook
    // reconciles the row off the persisted refCode.
    return {
      withdrawalId,
      payoutId,
      amountCents: totalCents,
      paymentBatchId,
      paymentRefCode,
    };
  }

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
}
