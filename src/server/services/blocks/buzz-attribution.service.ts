import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  type BlockAttribution,
  type BlockAttributionScope,
} from '~/server/schema/blocks/attribution.schema';
import { newBlockBuzzAttributionId } from '~/server/utils/app-block-ids';
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

/**
 * Void an attribution row in response to a refund or chargeback. Called
 * from the refund/dispute webhook handlers. Idempotent — voiding an
 * already-voided row is a no-op.
 *
 * If the row was already paid out, we void it anyway and rely on the
 * payout reconciliation job to claw back the publisher share from
 * their next payout. The payout-id stays on the row for audit.
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

  if (result.count > 0) {
    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `voided ${result.count} attribution row(s) for ${paymentTransactionId}`,
        paymentProvider,
        paymentTransactionId,
        reason,
        count: result.count,
      },
      'webhooks'
    ).catch(() => null);
  }

  return result.count;
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
