import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { isPreview, isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import { computeCreatorShopSplit } from '~/server/schema/creator-shop.schema';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import {
  throwBadRequestError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import type { StickerSurface } from '~/shared/utils/sticker-token';
import {
  netNewStickerPlacements,
  STICKER_SURFACES,
  STICKER_TOPUP_CLAIM_KEY,
  STICKER_TOPUP_MAX_QUANTITY,
  stickerPricePerUseFromCosmeticData,
} from '~/shared/utils/sticker-token';

/**
 * Where a sticker was placed. Required, never inferred: DMs are free and
 * unlimited, so a caller that forgot to say where it was would silently get the
 * free path.
 */
/**
 * Where a sticker was placed. Required, never inferred: DMs are free and
 * unlimited, so a caller that forgot to say where it was would silently get the
 * free path. Per-surface behaviour lives in STICKER_SURFACES.
 */
export type { StickerSurface };

/**
 * Spends one use per placement, all-or-nothing.
 *
 * Holdings are locked `FOR UPDATE` before the balance is read, so two concurrent
 * submissions serialize rather than both passing a check against the same
 * balance. If the total across every holding can't cover the placements, nothing
 * is written.
 *
 * Pass the caller's `tx` whenever the spend accompanies a write. Committing
 * separately would debit uses and then lose the comment to any failure in
 * between; sharing the transaction makes the charge and the content atomic.
 */
export async function spendStickerUses({
  userId,
  surface,
  content,
  previousContent,
  tx,
}: {
  userId: number;
  surface: StickerSurface;
  content: string;
  previousContent?: string;
  tx?: Prisma.TransactionClient;
}) {
  if (!STICKER_SURFACES[surface].consumes) return new Map<number, number>();

  const delta = netNewStickerPlacements(
    content,
    previousContent ?? '',
    STICKER_SURFACES[surface].form
  );
  if (!delta.size) return delta;

  const spend = async (tx: Prisma.TransactionClient) => {
    // Sorted so concurrent submissions lock holdings in the same order. Looping
    // in content order lets two submissions sharing two stickers each take one
    // lock and wait on the other, which Postgres resolves by aborting one.
    for (const [cosmeticId, count] of [...delta].sort((a, b) => a[0] - b[0])) {
      // A user can hold several rows for one cosmetic — the PK is
      // [userId, cosmeticId, claimKey], so a purchase and a grant coexist.
      // FOR UPDATE serializes concurrent submissions against these rows, which
      // is what keeps the read-then-drain below safe.
      const holdings = await tx.$queryRaw<{ claimKey: string; remaining: number | null }[]>`
        SELECT "claimKey", "remaining"
        FROM "UserCosmetic"
        WHERE "userId" = ${userId} AND "cosmeticId" = ${cosmeticId}
        ORDER BY ("remaining" IS NULL) DESC, "remaining" DESC
        FOR UPDATE
      `;

      // An unlimited holding is inexhaustible, so nothing is spent.
      if (holdings.some((h) => h.remaining === null)) continue;

      const available = holdings.reduce((sum, h) => sum + (h.remaining ?? 0), 0);
      if (available < count)
        throw throwBadRequestError(
          "You don't have enough uses left on one of these stickers. Remove it or buy more."
        );

      // Drain across holdings rather than requiring one row to cover the whole
      // amount: "I own 4 uses and can't spend 3" is an incomprehensible failure,
      // and it gets likelier exactly as balances run low.
      let owed = count;
      for (const holding of holdings) {
        if (owed <= 0) break;
        const take = Math.min(holding.remaining ?? 0, owed);
        if (take <= 0) continue;
        await tx.$executeRaw`
          UPDATE "UserCosmetic"
          SET "remaining" = "remaining" - ${take}
          WHERE "userId" = ${userId}
            AND "cosmeticId" = ${cosmeticId}
            AND "claimKey" = ${holding.claimKey}
        `;
        owed -= take;
      }
    }
  };

  if (tx) await spend(tx);
  else await dbWrite.$transaction(spend);

  return delta;
}

/**
 * Append-only usage history. One row per placement, emitted only after the spend
 * has committed — a usage row for a charge that failed is worse than a missing
 * one. `charged` comes straight from `spendStickerUses`, so STICKER_SURFACES
 * stays the single source of truth for which surfaces record.
 *
 * Fire-and-forget: the authoritative balance is in Postgres, so a failed write
 * here must never fail the user's submission.
 */
export function recordStickerUsage({
  track,
  userId,
  charged,
  entityType,
  entityId,
}: {
  track?: { stickerUsage: (rows: StickerUsageRow[]) => Promise<unknown> };
  userId: number;
  charged: Map<number, number>;
  entityType: string;
  entityId: number;
}) {
  // DM placements are DELIBERATELY unlogged, not merely absent: chat is free, so
  // `charged` is empty there and this returns early. That is a privacy decision
  // (D25) — usage history is not collected for private conversations — and it
  // must not be "fixed" by logging uncharged placements.
  if (!track || !charged.size) return;

  // Preview deploys share CLICKHOUSE_TRACKER_URL with production but run against
  // the DEV database, so their `entityId`s are ids from a different database —
  // they'd land in the prod table pointing at unrelated comments, with no column
  // to tell them apart afterwards. Skipping the emit is deliberate: consumption
  // still happens, so stickers are fully testable in preview; only the history
  // is withheld. `isProd` alone is not enough — a preview IS NODE_ENV=production.
  if (!isProd || isPreview) return;

  const rows: StickerUsageRow[] = [];
  for (const [cosmeticId, count] of charged)
    for (let i = 0; i < count; i++) rows.push({ userId, cosmeticId, entityType, entityId });

  void track.stickerUsage(rows).catch((error) =>
    logToAxiom(
      {
        type: 'error',
        name: 'sticker-usage-track-failed',
        userId,
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined)
  );
}

export type StickerUsageRow = {
  userId: number;
  cosmeticId: number;
  entityType: string;
  entityId: number;
};

/**
 * Buys N additional uses of a sticker the way the picker offers them: at the
 * price the creator set on the cosmetic, credited to the existing balance.
 *
 * Keyed on the COSMETIC, not a shop item. Resale by reference means one sticker
 * can be listed at several prices, and a use has to cost the same whichever
 * listing the buyer originally came through. The shop item is still loaded —
 * it decides whether the sticker is still sold at all, and whether the creator
 * accepts Blue Buzz.
 */
export async function purchaseStickerUses({
  userId,
  cosmeticId,
  quantity,
  payWith = 'default',
  buzzType = 'yellow',
  stickersEnabled,
}: {
  userId: number;
  cosmeticId: number;
  quantity: number;
  payWith?: 'default' | 'blue-first';
  buzzType?: BuzzSpendType;
  stickersEnabled?: boolean;
}) {
  // Refused here, not merely hidden: the picker and every listing filter
  // stickers when the flag is off, but a filtered list is not a refusal and this
  // mutation takes a cosmetic id.
  if (!stickersEnabled) throw throwBadRequestError('Stickers are not available yet');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > STICKER_TOPUP_MAX_QUANTITY)
    throw throwBadRequestError(`You can buy between 1 and ${STICKER_TOPUP_MAX_QUANTITY} uses`);

  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id: cosmeticId },
    select: { id: true, name: true, type: true, createdById: true, data: true },
  });
  if (!cosmetic) throw throwNotFoundError('Sticker not found');
  if (cosmetic.type !== CosmeticType.Sticker)
    throw throwBadRequestError('Only stickers are sold by the use');

  // Never derived from the list price: a sticker priced before per-use pricing
  // existed has no top-up price, and inventing one would charge a number its
  // creator never chose.
  const pricePerUse = stickerPricePerUseFromCosmeticData(cosmetic.data);
  if (!pricePerUse)
    throw throwBadRequestError('This sticker does not sell additional uses right now');

  // Delisted stickers can still be topped up — delisting stops NEW sales, and
  // stranding someone who already paid punishes them for the creator's
  // decision. Archived (and never-published) cannot: withdrawn is withdrawn.
  const listing = await dbRead.cosmeticShopItem.findFirst({
    where: { cosmeticId, status: CosmeticShopItemStatus.Published },
    orderBy: { id: 'asc' },
    select: { id: true, meta: true, addedById: true },
  });
  if (!listing) throw throwBadRequestError('This sticker is no longer available');

  // Same block semantics as buying the sticker outright, and the same generic
  // error so the block isn't revealed.
  if (cosmetic.createdById) {
    const blockedPairIds = await getBlockedPairIds(userId);
    const sellerIds = [cosmetic.createdById, listing.addedById].filter(
      (id): id is number => id != null
    );
    if (sellerIds.some((id) => blockedPairIds.includes(id)))
      throw throwBadRequestError('This sticker is no longer available');
  }

  // Read on the writer: the replica can lag, and both checks below decide
  // whether to charge.
  const holdings = await dbWrite.userCosmetic.findMany({
    where: { userId, cosmeticId },
    select: { remaining: true },
  });
  // A top-up refills; it does not acquire. Granting a holding to someone who
  // owns none would sell the sticker itself outside the shop — past a sold-out
  // `availableQuantity`, past the listing's own purchase guards.
  if (!holdings.length)
    throw throwBadRequestError('Buy this sticker before buying more uses of it');
  // An unlimited holding is inexhaustible, so there is nothing to top up and
  // charging for one would be selling a balance that can never be spent.
  if (holdings.some((h) => h.remaining === null))
    throw throwBadRequestError('You already have unlimited uses of this sticker');

  const listingMeta = (listing.meta ?? {}) as CosmeticShopItemMeta;
  // Blue is a per-item creator opt-in on the listing, exactly as it is when
  // buying the sticker — read from there rather than given a rule of its own.
  if (payWith !== 'default' && !listingMeta.acceptsBlueBuzz)
    throw throwBadRequestError('This creator does not accept Blue Buzz');
  const fromAccountTypes: BuzzSpendType[] =
    payWith === 'blue-first' ? ['blue', buzzType] : [buzzType];

  const amount = pricePerUse * quantity;
  const transactionId = `sticker-topup-${userId}-${cosmeticId}-${Date.now()}`;
  const transaction = await createMultiAccountBuzzTransaction({
    fromAccountId: userId,
    fromAccountTypes,
    toAccountId: 0,
    amount,
    type: TransactionType.Purchase,
    description: `Sticker uses - ${cosmetic.name}`,
    externalTransactionIdPrefix: transactionId,
  });
  if (!transaction.transactionCount)
    throw throwBadRequestError('There was an error creating the transaction');
  const bluePaid = transaction.transactionIds
    .filter((t) => t.accountType === 'blue')
    .reduce((sum, t) => sum + t.amount, 0);

  let remaining: number;
  try {
    // COALESCE rather than a Prisma `increment`: adding to a NULL balance yields
    // NULL in Postgres, which reads as unlimited.
    const [row] = await dbWrite.$queryRaw<{ remaining: number }[]>`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "remaining")
      VALUES (${userId}, ${cosmeticId}, ${STICKER_TOPUP_CLAIM_KEY}, ${quantity})
      ON CONFLICT ("userId", "cosmeticId", "claimKey")
      DO UPDATE SET "remaining" = COALESCE("UserCosmetic"."remaining", 0) + ${quantity}
      RETURNING "remaining"
    `;
    remaining = row?.remaining ?? quantity;
  } catch (error) {
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: transactionId,
      description: `Failed to buy sticker uses - ${cosmetic.name}`,
    });
    throw throwBadRequestError('Failed to buy sticker uses');
  }

  await refreshOwnedStickerCache([userId]);

  // Payout follows the sale, never the buyer's own money back: a creator
  // topping up their own sticker would otherwise round-trip 70% through the
  // bank and burn the other 30% to move Buzz to themselves.
  const creatorId = cosmetic.createdById;
  if (creatorId && creatorId !== userId) {
    try {
      await withRetries(async () => {
        // A top-up is the buyer returning to the maker directly, so it pays the
        // creator's full pool — no seller share, since no reseller drove it.
        const { creatorPool } = computeCreatorShopSplit(amount, 0);
        const blueAmount = amount > 0 ? Math.floor((creatorPool * bluePaid) / amount) : 0;
        const payouts = [
          { amount: blueAmount, color: 'blue' as BuzzSpendType },
          { amount: creatorPool - blueAmount, color: buzzType },
        ].filter((p) => p.amount > 0);

        await Promise.all(
          payouts.map((p) =>
            createBuzzTransaction({
              fromAccountId: 0,
              toAccountId: creatorId,
              toAccountType: p.color,
              amount: p.amount,
              type: TransactionType.Sell,
              description: `A user has bought more uses of your sticker - ${cosmetic.name}`,
              externalTransactionId: `${transactionId}:sell:${creatorId}:${p.color}`,
              details: { purchasedBy: userId, originalAmount: amount, quantity },
            })
          )
        );
      }, 3);
    } catch (error) {
      // The buyer already has their uses; a failed payout is recoverable from
      // the ledger and must not undo the purchase.
      logToAxiom({
        level: 'error',
        message: 'Failed to distribute sticker top-up funds',
        data: { cosmeticId, userId, transactionId, error },
      });
    }
  }

  return { cosmeticId, quantity, pricePerUse, amount, remaining };
}

/** Remaining balance per owned sticker; NULL entries are unlimited. */
export async function getStickerBalances(userId: number) {
  // SUM, not MAX: spending drains across holdings, so the spendable balance is
  // the total. A NULL holding is unlimited and wins outright — bool_or gives
  // that in the same pass rather than a second query.
  const rows = await dbRead.$queryRaw<
    { cosmeticId: number; remaining: number | null; unlimited: boolean }[]
  >`
    SELECT
      uc."cosmeticId",
      SUM(uc."remaining")::int AS "remaining",
      bool_or(uc."remaining" IS NULL) AS "unlimited"
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    WHERE uc."userId" = ${userId} AND c.type = 'Sticker'::"CosmeticType"
    GROUP BY uc."cosmeticId"
  `;

  return rows.map(({ cosmeticId, remaining, unlimited }) => ({
    cosmeticId,
    // null = unlimited, which is every non-consumable holding.
    remaining: unlimited ? null : remaining ?? 0,
  }));
}
