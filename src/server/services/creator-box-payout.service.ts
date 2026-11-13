import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { computeCreatorShopSplit } from '~/server/schema/creator-shop.schema';
import type { CosmeticPurchaseMeta } from '~/server/schema/cosmetic-shop.schema';
import {
  createBuzzTransaction,
  getMultiAccountTransactionsByPrefix,
} from '~/server/services/buzz.service';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { throwBadRequestError, withRetries } from '~/server/utils/errorHandling';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';

const NOT_AVAILABLE = 'This box is not available';

/**
 * Whether a creator's box may be sold to this buyer. Every refusal but self-buy shares the generic
 * message, so a block or a seller's restriction isn't revealed.
 */
export async function assertCreatorBoxSellable({
  sellerId,
  buyerId,
  enabled,
  isPack,
  buzzType,
}: {
  sellerId: number;
  buyerId: number;
  /** `creatorMysteryPacksEnabled(features)`. */
  enabled: boolean | undefined;
  isPack: boolean;
  buzzType: BuzzSpendType;
}) {
  if (!enabled) throw throwBadRequestError(NOT_AVAILABLE);
  if (sellerId === buyerId) throw throwBadRequestError("You can't buy your own mystery pack");
  // Creator listings never carry pack terms; a payout is one creator's share of one box.
  if (isPack) throw throwBadRequestError(NOT_AVAILABLE);
  // The payout is paid in the colour charged, and Blue would need the shelf's proration.
  if (buzzType === 'blue') throw throwBadRequestError(NOT_AVAILABLE);
  // A call-site import: that module imports the box service, which imports this one.
  const { creatorIsRestricted } = await import('~/server/services/creator-mystery-pack.service');
  if (await creatorIsRestricted(dbWrite, sellerId)) throw throwBadRequestError(NOT_AVAILABLE);
  if ((await getBlockedPairIds(buyerId)).includes(sellerId))
    throw throwBadRequestError(NOT_AVAILABLE);
}

export type CreatorBoxSale = {
  buzzTransactionId: string;
  buyerId: number;
  sellerId: number;
  unitAmount: number;
  /** The one account the buyer was charged from. */
  color: BuzzSpendType;
  title: string;
};

/**
 * Pays the creator their pool for one box sale and records it in the purchase's `meta.payouts`, the
 * shape the takedown and refunds reverse by transaction id. Safe to repeat: the external id is fixed
 * per sale, a duplicate is answered 409 and read back from the purchase's ledger.
 */
export async function payCreatorBoxSale(sale: CreatorBoxSale) {
  const { creatorPool, platformCut } = computeCreatorShopSplit(sale.unitAmount);
  const externalTransactionId = `${sale.buzzTransactionId}:sell:${sale.sellerId}:${sale.color}`;
  let transactionId: string | undefined;
  try {
    const payout = await createBuzzTransaction({
      fromAccountId: 0,
      toAccountId: sale.sellerId,
      toAccountType: sale.color,
      amount: creatorPool,
      type: TransactionType.Sell,
      description: `A user has bought your mystery pack - ${sale.title}`,
      externalTransactionId,
      details: { purchasedBy: sale.buyerId, originalAmount: sale.unitAmount },
    });
    transactionId = payout.transactionId ?? undefined;
  } catch (error) {
    if (getBuzzApiStatus(error) !== 409) throw error;
    transactionId = (await getMultiAccountTransactionsByPrefix(sale.buzzTransactionId)).find(
      (leg) => leg.externalTransactionId === externalTransactionId
    )?.transactionId;
    if (!transactionId)
      throw new Error(`Payout ${externalTransactionId} answered 409 but is not listed`);
  }
  const meta: CosmeticPurchaseMeta = {
    payouts: [{ userId: sale.sellerId, amount: creatorPool, color: sale.color, transactionId }],
    platformCut,
  };
  // Merged: the purchase's meta may already hold other keys.
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases" p
    SET meta = ${asJsonbObjectSql('p.meta')} || ${JSON.stringify(meta)}::jsonb
    WHERE p."buzzTransactionId" = ${sale.buzzTransactionId}`;
}

const logPayout = (level: 'info' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ level, name: 'creator-box-payout', message, data }).catch(() => undefined);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Never throws: the buyer has their box, and the sweep pays a sale this leaves unrecorded. */
export async function payCreatorBoxSaleAfterGrant(sale: CreatorBoxSale) {
  try {
    await withRetries(() => payCreatorBoxSale(sale), 3, 1000);
  } catch (error) {
    await logPayout('error', 'Creator box payout failed; the sweep retries it', {
      ...sale,
      error: errorMessage(error),
    });
  }
}

const SWEEP_BATCH = 100;

/**
 * Pays every creator-box sale whose payout isn't recorded: the purchase's own attempt failed, or the
 * process died between the grant and the payout. Refunded purchases are left alone.
 */
export async function sweepCreatorBoxPayouts({ limit = SWEEP_BATCH }: { limit?: number } = {}) {
  const sales = await dbWrite.$queryRaw<
    {
      buzzTransactionId: string;
      buyerId: number;
      sellerId: number;
      unitAmount: number;
      title: string;
    }[]
  >`
    SELECT p."buzzTransactionId", p."userId" AS "buyerId", d."sellerId", p."unitAmount", s.title
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id
    WHERE d."sellerId" IS NOT NULL
      AND NOT p.refunded
      -- Old enough that the purchase's own payout attempt is over.
      AND p."purchasedAt" < now() - interval '10 minutes'
      AND p.meta -> 'payouts' IS NULL
    ORDER BY p."purchasedAt"
    LIMIT ${limit}`;

  let paid = 0;
  const failed: { buzzTransactionId: string; error: string }[] = [];
  for (const sale of sales) {
    try {
      // The colour the buyer was charged in, from the ledger: the purchase row doesn't record it.
      const debits = (await getMultiAccountTransactionsByPrefix(sale.buzzTransactionId)).filter(
        (leg) =>
          leg.accountId === sale.buyerId &&
          (leg.externalTransactionId ?? '').startsWith(`${sale.buzzTransactionId}-`)
      );
      const colors = [...new Set(debits.map((leg) => leg.accountType))];
      if (colors.length !== 1)
        throw new Error(`Charge has ${colors.length} account types; pay it by hand`);
      await payCreatorBoxSale({ ...sale, color: colors[0] as BuzzSpendType });
      paid++;
    } catch (error) {
      failed.push({ buzzTransactionId: sale.buzzTransactionId, error: errorMessage(error) });
    }
  }
  if (failed.length || paid)
    await logPayout(failed.length ? 'error' : 'info', 'Creator box payout sweep', {
      found: sales.length,
      paid,
      failed,
    });
  return { found: sales.length, paid, failed };
}
