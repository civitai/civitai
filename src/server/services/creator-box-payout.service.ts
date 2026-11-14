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
import { refundTransactionOnce } from '~/server/services/buzz-prefix-refund';
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
  enabled: boolean | undefined;
  isPack: boolean;
  buzzType: BuzzSpendType;
}) {
  if (!enabled) throw throwBadRequestError(NOT_AVAILABLE);
  if (sellerId === buyerId) throw throwBadRequestError("You can't buy your own mystery pack");
  // Pack terms would split one payout across several boxes.
  if (isPack) throw throwBadRequestError(NOT_AVAILABLE);
  // The payout is paid in the colour charged, and Blue would need the shelf's proration.
  if (buzzType === 'blue') throw throwBadRequestError(NOT_AVAILABLE);
  // A call-site import: that module imports the box service, which imports this one.
  const { creatorIsRestricted } = await import('~/server/services/creator-mystery-pack.service');
  if (await creatorIsRestricted(dbWrite, sellerId)) throw throwBadRequestError(NOT_AVAILABLE);
  if ((await getBlockedPairIds(buyerId)).includes(sellerId))
    throw throwBadRequestError(NOT_AVAILABLE);
}

/** The one account a charge was debited from, or undefined when it is none or several. */
export function singleColorOf(legs: { accountType: string }[]) {
  const colors = new Set(legs.map((leg) => leg.accountType));
  return colors.size === 1 ? ([...colors][0] as BuzzSpendType) : undefined;
}

export type CreatorBoxSale = {
  buzzTransactionId: string;
  buyerId: number;
  sellerId: number;
  unitAmount: number;
  color: BuzzSpendType;
  title: string;
};

/**
 * Records the payout in `meta.payouts`, the shape the takedown and refunds reverse by transaction id.
 * Idempotent: the external id is fixed per sale and a 409 is read back from the ledger.
 */
export async function payCreatorBoxSale(sale: CreatorBoxSale): Promise<'paid' | 'reversed'> {
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
  // Only onto an unrefunded sale. A refund flips `refunded` before it reads `meta.payouts`, and the
  // row lock orders the two writes: either it sees this payout, or this sees its flip and reverses.
  const recorded = await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases" p
    SET meta = ${asJsonbObjectSql('p.meta')} || ${JSON.stringify(meta)}::jsonb
    WHERE p."buzzTransactionId" = ${sale.buzzTransactionId} AND NOT p.refunded`;
  if (recorded) return 'paid';
  if (!transactionId)
    throw new Error(
      `Payout ${externalTransactionId} landed on a refunded sale with no id to reverse`
    );
  // Owed until `doneAt`, so the sweep finishes a reversal that fails here.
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases" p
    SET meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
      'payoutReversal', jsonb_build_object('transactionId', ${transactionId}::text, 'at', now())
    )
    WHERE p."buzzTransactionId" = ${sale.buzzTransactionId}`;
  await reversePayout(sale.buzzTransactionId, transactionId, sale.title);
  return 'reversed';
}

async function reversePayout(buzzTransactionId: string, transactionId: string, title: string) {
  await refundTransactionOnce(transactionId, `Refund: mystery pack sale refunded - ${title}`);
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(meta, '{payoutReversal,doneAt}', to_jsonb(now()))
    WHERE "buzzTransactionId" = ${buzzTransactionId}`;
}

const logPayout = (level: 'info' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ level, name: 'creator-box-payout', message, data }).catch(() => undefined);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Never throws: the buyer has their box, and the sweep pays a sale this leaves unrecorded. */
export async function payCreatorBoxSaleAfterGrant(sale: CreatorBoxSale) {
  try {
    await withRetries(() => payCreatorBoxSale(sale), 3, 1000);
  } catch (error) {
    await logPayout('error', 'Creator box payout failed or not reversed; the sweep retries it', {
      ...sale,
      error: errorMessage(error),
    });
  }
}

const SWEEP_BATCH = 100;

/**
 * Pays every creator-box sale whose payout isn't recorded: the purchase's own attempt failed, or the
 * process died between the grant and the payout.
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
    -- A sale that failed before goes behind the rest, so stuck ones never fill the batch.
    ORDER BY p.meta -> 'payoutAttempt' ->> 'at' NULLS FIRST, p."purchasedAt"
    LIMIT ${limit}`;

  let paid = 0;
  let reversed = 0;
  const failed: { buzzTransactionId: string; error: string }[] = [];
  for (const sale of sales) {
    try {
      // The colour the buyer was charged in, from the ledger: the purchase row doesn't record it.
      const debits = (await getMultiAccountTransactionsByPrefix(sale.buzzTransactionId)).filter(
        (leg) =>
          leg.accountId === sale.buyerId &&
          (leg.externalTransactionId ?? '').startsWith(`${sale.buzzTransactionId}-`)
      );
      const color = singleColorOf(debits);
      if (!color) throw new Error('The charge is not from exactly one account; pay it by hand');
      if ((await payCreatorBoxSale({ ...sale, color })) === 'paid') paid++;
      else reversed++;
    } catch (error) {
      const message = errorMessage(error);
      failed.push({ buzzTransactionId: sale.buzzTransactionId, error: message });
      await dbWrite.$executeRaw`
        UPDATE "UserCosmeticShopPurchases" p
        SET meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
          'payoutAttempt', jsonb_build_object('at', now(), 'error', ${message}::text)
        )
        WHERE p."buzzTransactionId" = ${sale.buzzTransactionId}`.catch(() => undefined);
    }
  }
  // Payouts that landed on a sale refunded meanwhile and whose reversal failed.
  const owedReversals = await dbWrite.$queryRaw<
    { buzzTransactionId: string; transactionId: string; title: string }[]
  >`
    SELECT p."buzzTransactionId", p.meta -> 'payoutReversal' ->> 'transactionId' AS "transactionId",
      s.title
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id
    WHERE d."sellerId" IS NOT NULL AND p.refunded
      AND p.meta -> 'payoutReversal' IS NOT NULL
      AND p.meta -> 'payoutReversal' ->> 'doneAt' IS NULL
    LIMIT ${limit}`;
  for (const owed of owedReversals) {
    try {
      await reversePayout(owed.buzzTransactionId, owed.transactionId, owed.title);
      reversed++;
    } catch (error) {
      failed.push({ buzzTransactionId: owed.buzzTransactionId, error: errorMessage(error) });
    }
  }
  if (failed.length)
    await logPayout('error', 'Creator box payout sweep left sales unpaid', {
      found: sales.length,
      paid,
      failed,
    });
  return { found: sales.length, paid, reversed, failed };
}
