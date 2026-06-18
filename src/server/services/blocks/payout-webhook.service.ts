import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { revertPayoutMint } from '~/server/services/blocks/buzz-attribution.service';

/**
 * App-Blocks publisher-revenue payout RECONCILIATION (audit blocker #2).
 *
 * Extracted from the Tipalti webhook route so it is unit-testable without
 * standing up the whole `/api/webhooks/tipalti` handler (env validation, the
 * Tipalti signature client, the creator-program services). The route imports
 * and dispatches to this for any refCode on the App-Blocks rail (BPW prefix).
 *
 * Mirrors `processCashWithdrawalEvent` but drives the dedicated
 * `block_payout_withdrawal` table. The rail's refCode uses the `BPW` prefix and
 * is persisted on the row, so we look the row up by EXACT `ref_code` match (the
 * refCode is not parseable back into the id — Tipalti's 16-char cap).
 *
 * Terminal-state machine:
 *   - paymentGroupApproved / paymentCompleted        → 'completed'
 *   - paymentGroupDeclined / paymentError / Canceled → 'failed' AND restore the
 *     publisher's balance by reverting the mint (un-flip rows → confirmed)
 *     keyed on the row's payoutId. Safe: a declined/cancelled/errored payment
 *     means money did NOT leave.
 *   - paymentSubmitted / paymentDeferred             → left in 'pending_approval'
 *     (intermediate; no terminal change, note updated).
 *
 * Idempotent: revertPayoutMint no-ops on a re-delivered failure (rows already
 * confirmed / ledger gone), and the failure restore only fires when
 * transitioning into 'failed' from a non-terminal state.
 */
const BLOCK_PAYOUT_WEBHOOK_LOG = 'block-revenue-payout-webhook';
const BLOCK_PAYOUT_CRITICAL_LOG = 'block-revenue-payout-critical-sent-not-recorded';

export type BlockPayoutWebhookEvent = {
  type: string;
  eventData: {
    refCode?: string;
    paymentStatus?: string;
    errorDescription?: string;
    payments?: Array<{ refCode: string; paymentStatus?: string }>;
    [k: string]: unknown;
  };
};

export async function processBlockPayoutEvent(event: BlockPayoutWebhookEvent): Promise<void> {
  const refCode =
    event.type === 'paymentGroupApproved' || event.type === 'paymentGroupDeclined'
      ? event.eventData.payments?.[0]?.refCode
      : event.eventData.refCode;

  if (!refCode) {
    throw new Error('Block payout webhook missing refCode');
  }

  const row = await dbWrite.blockPayoutWithdrawal.findFirst({
    where: { refCode },
  });

  if (!row) {
    throw new Error(`Block payout withdrawal not found for refCode: ${refCode}`);
  }

  let nextStatus: string | null = null;
  let note: string;
  let restoreBalance = false;

  switch (event.type) {
    case 'paymentGroupApproved':
    case 'paymentCompleted':
      nextStatus = 'completed';
      note =
        event.type === 'paymentCompleted'
          ? 'Payment completed'
          : "Payment approved by Moderators. Tipalti's processing should start shortly.";
      break;

    case 'paymentGroupDeclined':
    case 'paymentError':
    case 'paymentCanceled':
      nextStatus = 'failed';
      restoreBalance = true;
      note =
        event.type === 'paymentError'
          ? `Payment error: ${event.eventData.errorDescription ?? 'unknown'}`
          : event.type === 'paymentCanceled'
          ? 'Payment canceled'
          : 'Payment declined';
      break;

    case 'paymentSubmitted':
      note = 'Payment submitted; awaiting completion';
      break;
    case 'paymentDeferred':
      note = 'Payment deferred';
      break;
    default:
      note = `Unhandled event ${event.type}`;
      break;
  }

  // Restore the publisher's balance on a terminal FAILURE (money did not leave).
  // Only when transitioning into 'failed' from a non-terminal state, and only if
  // the row still carries a payoutId. Idempotent on re-delivery.
  if (
    restoreBalance &&
    row.payoutId &&
    row.status !== 'failed' &&
    row.status !== 'completed'
  ) {
    try {
      await revertPayoutMint({ payoutId: row.payoutId, appOwnerUserId: row.appOwnerUserId });
    } catch (e) {
      logToAxiom(
        {
          name: BLOCK_PAYOUT_CRITICAL_LOG,
          type: 'error',
          message: `CRITICAL: failed to restore balance for declined block payout ${row.id} — manual reconciliation required`,
          withdrawalId: row.id,
          payoutId: row.payoutId,
          appOwnerUserId: row.appOwnerUserId,
          error: e,
        },
        'webhooks'
      ).catch(() => null);
      throw e;
    }
  }

  await dbWrite.blockPayoutWithdrawal.update({
    where: { id: row.id },
    data: {
      ...(nextStatus ? { status: nextStatus } : {}),
      // The revert clears the ledger row via ON DELETE SET NULL, but explicitly
      // null the FK here so it can't dangle on the failed row.
      ...(restoreBalance ? { payoutId: null } : {}),
      note,
    },
  });

  logToAxiom(
    {
      name: BLOCK_PAYOUT_WEBHOOK_LOG,
      type: nextStatus === 'failed' ? 'warning' : 'info',
      message: `block payout ${row.id} → ${nextStatus ?? row.status} (${event.type})`,
      withdrawalId: row.id,
      appOwnerUserId: row.appOwnerUserId,
      eventType: event.type,
      nextStatus,
      restoredBalance: restoreBalance,
    },
    'webhooks'
  ).catch(() => null);
}
