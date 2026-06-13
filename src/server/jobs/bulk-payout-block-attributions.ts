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
 * Recommended path (2026-05-26, pending monetization sign-off):
 *
 *   A — Route money: creator-program cash bank
 *       (creator-program.service.ts :: withdrawCash). Reasons:
 *       (1) 1099-NEC reporting flows automatically through Tipalti
 *           when payments go through the cash bucket — required for
 *           US publishers earning >$600/year. Option B (direct Tipalti
 *           batch) skips this entirely, creating tax liability.
 *       (2) Publishers are already creators; UserPaymentConfiguration
 *           is one path, not two.
 *       (3) Existing fraud + pool-cap guards apply.
 *       Trade-off: may delay payouts if the pool is throttled.
 *       Acceptable for v1.
 *
 *   C — Refund clawback: carry-forward debt
 *       Affiliate-network standard. Implementation:
 *       - Refund BEFORE payout: void the row (existing path). Done.
 *       - Refund AFTER payout: void the original row AND write a NEW
 *         negative-amount attribution row (status='voided',
 *         voided_reason='refund'). The bulk-payout aggregator
 *         subtracts the negative from the publisher's next payout.
 *         If the running balance stays negative for >90 days, flag
 *         for manual review (likely fraud or anomaly).
 *       Avoids the Tipalti adjustment-API complexity and the surprise
 *       of immediate cash reversal. The publisher dashboard at
 *       /apps/revenue shows the ledger transparently either way.
 *
 *   D — Tax / 1099: handled by route A automatically.
 *
 * Still open (NOT recommended yet, needs leadership):
 *   B. UserPaymentConfiguration UX — "you have earnings waiting"
 *      notification for publishers who haven't completed Tipalti
 *      setup. Out of v1; rows accumulate visibly on the dashboard.
 *
 * Until the implementation lands, this job runs daily, logs the
 * pending payout totals to Axiom for observability, and writes
 * nothing. The `confirmed` rows accumulate visibly on the publisher
 * dashboard so publishers know money is queued, even if the
 * disbursement is manually batched in the interim.
 *
 * PAYOUT-1 safety substrate (2026-05-31): the idempotent mint + flip is
 * now implemented in `mintPayoutForOwner` (buzz-attribution.service.ts).
 * It writes the block_attribution_payout idempotency ledger and flips
 * the contributing confirmed rows to paid_out — but moves NO money and
 * is intentionally NOT wired here yet. Once disbursement (route A: the
 * creator-program cash bank / Tipalti) and leadership sign-off land,
 * wire this cron to call `mintPayoutForOwner({ appOwnerUserId, periodKey })`
 * per publisher, then hand the returned (payoutId, totalCents) to the
 * disbursement entry point.
 *
 * Clawback (route C) is also live: refund-after-payout now writes a
 * negative carry-forward `entry_type='clawback'` row (see
 * voidAttributionsForPayment), so mintPayoutForOwner's `status='confirmed'`
 * aggregate nets the debt automatically — no separate reconciliation
 * step. A net <= 0 carries forward (no mint, no flip).
 *
 * See claudedocs/app-blocks-buzz-attribution-handoff-2026-05-25.md
 * §"Open questions" #2 + #4 for the original framing of the
 * decision matrix.
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
    // Two-step cast via `unknown` — Prisma's groupBy uses constrained generic
    // inference that lets a direct `as GroupRow[]` back-propagate into the
    // args type (`& GroupRow[]` intersection), which then fails to validate
    // the args object. Casting through `unknown` breaks the back-propagation.
    const rows = (await dbRead.blockBuzzAttribution.groupBy({
      by: ['appOwnerUserId'],
      where: { status: 'confirmed' },
      _sum: { appOwnerShareCents: true },
      _count: true,
    })) as unknown as GroupRow[];

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
