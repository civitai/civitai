import type { Prisma } from '@prisma/client';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import {
  getMultiAccountTransactionsByPrefix,
  getTransactionByExternalId,
} from '~/server/services/buzz.service';
import { refundTransactionOnce } from '~/server/services/buzz-prefix-refund';
import { revokeCosmeticsFromUsers } from '~/server/services/cosmetic.service';
import { appendItemHistory } from '~/server/services/creator-shop.data';
import { createNotification } from '~/server/services/notification.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { withRetries } from '~/server/utils/errorHandling';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

/**
 * Refunds the buyers of a Creator Shop item that was withdrawn after it sold: rejected by a
 * moderator (the creator's payouts are reversed too), or archived while withheld (the platform
 * carries the refund). The trigger is `meta.withdrawnRefund`, written by the verdict or the
 * archive; this reads it, so the immediate call and the retry job do the same thing.
 *
 * Each reversal is the Buzz service's own refund of one transaction, recorded as
 * `refund-<transactionId>`, so a transaction is refunded at most once however often this runs.
 * A purchase is marked `refunded` only once every reversal it needs has landed, and the buyer
 * loses the cosmetic only then.
 */

const DESCRIPTION = 'Refund: Creator Shop item withdrawn';
const MONEY_RETRIES = 3;
const MONEY_RETRY_DELAY_MS = 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LedgerRow = {
  transactionId: string;
  externalTransactionId?: string | null;
  accountId: number;
  amount: number;
};

/**
 * A purchase's ledger rows: the buyer's debit per colour (`<P>-<accountType>`) and each payout
 * (`<P>:sell:<userId>:<colour>`). Sales before payouts were recorded under the prefix stored the
 * buyer charge's own id, with the single payout keyed by that id. Anything else is `other`, and
 * stops the purchase: only these shapes are reversed.
 */
export function classifyPurchaseLedger(
  purchase: { buzzTransactionId: string; userId: number; unitAmount: number },
  rows: LedgerRow[]
) {
  const P = purchase.buzzTransactionId;
  const debits: LedgerRow[] = [];
  const payouts: LedgerRow[] = [];
  const other: LedgerRow[] = [];
  for (const row of rows) {
    const ext = row.externalTransactionId ?? '';
    if (ext.startsWith(`${P}:sell:`)) payouts.push(row);
    else if (ext.startsWith(`${P}-`) && row.accountId === purchase.userId) debits.push(row);
    else if (ext === P && row.accountId === 0 && GUID.test(P)) payouts.push(row);
    else other.push(row);
  }
  if (!debits.length && GUID.test(P))
    debits.push({ transactionId: P, accountId: purchase.userId, amount: purchase.unitAmount });
  return { debits, payouts, other };
}

type PayoutFailure = { transactionId: string; amount: number; error: string };
type PurchaseOutcome =
  | {
      status: 'refunded';
      refunded: number;
      clawedBack: number;
      payoutFailures: PayoutFailure[];
    }
  | { status: 'failed'; error: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Refunds one transaction unless its `refund-<id>` is already on the ledger. */
async function refundOnce(transactionId: string) {
  if (await getTransactionByExternalId(`refund-${transactionId}`)) return;
  await withRetries(
    () => refundTransactionOnce(transactionId, DESCRIPTION),
    MONEY_RETRIES,
    MONEY_RETRY_DELAY_MS
  );
}

async function reversePurchase(
  purchase: { buzzTransactionId: string; userId: number; unitAmount: number },
  clawback: boolean
): Promise<PurchaseOutcome> {
  let rows: LedgerRow[];
  try {
    rows = await getMultiAccountTransactionsByPrefix(purchase.buzzTransactionId);
  } catch (error) {
    return { status: 'failed', error: messageOf(error) };
  }
  const { debits, payouts, other } = classifyPurchaseLedger(purchase, rows);
  if (other.length)
    return {
      status: 'failed',
      error: `unexpected transactions under the purchase: ${other.length}`,
    };
  const paid = debits.reduce((sum, t) => sum + t.amount, 0);
  if (paid !== purchase.unitAmount)
    return {
      status: 'failed',
      error: `debits ${paid} do not match the price ${purchase.unitAmount}`,
    };

  // The buyer first: until every debit is back the purchase stays owed and the job retries it.
  for (const t of debits) {
    try {
      await refundOnce(t.transactionId);
    } catch (error) {
      return { status: 'failed', error: messageOf(error) };
    }
  }
  // A payout that won't come back does not hold the buyer's refund: it is logged for a person to
  // finish, as a takedown does.
  let clawedBack = 0;
  const payoutFailures: PayoutFailure[] = [];
  for (const t of clawback ? payouts : []) {
    try {
      await refundOnce(t.transactionId);
      clawedBack += t.amount;
    } catch (error) {
      payoutFailures.push({
        transactionId: t.transactionId,
        amount: t.amount,
        error: messageOf(error),
      });
    }
  }
  return { status: 'refunded', refunded: paid, clawedBack, payoutFailures };
}

const logRefund = (level: 'info' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ level, name: 'creator-shop-withdrawn-refund', message, data }).catch(
    () => undefined
  );

/**
 * Runs the refund for one item. Serialised per item, so two verdicts landing together, or a
 * verdict and the job, refund once. Returns null when another run holds the item; the job picks
 * up whatever that run leaves. `limit` caps the purchases one run takes, oldest first, so a
 * request does not wait on an item with hundreds of sales.
 */
export async function refundWithdrawnShopItem(
  shopItemId: number,
  { limit }: { limit?: number } = {}
) {
  return withDistributedLock(
    { key: `creator-shop-withdrawn-refund:${shopItemId}`, ttl: 60, autoRenew: true, maxRetries: 0 },
    () => runWithdrawnRefund(shopItemId, limit)
  );
}

async function runWithdrawnRefund(shopItemId: number, limit?: number) {
  const item = await dbWrite.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: {
      id: true,
      title: true,
      cosmeticId: true,
      addedById: true,
      meta: true,
      cosmetic: { select: { createdById: true } },
    },
  });
  const meta = (item?.meta ?? {}) as CosmeticShopItemMeta;
  const marker = meta.withdrawnRefund;
  // A takedown refunds and claws back on its own terms. A pack's members are listed, and
  // withheld, on their own, so withdrawing the pack withholds nothing its buyers hold.
  if (!item || !marker || meta.takedown || item.cosmeticId == null)
    return { purchases: 0, refunded: 0, failures: 0 };

  const creatorId = item.cosmetic?.createdById ?? item.addedById;
  const purchases = await dbWrite.userCosmeticShopPurchases.findMany({
    where: {
      shopItemId,
      refunded: false,
      purchasedAt: { lte: new Date(marker.at) },
      // A creator buying their own item paid the platform; it is not a sale to refund.
      ...(creatorId ? { userId: { not: creatorId } } : {}),
    },
    select: { userId: true, buzzTransactionId: true, unitAmount: true },
    orderBy: { purchasedAt: 'asc' },
    take: limit,
  });

  const refunded: typeof purchases = [];
  const failures: { buzzTransactionId: string; userId: number; error: string }[] = [];
  const payoutFailures: (PayoutFailure & { buzzTransactionId: string })[] = [];
  let refundedValue = 0;
  let clawedBack = 0;
  let revoked = 0;
  for (const purchase of purchases) {
    const outcome =
      purchase.unitAmount === 0
        ? ({ status: 'refunded', refunded: 0, clawedBack: 0, payoutFailures: [] } as const)
        : await reversePurchase(purchase, marker.clawback);
    if (outcome.status === 'failed') {
      failures.push({ ...purchase, error: outcome.error });
      await logRefund('error', 'Purchase refund failed', { shopItemId, ...purchase, ...outcome });
      continue;
    }
    for (const failure of outcome.payoutFailures) {
      payoutFailures.push({ ...failure, buzzTransactionId: purchase.buzzTransactionId });
      await logRefund('error', 'Payout clawback failed', { shopItemId, ...purchase, ...failure });
    }
    // Taken back before the purchase is marked, so a run that dies in between is retried and a
    // refunded buyer never keeps it. Scoped to this purchase: a holding obtained any other way was
    // not paid for here.
    revoked += (
      await revokeCosmeticsFromUsers({
        userIds: [purchase.userId],
        cosmeticIds: [item.cosmeticId],
        claimKeys: [purchase.buzzTransactionId],
      })
    ).revoked;
    const { count } = await dbWrite.userCosmeticShopPurchases.updateMany({
      where: { buzzTransactionId: purchase.buzzTransactionId, refunded: false },
      data: { refunded: true },
    });
    if (!count) continue;
    refunded.push(purchase);
    refundedValue += outcome.refunded;
    clawedBack += outcome.clawedBack;
  }

  if (refunded.length) {
    for (const userId of new Set(refunded.map((p) => p.userId)))
      await createNotification({
        type: 'cosmetic-shop-item-refunded',
        userId,
        category: NotificationCategory.System,
        key: `cosmetic-shop-item-refunded:${shopItemId}:${userId}`,
        details: { title: item.title },
      }).catch(() => undefined);

    const latest = await dbWrite.cosmeticShopItem.findUnique({
      where: { id: shopItemId },
      select: { meta: true, status: true },
    });
    const latestMeta = (latest?.meta ?? {}) as CosmeticShopItemMeta;
    await dbWrite.cosmeticShopItem.update({
      where: { id: shopItemId },
      data: {
        meta: appendItemHistory(latestMeta, {
          at: new Date().toISOString(),
          userId: marker.userId,
          kind: 'refunded',
          status: latest?.status ?? CosmeticShopItemStatus.Archived,
          note: `${refunded.length} purchase(s), ${refundedValue} Buzz refunded; ${clawedBack} Buzz reversed from payouts`,
        }) as Prisma.InputJsonValue,
      },
    });
  }

  const summary = {
    shopItemId,
    trigger: marker.trigger,
    clawback: marker.clawback,
    purchases: purchases.length,
    refunded: refunded.length,
    refundedValue,
    clawedBack,
    revokedFrom: revoked,
    failures,
    payoutFailures,
  };
  if (purchases.length)
    await logRefund(
      failures.length || payoutFailures.length ? 'error' : 'info',
      'Withdrawn refund finished',
      summary
    );
  return { purchases: purchases.length, refunded: refunded.length, failures: failures.length };
}

/**
 * Retry for every item whose refund did not finish: a Buzz failure, a lock held elsewhere, or a
 * process that died mid-run. Due means the same purchases `runWithdrawnRefund` would select.
 */
export async function sweepWithdrawnShopRefunds({ limit = 50 }: { limit?: number } = {}) {
  const due = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT i.id
    FROM "CosmeticShopItem" i
    LEFT JOIN "Cosmetic" c ON c.id = i."cosmeticId"
    WHERE i.meta ? 'withdrawnRefund'
      AND NOT i.meta ? 'takedown'
      AND i."cosmeticId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "UserCosmeticShopPurchases" p
        WHERE p."shopItemId" = i.id
          AND NOT p.refunded
          AND p."purchasedAt" <= ((i.meta->'withdrawnRefund'->>'at')::timestamptz AT TIME ZONE 'UTC')
          AND p."userId" IS DISTINCT FROM COALESCE(c."createdById", i."addedById")
      )
    -- Newest first: an item whose purchases can never be reversed is logged on every run and
    -- must not hold the window against items still being worked through.
    ORDER BY (i.meta->'withdrawnRefund'->>'at') DESC
    LIMIT ${limit}
  `;

  let refunded = 0;
  let failures = 0;
  let busy = 0;
  for (const { id } of due) {
    const result = await refundWithdrawnShopItem(id);
    if (!result) busy++;
    else {
      refunded += result.refunded;
      failures += result.failures;
    }
  }
  return { items: due.length, refunded, failures, busy };
}
