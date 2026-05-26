import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createJob } from './job';

/**
 * STUB — bulk payout for confirmed block_buzz_attribution rows.
 *
 * What this job WILL do once the payout-side is decided:
 *   1. SELECT app_owner_user_id, SUM(app_owner_share_cents) FROM
 *      block_buzz_attribution WHERE status='confirmed' GROUP BY 1
 *   2. For each (user, total): mint a `payout_id` (ULID, `bba_payout_<ulid>`),
 *      update all the contributing rows in one UPDATE statement to
 *      status='paid_out', paid_out_at=now(), payout_id=<minted>.
 *   3. Hand the (user, totalCents, payoutId) tuple to the canonical
 *      payout entry point.
 *
 * What's blocked on a decision from monetization leadership:
 *
 *   A. Where does the money flow? Two viable shapes:
 *      - Treat block attribution as a new line item on the existing
 *        creator-program cash balance (creator-program.service.ts ::
 *        bankBuzz/getCash/withdrawCash). Cleanest because the publisher
 *        already has UserPaymentConfiguration + Tipalti setup. Couples
 *        block earnings to the monthly compensation-pool cap logic,
 *        which doesn't conceptually apply — would need a pool-bypass
 *        path or a separate "non-pool" cash bucket on the same model.
 *      - Mint a separate Tipalti payment via `payToTipaltiAccount`
 *        directly from the bulk job. Decouples from the pool but
 *        skips every guard the creator program has built (caps,
 *        moderation flags, the BannedCreatorProgram onboarding step).
 *
 *   B. UserPaymentConfiguration prerequisite. The user must have
 *      `tipaltiPaymentsEnabled = true` AND a valid
 *      `tipaltiWithdrawalMethod` before any payout can fire. Until they
 *      do, leave the rows in `confirmed` — they'll be picked up on the
 *      next cycle. Same behaviour as the existing `withdrawCash`
 *      path, but the "you have earnings waiting" notification doesn't
 *      exist yet for App Blocks publishers.
 *
 *   C. Refund clawback when a refund/chargeback voids a paid_out row.
 *      Today voidAttributionsForPayment flips status to voided even on
 *      paid_out rows; the next payout cycle needs to deduct the
 *      already-paid amount. The Tipalti adjustment API supports this,
 *      but the exact contract (negative-amount payout vs. cash
 *      reversal vs. carrying forward as debt on the publisher's
 *      account) needs a sign-off.
 *
 *   D. Tax / 1099 reporting. Publisher payouts are 1099-eligible US
 *      taxable income — Tipalti handles the form generation, but only
 *      if the payment is routed through the creator-program cash
 *      bucket. Option B above bypasses this. Confirm before shipping.
 *
 * Until the answers above land, this job runs daily, logs the pending
 * payout totals to Axiom for observability, and writes nothing. The
 * `confirmed` rows accumulate visibly on the publisher dashboard so
 * publishers know money is queued, even if the disbursement is
 * manually batched in the interim.
 *
 * See claudedocs/app-blocks-buzz-attribution-handoff-2026-05-25.md
 * §"Open questions" #2 + #4.
 */
export const bulkPayoutBlockAttributions = createJob(
  'bulk-payout-block-attributions',
  '30 9 * * 1', // Mondays 09:30 UTC — well after the daily confirm job
  async () => {
    type GroupRow = {
      appOwnerUserId: number;
      _sum: { appOwnerShareCents: number | null };
      _count: number;
    };
    const rows = (await dbRead.blockBuzzAttribution.groupBy({
      by: ['appOwnerUserId'],
      where: { status: 'confirmed' },
      _sum: { appOwnerShareCents: true },
      _count: true,
    })) as GroupRow[];

    // Surface the queue depth + dollar value to ops so leadership can
    // batch-process manually until the automated path lights up.
    const totalCents = rows.reduce(
      (acc: number, r: GroupRow) => acc + (r._sum.appOwnerShareCents ?? 0),
      0
    );
    if (rows.length > 0) {
      logToAxiom(
        {
          name: 'block-buzz-attribution',
          type: 'info',
          stage: 'bulk-payout-stub',
          message:
            `block attribution payout pending — ${rows.length} publisher(s), ` +
            `$${(totalCents / 100).toFixed(2)} owed. Automated payout not yet wired; ` +
            `see bulk-payout-block-attributions.ts for the design.`,
          publisherCount: rows.length,
          totalCents,
          perPublisher: rows.map((r: GroupRow) => ({
            appOwnerUserId: r.appOwnerUserId,
            shareCents: r._sum.appOwnerShareCents ?? 0,
            rowCount: r._count,
          })),
        },
        'webhooks'
      ).catch(() => null);
    }

    return { pendingPublishers: rows.length, pendingTotalCents: totalCents };
  }
);
