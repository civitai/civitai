import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { blockBuzzAttributionWriteCounter } from '~/server/prom/client';
import {
  type BlockAttribution,
  type BlockAttributionScope,
} from '~/server/schema/blocks/attribution.schema';
import {
  newBlockAttributionPayoutId,
  newBlockBuzzAttributionId,
} from '~/server/utils/app-block-ids';
import { computeRateCardSplit, ACTIVE_RATE_CARD } from './rate-card';

export type AttributionPaymentProvider = 'stripe' | 'paddle' | 'nowpayments';

export type RecordAttributionInput = {
  userId: number;
  buzzAmount: number;
  /** Yellow / blue / green / red — mirrors BuzzTransaction.toAccountType. */
  buzzType?: string;
  /** Gross USD in cents (i.e. Stripe `amount_total`). */
  usdAmountCents: number;
  /** Provider fee in cents — taken off the top before publisher share. */
  providerFeeCents: number;
  paymentProvider: AttributionPaymentProvider;
  /** Provider's transaction id (Stripe PI/session id, Paddle tx id, etc). */
  paymentTransactionId: string;
  /** Buzz API transactionId once we have it. Nullable for race-safety. */
  buzzTransactionId?: string | null;
  attribution: BlockAttribution;
};

export type RecordAttributionResult = {
  /** False when the unique constraint blocked a duplicate write — i.e. webhook retry. */
  written: boolean;
  /** The attribution row, whether freshly written or pre-existing. */
  row: {
    id: string;
    status: string;
    appOwnerShareCents: number;
    platformShareCents: number;
    providerFeeCents: number;
    rateCardVersion: string;
    voidedReason: string | null;
  };
};

const ATTRIBUTION_LOG_NAME = 'block-buzz-attribution';

/**
 * Record a buzz purchase that originated inside an App Block. Idempotent
 * on `(payment_transaction_id, app_block_id)` — webhook retries are
 * no-ops. Self-purchase and internal-owner cases write rows with a zero
 * publisher share so the audit trail is preserved (the platform credit
 * is still 100% civitai's share, just expressed via app_owner_share=0).
 *
 * This function does NOT touch BuzzTransaction — buzz lives in a remote
 * API, not Postgres. The webhook handler calls `completeStripeBuzzTransaction`
 * first, then passes the resulting transactionId here. If our write
 * fails after the buzz credit succeeds, the credit stays — the buzz
 * crediting is the source of truth for "the user got their buzz" and
 * the attribution row is a derived audit/payout artifact. A failed
 * write will be retried by the provider's webhook retry policy and the
 * unique constraint protects against double-writes.
 */
export async function recordAttribution(
  input: RecordAttributionInput
): Promise<RecordAttributionResult> {
  const {
    userId,
    buzzAmount,
    buzzType = 'yellow',
    usdAmountCents,
    providerFeeCents,
    paymentProvider,
    paymentTransactionId,
    buzzTransactionId = null,
    attribution,
  } = input;

  // Resolve the app owner. We snapshot the userId onto the row so a
  // future OauthClient.userId reassignment doesn't retroactively
  // re-route past payouts. If the app isn't found we abort — without
  // an owner there's nothing to pay out.
  const app = await dbRead.oauthClient.findUnique({
    where: { id: attribution.appId },
    select: { id: true, userId: true },
  });
  if (!app) {
    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'warning',
        message: `attribution app not found (skipping write): ${attribution.appId}`,
        appId: attribution.appId,
        paymentProvider,
        paymentTransactionId,
      },
      'webhooks'
    ).catch(() => null);
    throw new AttributionAppMissingError(attribution.appId);
  }

  const isSelfPurchase = userId === app.userId;
  const split = computeRateCardSplit({
    grossCents: usdAmountCents,
    providerFeeCents,
    scope: attribution.scope as BlockAttributionScope,
    isSelfPurchase,
    appOwnerUserId: app.userId,
  });

  const status = isSelfPurchase ? 'voided' : 'pending';
  const voidedReason = isSelfPurchase ? 'self_purchase' : null;
  const voidedAt = isSelfPurchase ? new Date() : null;

  const id = newBlockBuzzAttributionId();

  try {
    const created = await dbWrite.blockBuzzAttribution.create({
      data: {
        id,
        userId,
        buzzAmount,
        buzzType,
        usdAmountCents,
        paymentProvider,
        paymentTransactionId,
        buzzTransactionId,
        appId: attribution.appId,
        appBlockId: attribution.appBlockId,
        blockInstanceId: attribution.blockInstanceId,
        scope: attribution.scope,
        modelId: attribution.modelId ?? null,
        rateCardVersion: split.rateCardVersion,
        appOwnerShareCents: split.appOwnerShareCents,
        platformShareCents: split.platformShareCents,
        providerFeeCents: split.providerFeeCents,
        appOwnerUserId: app.userId,
        status,
        voidedReason,
        voidedAt,
      },
      select: {
        id: true,
        status: true,
        appOwnerShareCents: true,
        platformShareCents: true,
        providerFeeCents: true,
        rateCardVersion: true,
        voidedReason: true,
      },
    });

    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `attribution written ${created.id}`,
        attributionId: created.id,
        appId: attribution.appId,
        appBlockId: attribution.appBlockId,
        scope: attribution.scope,
        paymentProvider,
        paymentTransactionId,
        usdAmountCents,
        appOwnerShareCents: split.appOwnerShareCents,
        platformShareCents: split.platformShareCents,
        providerFeeCents: split.providerFeeCents,
        rateCardVersion: split.rateCardVersion,
        status,
        voidedReason,
        isSelfPurchase,
      },
      'webhooks'
    ).catch(() => null);

    // Best-effort Prometheus increment. Never fail the call on a
    // metric write error — metric infrastructure issues should not
    // back-pressure the webhook path.
    try {
      blockBuzzAttributionWriteCounter.inc({
        provider: paymentProvider,
        scope: attribution.scope,
        status,
      });
    } catch {
      // swallow
    }

    return { written: true, row: created };
  } catch (err) {
    // Idempotency: a webhook retry that races with the original write
    // will land here. Return the pre-existing row so callers can treat
    // success and retry uniformly.
    //
    // We duck-type on the Prisma error shape (`code === 'P2002'`)
    // rather than `instanceof Prisma.PrismaClientKnownRequestError`
    // because the error class isn't always present at runtime in test
    // environments where the Prisma client is stale or missing.
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      const existing = await dbRead.blockBuzzAttribution.findUnique({
        where: {
          paymentTransactionId_appBlockId: {
            paymentTransactionId,
            appBlockId: attribution.appBlockId,
          },
        },
        select: {
          id: true,
          status: true,
          appOwnerShareCents: true,
          platformShareCents: true,
          providerFeeCents: true,
          rateCardVersion: true,
          voidedReason: true,
        },
      });
      if (existing) {
        return { written: false, row: existing };
      }
    }
    throw err;
  }
}

export class AttributionAppMissingError extends Error {
  appId: string;
  constructor(appId: string) {
    super(`OauthClient '${appId}' not found for attribution`);
    this.name = 'AttributionAppMissingError';
    this.appId = appId;
  }
}

/** Synthetic payment_transaction_id suffix for clawback rows so they don't
 * collide with the original purchase row's (payment_transaction_id,
 * app_block_id) UNIQUE. A second refund webhook for the same payment hits
 * P2002 on this synthetic key → we skip the duplicate clawback. */
const CLAWBACK_TX_SUFFIX = ':clawback';

/**
 * Void an attribution row in response to a refund or chargeback. Called
 * from the refund/dispute webhook handlers. Idempotent — voiding an
 * already-voided row is a no-op.
 *
 * Refund handling depends on whether the money already left:
 *   - pending / confirmed rows (never paid): just void. No clawback —
 *     the publisher was never paid, so there's no debt to recover.
 *   - paid_out rows: void the original AND write a NEGATIVE carry-forward
 *     `entry_type='clawback'` row (status='confirmed', negative
 *     app_owner_share_cents / usd_amount_cents). The payout aggregator
 *     nets this debt out of the publisher's next period mint. The
 *     original payout_id stays on the voided row for audit.
 *
 * Idempotency of the clawback: each clawback row reuses the original's
 * (app_block_id) with a synthetic payment_transaction_id
 * '<orig>:clawback', so the (payment_transaction_id, app_block_id) UNIQUE
 * makes a second refund webhook a no-op (P2002 caught + skipped).
 *
 * Returns the count of rows voided (unchanged contract); clawback rows
 * are counted separately in the log.
 */
export async function voidAttributionsForPayment({
  paymentProvider,
  paymentTransactionId,
  reason,
}: {
  paymentProvider: AttributionPaymentProvider;
  paymentTransactionId: string;
  reason: 'refund' | 'chargeback' | 'manual_review';
}): Promise<number> {
  // Snapshot the already-paid_out rows BEFORE voiding so we can mint
  // their clawbacks. Only paid_out rows generate debt; pending/confirmed
  // refunds need no clawback (money never left).
  const paidOutRows = await dbWrite.blockBuzzAttribution.findMany({
    where: {
      paymentProvider,
      paymentTransactionId,
      status: 'paid_out',
    },
    select: {
      appOwnerShareCents: true,
      appOwnerUserId: true,
      userId: true,
      buzzType: true,
      appId: true,
      appBlockId: true,
      blockInstanceId: true,
      scope: true,
      modelId: true,
      rateCardVersion: true,
    },
  });

  // Write the clawbacks BEFORE the void — the ordering is the crash-safety
  // mechanism. This is deliberately NOT wrapped in a transaction: the
  // per-row P2002 dedup below can't survive a Postgres transaction abort
  // (the first constraint hit aborts the whole txn). If we voided first and
  // the process died before writing the clawbacks, a retry would re-snapshot
  // status='paid_out', find nothing (the rows are already 'voided'), and the
  // debt would be lost forever — the publisher keeps the overpayment. Writing
  // clawbacks first means a mid-flight crash leaves the originals still
  // paid_out, so the retry re-snapshots them and safely re-runs both steps;
  // already-written clawbacks no-op on the synthetic-key P2002.
  let clawbackCount = 0;
  for (const orig of paidOutRows) {
    // A clawback is itself a block_buzz_attribution row → bba_ id.
    const clawbackId = newBlockBuzzAttributionId();
    try {
      await dbWrite.blockBuzzAttribution.create({
        data: {
          id: clawbackId,
          userId: orig.userId,
          // buzz_amount has no meaning for a clawback; 0 keeps the
          // purchase non-negativity CHECK satisfied (it's scoped to
          // entry_type='purchase' but 0 is also valid for clawback).
          buzzAmount: 0,
          buzzType: orig.buzzType,
          usdAmountCents: -orig.appOwnerShareCents,
          paymentProvider,
          // Synthetic tx id so the (tx, app_block) UNIQUE both avoids
          // colliding with the original AND dedupes repeat refunds.
          paymentTransactionId: `${paymentTransactionId}${CLAWBACK_TX_SUFFIX}`,
          buzzTransactionId: null,
          appId: orig.appId,
          appBlockId: orig.appBlockId,
          blockInstanceId: orig.blockInstanceId,
          scope: orig.scope,
          modelId: orig.modelId,
          rateCardVersion: orig.rateCardVersion,
          appOwnerShareCents: -orig.appOwnerShareCents,
          platformShareCents: 0,
          providerFeeCents: 0,
          appOwnerUserId: orig.appOwnerUserId,
          // Confirmed so it's immediately nettable by the payout
          // aggregator. entry_type='clawback' marks it negative debt.
          status: 'confirmed',
          entryType: 'clawback',
          voidedReason: null,
          confirmedAt: new Date(),
        },
      });
      clawbackCount += 1;
    } catch (err) {
      // Duplicate clawback (second refund webhook for the same payment)
      // hits the synthetic-key UNIQUE → P2002. Skip, don't double-debit.
      const code = (err as { code?: unknown })?.code;
      if (code === 'P2002') continue;
      throw err;
    }
  }

  const result = await dbWrite.blockBuzzAttribution.updateMany({
    where: {
      paymentProvider,
      paymentTransactionId,
      status: { in: ['pending', 'confirmed', 'paid_out'] },
    },
    data: {
      status: 'voided',
      voidedReason: reason,
      voidedAt: new Date(),
    },
  });

  if (result.count > 0 || clawbackCount > 0) {
    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message:
          `voided ${result.count} attribution row(s) for ${paymentTransactionId}` +
          (clawbackCount > 0 ? ` + ${clawbackCount} clawback row(s)` : ''),
        paymentProvider,
        paymentTransactionId,
        reason,
        count: result.count,
        clawbackCount,
      },
      'webhooks'
    ).catch(() => null);
  }

  return result.count;
}

export type MintPayoutResult =
  | { minted: true; payoutId: string; totalCents: number; rowCount: number }
  | { minted: false; alreadyPaid: true }
  | { minted: false; carriedForwardCents: number; rowCount: number };

/**
 * Idempotently MINT a payout ledger entry for one publisher for one
 * period, and flip the contributing confirmed rows to paid_out — all in
 * a single transaction.
 *
 * IMPORTANT: this function moves NO money. It only writes the
 * block_attribution_payout ledger row and updates row state. Actual
 * disbursement (creator-program cash bank / Tipalti) is a separate,
 * leadership-gated step that reads these ledger rows. The bulk-payout
 * cron deliberately does NOT call this yet — see
 * bulk-payout-block-attributions.ts. Do not add withdrawCash / Tipalti
 * calls here.
 *
 * Idempotency: the (app_owner_user_id, period_key) UNIQUE on
 * block_attribution_payout means a racing or retried mint hits P2002 and
 * no-ops without re-flipping any rows.
 *
 * Carry-forward debt: clawback rows (entry_type='clawback',
 * status='confirmed') carry a NEGATIVE app_owner_share_cents, so the
 * aggregate net naturally subtracts them. If the net is <= 0 we mint
 * nothing and flip nothing — the (negative) debt stays as confirmed rows
 * and carries forward into the next period's aggregate.
 */
export async function mintPayoutForOwner({
  appOwnerUserId,
  periodKey,
}: {
  appOwnerUserId: number;
  periodKey: string;
}): Promise<MintPayoutResult> {
  return dbWrite.$transaction(async (tx: Prisma.TransactionClient): Promise<MintPayoutResult> => {
    // 1. Aggregate this owner's payable rows. status='confirmed'
    // naturally includes negative entry_type='clawback' rows, so the net
    // already accounts for carry-forward debt.
    const agg = await tx.blockBuzzAttribution.aggregate({
      where: { appOwnerUserId, status: 'confirmed' },
      _sum: { appOwnerShareCents: true },
      _count: true,
    });
    const netCents = agg._sum.appOwnerShareCents ?? 0;
    const rowCount = agg._count ?? 0;

    // 2. Non-positive net → don't mint, don't flip. Debt carries forward.
    if (netCents <= 0) {
      return { minted: false, carriedForwardCents: netCents, rowCount };
    }

    // 3. Mint the ledger row. The (owner, period) UNIQUE guards against
    // a double-pay; P2002 → idempotent no-op (do NOT flip rows again).
    const payoutId = newBlockAttributionPayoutId();
    try {
      await tx.blockAttributionPayout.create({
        data: {
          id: payoutId,
          appOwnerUserId,
          periodKey,
          totalCents: netCents,
          rowCount,
        },
      });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 'P2002') {
        return { minted: false, alreadyPaid: true };
      }
      throw err;
    }

    // 4. Flip the contributing confirmed rows → paid_out, stamping the
    // minted payout id. This also flips the negative clawback rows; their
    // debt is now realized in this period's total and won't re-net next
    // period.
    const flipped = await tx.blockBuzzAttribution.updateMany({
      where: { appOwnerUserId, status: 'confirmed' },
      data: {
        status: 'paid_out',
        paidOutAt: new Date(),
        payoutId,
      },
    });

    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `minted payout ${payoutId} for owner ${appOwnerUserId} (${periodKey})`,
        payoutId,
        appOwnerUserId,
        periodKey,
        totalCents: netCents,
        rowCount: flipped.count,
      },
      'webhooks'
    ).catch(() => null);

    return { minted: true, payoutId, totalCents: netCents, rowCount: flipped.count };
  });
}

/**
 * Refund window per provider. Used by the confirm-pending cron to
 * promote pending → confirmed only once the buyer can no longer
 * unilaterally refund through the provider.
 *
 * Stripe: 30 days for most disputes; cards in some regions allow
 * longer chargeback windows but those are handled separately.
 * Paddle: 14 days standard refund window per their merchant docs.
 * NOWPayments: crypto — no refund window in the bank sense; treat as
 * 24h to avoid the row sitting in pending forever.
 */
export const REFUND_WINDOWS_DAYS: Record<AttributionPaymentProvider, number> = {
  stripe: 30,
  paddle: 14,
  nowpayments: 1,
};

export { ACTIVE_RATE_CARD };

// ---------------------------------------------------------------
// Publisher reporting queries
// ---------------------------------------------------------------

export type RevenueSummaryBucket = {
  count: number;
  grossCents: number;
  shareCents: number;
};

export type RevenueSummary = {
  pending: RevenueSummaryBucket;
  confirmed: RevenueSummaryBucket;
  paidOut: RevenueSummaryBucket;
  voided: { count: number; grossCents: number };
};

/**
 * Aggregate revenue summary for a single publisher. Optionally
 * narrowed to one app_block and/or a date range. Used by the
 * publisher-facing /apps/[appBlockId]/revenue and /apps/revenue pages.
 */
export async function getRevenueForOwner({
  ownerUserId,
  appBlockId,
  from,
  to,
}: {
  ownerUserId: number;
  appBlockId?: string;
  from?: Date;
  to?: Date;
}): Promise<{ summary: RevenueSummary; topApps: Array<{ appBlockId: string; shareCents: number; count: number }> }> {
  const where = {
    appOwnerUserId: ownerUserId,
    ...(appBlockId ? { appBlockId } : {}),
    ...(from || to
      ? {
          attributedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };

  // One round-trip per status bucket. groupBy here keeps the query
  // cheap — it doesn't need to scan every row, just hit the
  // (app_owner_user_id, attributed_at) index. The four small queries
  // run in parallel.
  const [pending, confirmed, paidOut, voided, topApps] = await Promise.all([
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'pending' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'confirmed' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'paid_out' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'voided' },
      _sum: { usdAmountCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.groupBy({
      by: ['appBlockId'],
      where: { ...where, status: { in: ['confirmed', 'paid_out'] } },
      _sum: { appOwnerShareCents: true },
      _count: true,
      orderBy: { _sum: { appOwnerShareCents: 'desc' } },
      take: 5,
    }),
  ]);

  return {
    summary: {
      pending: {
        count: pending._count ?? 0,
        grossCents: pending._sum.usdAmountCents ?? 0,
        shareCents: pending._sum.appOwnerShareCents ?? 0,
      },
      confirmed: {
        count: confirmed._count ?? 0,
        grossCents: confirmed._sum.usdAmountCents ?? 0,
        shareCents: confirmed._sum.appOwnerShareCents ?? 0,
      },
      paidOut: {
        count: paidOut._count ?? 0,
        grossCents: paidOut._sum.usdAmountCents ?? 0,
        shareCents: paidOut._sum.appOwnerShareCents ?? 0,
      },
      voided: {
        count: voided._count ?? 0,
        grossCents: voided._sum.usdAmountCents ?? 0,
      },
    },
    topApps: (topApps as Array<{ appBlockId: string; _sum: { appOwnerShareCents: number | null }; _count: number }>).map((r) => ({
      appBlockId: r.appBlockId,
      shareCents: r._sum.appOwnerShareCents ?? 0,
      count: r._count,
    })),
  };
}

/**
 * Recent attributions for the publisher dashboard's activity feed.
 * Limited to the last 50 so the response stays small; the timeseries
 * chart uses the aggregate above instead of walking individual rows.
 */
export async function getRecentAttributionsForOwner({
  ownerUserId,
  appBlockId,
  limit = 50,
}: {
  ownerUserId: number;
  appBlockId?: string;
  limit?: number;
}) {
  return dbRead.blockBuzzAttribution.findMany({
    where: {
      appOwnerUserId: ownerUserId,
      ...(appBlockId ? { appBlockId } : {}),
    },
    orderBy: { attributedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      attributedAt: true,
      scope: true,
      buzzAmount: true,
      usdAmountCents: true,
      appOwnerShareCents: true,
      providerFeeCents: true,
      status: true,
      voidedReason: true,
      modelId: true,
      appBlockId: true,
      paymentProvider: true,
    },
  });
}
