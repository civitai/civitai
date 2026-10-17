import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  assertEventShopItemPurchasable,
  getEventBuyerTeam,
  isEventShopItemData,
} from '~/server/events/event-shop-item';
import { logToAxiom } from '~/server/logging/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import {
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import {
  countHeldItems,
  findHeldItemBySource,
  grantItem,
  ITEM_DEFINITION_STATUS,
  ITEM_TYPE,
} from '~/server/services/item.service';
import { lockItemHolder } from '~/server/services/item-holder-lock';
import {
  beginShopPurchase,
  chargeForShopPurchase,
  chargeRetryOptions,
  claimShopPurchase,
  markClaimPaid,
  purchaseStateUnknown,
  refundCallOptions,
  refundClaimedCharge,
  resumeShopPurchase,
  runPurchaseChecks,
  SHOP_PURCHASE_CLAIM_STATUS,
  shopPurchaseTransactionId,
} from '~/server/services/shop-purchase-charge';
import { isPrismaUniqueViolation, throwBadRequestError } from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

/**
 * Countries where mystery boxes are not shown or sold: a `KeyValue` row holding a JSON array of
 * ISO country codes. Ops edit it with no deploy; absent means none.
 */
export const MYSTERY_BOX_BLOCKED_REGIONS_KEY = 'mysteryBox:blockedRegions';

/**
 * The blocked country codes, upper-cased. Throws on a value that is not an array of strings: the
 * list is a legal control, so a malformed one refuses boxes everywhere rather than nowhere.
 */
export async function getMysteryBoxBlockedRegions(): Promise<string[]> {
  const row = await dbRead.keyValue.findUnique({
    where: { key: MYSTERY_BOX_BLOCKED_REGIONS_KEY },
    select: { value: true },
  });
  if (!row) return [];
  const value = row.value;
  if (!Array.isArray(value) || !value.every((code) => typeof code === 'string')) {
    logToAxiom({
      type: 'error',
      name: 'mystery-box',
      message: `${MYSTERY_BOX_BLOCKED_REGIONS_KEY} is not an array of country codes`,
      value,
    });
    throw throwBadRequestError('Mystery boxes are not available right now');
  }
  return value.map((code) => code.trim().toUpperCase());
}

/** A visitor with no known country is blocked whenever any country is. */
export function isMysteryBoxBlockedIn(countryCode: string | null | undefined, blocked: string[]) {
  if (!blocked.length) return false;
  if (!countryCode) return true;
  return blocked.includes(countryCode.toUpperCase());
}

export type BoxPoolEntry = {
  contentId: number;
  tierId: number;
  rewardDefinitionId: number;
  cosmeticId: number;
};

/**
 * What this box can still give this user: its enabled contents, less any cosmetic made for another
 * team than `team`, less any cosmetic the user owns from any source. Read inside a transaction
 * holding `lockItemHolder` for the user when the answer decides a grant or a claim.
 *
 * v1 boxes hold cosmetics only; any other reward kind is left out here and refused at purchase
 * (`assertBoxSellable`).
 */
export async function getBoxPoolForUser(
  client: Prisma.TransactionClient,
  { boxDefinitionId, userId, team }: { boxDefinitionId: number; userId: number; team?: string }
): Promise<BoxPoolEntry[]> {
  const contents = await client.boxContent.findMany({
    where: { boxDefinitionId, enabled: true },
    select: {
      id: true,
      tierId: true,
      rewardDefinitionId: true,
      reward: { select: { type: true, cosmeticId: true, cosmetic: { select: { data: true } } } },
    },
  });

  const forTeam = contents.flatMap((content) => {
    const { cosmeticId, cosmetic, type } = content.reward;
    if (type !== ITEM_TYPE.cosmetic || cosmeticId == null) return [];
    // A cosmetic made for a team goes only to that team's members; a buyer with no team gets none.
    const cosmeticTeam = (cosmetic?.data as { team?: unknown } | null)?.team;
    if (typeof cosmeticTeam === 'string' && cosmeticTeam !== team) return [];
    return [
      {
        contentId: content.id,
        tierId: content.tierId,
        rewardDefinitionId: content.rewardDefinitionId,
        cosmeticId,
      },
    ];
  });
  if (!forTeam.length) return [];

  const owned = await client.userCosmetic.findMany({
    where: { userId, cosmeticId: { in: forTeam.map((entry) => entry.cosmeticId) } },
    select: { cosmeticId: true },
  });
  const ownedIds = new Set(owned.map((row) => row.cosmeticId));
  return forTeam.filter((entry) => !ownedIds.has(entry.cosmeticId));
}

/**
 * Refuses a box with any enabled reward that is not a cosmetic. Buzz rewards in a sold box need
 * counsel first, and a box inside a box has no open path.
 */
async function assertBoxSellable(client: Prisma.TransactionClient, boxDefinitionId: number) {
  const other = await client.boxContent.count({
    where: { boxDefinitionId, enabled: true, reward: { type: { not: ITEM_TYPE.cosmetic } } },
  });
  if (other > 0) throw throwBadRequestError('This box is not available');
}

type BoxParams = { event?: unknown };

export type MysteryBoxShopItem = {
  id: number;
  itemDefinitionId: number;
  status: CosmeticShopItemStatus;
  availableQuantity: number | null;
  availableFrom: Date | null;
  availableTo: Date | null;
  unitAmount: number;
  title: string;
  meta: CosmeticShopItemMeta;
  _count: { purchases: number };
};

export type MysteryBoxPurchaseResult = {
  kind: 'box';
  /** The held box's `Item.id`, as a string: it is a BIGINT. */
  boxItemId: string;
  boxDefinitionId: number;
};

/**
 * Buys one mystery box: the shop's claim-first purchase, granting a held box `Item` keyed on the
 * claim. Opening it is separate and moves no money.
 *
 * Every refusal comes before the claim. The availability check (the box still has something left
 * for the buyer beyond the boxes they hold and the purchases they have pending) runs under the
 * buyer's item-holder lock, and the claim is written before that lock is released, so two tabs
 * cannot both buy the last thing left for them.
 */
export async function purchaseMysteryBox({
  userId,
  isModerator,
  shopItem,
  idempotencyKey,
  expectedUnitAmount,
  expectedVersion,
  payWith = 'default',
  buzzType,
  mysteryBoxEnabled,
  countryCode,
}: {
  userId: number;
  isModerator?: boolean;
  shopItem: MysteryBoxShopItem;
  idempotencyKey: string | undefined;
  expectedUnitAmount: number | undefined;
  expectedVersion: number | undefined;
  payWith?: 'default' | 'blue-first';
  buzzType: BuzzSpendType;
  mysteryBoxEnabled: boolean | undefined;
  countryCode: string | null | undefined;
}): Promise<MysteryBoxPurchaseResult> {
  const shopItemId = shopItem.id;
  const boxDefinitionId = shopItem.itemDefinitionId;

  // A retry of a purchase that completed answers with the box it granted, so a buy-and-open whose
  // response was lost can still open it. An opened box is gone, and the claim answers below.
  if (idempotencyKey) {
    const sourceKey = shopPurchaseTransactionId('box', userId, shopItemId, idempotencyKey);
    const held = await findHeldItemBySource(dbWrite, { sourceKey, userId });
    if (held)
      return { kind: 'box', boxItemId: held.id.toString(), boxDefinitionId: held.itemDefinitionId };
  }

  const box = await dbWrite.itemDefinition.findUnique({
    where: { id: boxDefinitionId },
    select: { id: true, type: true, status: true, version: true, params: true },
  });

  const start = await beginShopPurchase({
    kind: 'box',
    userId,
    shopItemId,
    idempotencyKey,
    amount: shopItem.unitAmount,
  });
  const { transactionId, existingClaim, pendingClaim, chargedBefore } = start;
  const claimContext = (amount: number) => ({ shopItemId, userId, transactionId, amount });

  // Whether this box may be sold to this buyer at all. Asked again on a retry: a kill switch or a
  // region block still wins, as state unknown.
  const event = await runPurchaseChecks(pendingClaim, async () => {
    if (!mysteryBoxEnabled) throw throwBadRequestError('This box is not available');
    // Box listings are unlisted by design, so `listed` is not asked.
    if (shopItem.status !== CosmeticShopItemStatus.Published)
      throw throwBadRequestError('This box is not available');
    if (!box || box.type !== ITEM_TYPE.box || box.status !== ITEM_DEFINITION_STATUS.published)
      throw throwBadRequestError('This box is not available');

    if (isMysteryBoxBlockedIn(countryCode, await getMysteryBoxBlockedRegions()))
      throw throwBadRequestError('Mystery boxes are not available in your region');

    // Paid Buzz only, event box or not.
    if (payWith !== 'default') throw throwBadRequestError("This box can't be bought with Blue Buzz");

    const params = (box.params ?? {}) as BoxParams;
    if (!isEventShopItemData(params)) return undefined;
    await assertEventShopItemPurchasable({
      userId,
      isModerator,
      // The event only: a box is sold to every team, and draws from the buyer's.
      data: { event: params.event },
      payWith,
      resumingClaim: chargedBefore,
    });
    return params.event;
  });
  // Narrowed by the checks above.
  if (!box) throw throwBadRequestError('This box is not available');

  // Today's stock, sale window, price and box version. A claim that was charged passed them when it
  // was made; any other request is held to them.
  await runPurchaseChecks(pendingClaim, async () => {
    if (chargedBefore) return;
    if (
      shopItem.availableQuantity !== null &&
      shopItem._count.purchases >= shopItem.availableQuantity
    )
      throw throwBadRequestError('This box is sold out');
    if (shopItem.availableFrom && shopItem.availableFrom > new Date())
      throw throwBadRequestError('This box is not available yet');
    if (shopItem.availableTo && shopItem.availableTo < new Date())
      throw throwBadRequestError('This box is no longer available');

    const confirmed = existingClaim ? existingClaim.amount : expectedUnitAmount;
    if (confirmed !== undefined && confirmed !== shopItem.unitAmount)
      throw throwBadRequestError(
        `The price changed to ${shopItem.unitAmount} Buzz. Check the new price and try again.`
      );

    // The buyer was shown this version's contents and odds.
    if (expectedVersion !== box.version)
      throw throwBadRequestError("This box's contents changed. Check them and try again.");
  });

  const team = event
    ? await runPurchaseChecks(pendingClaim, () => getEventBuyerTeam(event, userId))
    : undefined;

  const claim = await dbWrite.$transaction(async (tx) => {
    await lockItemHolder(tx, userId);
    if (!chargedBefore)
      await runPurchaseChecks(pendingClaim, async () => {
        await assertBoxSellable(tx, box.id);
        const left = (await getBoxPoolForUser(tx, { boxDefinitionId: box.id, userId, team }))
          .length;
        const held = await countHeldItems(tx, { itemDefinitionId: box.id, userId });
        const pending = await countPendingBoxClaims(tx, {
          boxDefinitionId: box.id,
          userId,
          exceptTransactionId: transactionId,
        });
        if (left <= held + pending)
          throw throwBadRequestError(
            held + pending > 0
              ? 'Your unopened boxes already cover everything left in this box'
              : "You've collected everything in this box"
          );
      });
    // The claim is written on its own connection and commits at once; this transaction only holds
    // the lock until it has. A competing purchase waiting on the lock then counts it as pending.
    return existingClaim
      ? resumeShopPurchase(claimContext(existingClaim.amount), existingClaim, expectedUnitAmount)
      : claimShopPurchase(claimContext(shopItem.unitAmount), expectedUnitAmount);
  });

  const unitAmount = claim.amount;
  const chargeContext = { shopItemId, userId, transactionId, amount: unitAmount };
  const transaction = await chargeForShopPurchase(
    () =>
      createMultiAccountBuzzTransaction(
        {
          fromAccountId: userId,
          fromAccountTypes: [buzzType],
          toAccountId: 0, // bank
          amount: unitAmount,
          type: TransactionType.Purchase,
          description: `Mystery box purchase - ${shopItem.title}`,
          externalTransactionIdPrefix: transactionId,
        },
        chargeRetryOptions
      ),
    chargeContext,
    claim
  );
  if (!transaction.transactionCount) throw new Error('There was an error creating the transaction');

  try {
    const item = await dbWrite.$transaction(async (tx) => {
      // The lock comes first here, unlike the shelf grant: the availability check counts this claim
      // as pending until the box exists, so the claim turning paid and the box appearing must be
      // seen together by anyone holding the lock. A concurrent grant of the same claim waits on the
      // lock instead of the claim row, and still finds it settled.
      await lockItemHolder(tx, userId);
      await markClaimPaid(tx, transactionId);
      // `cosmeticId` NULL and no components: what was bought is the held box below.
      await tx.userCosmeticShopPurchases.create({
        data: {
          userId,
          cosmeticId: null,
          shopItemId,
          unitAmount,
          buzzTransactionId: transactionId,
          refunded: false,
        },
      });
      return grantItem(tx, { itemDefinitionId: box.id, userId, sourceKey: transactionId });
    });
    return { kind: 'box', boxItemId: item.id.toString(), boxDefinitionId: item.itemDefinitionId };
  } catch (error) {
    // With a client key, a unique violation here means a request with the same key recorded this
    // purchase first; the prefix is shared with it, so it is not refunded from here.
    if (idempotencyKey && isPrismaUniqueViolation(error))
      throw purchaseStateUnknown({ ...chargeContext, error }, 'same key already recorded');

    await refundClaimedCharge(
      () =>
        refundMultiAccountTransaction(
          {
            externalTransactionIdPrefix: transactionId,
            description: `Failed to purchase mystery box - ${shopItem.title}`,
            details: { claim: transactionId },
          },
          refundCallOptions
        ),
      { ...chargeContext, error }
    );
    throw throwBadRequestError('Failed to purchase box');
  }
}

/** This user's unsettled purchases of any listing selling this box, other than the current one. */
async function countPendingBoxClaims(
  tx: Prisma.TransactionClient,
  {
    boxDefinitionId,
    userId,
    exceptTransactionId,
  }: { boxDefinitionId: number; userId: number; exceptTransactionId: string }
) {
  const listings = await tx.cosmeticShopItem.findMany({
    where: { itemDefinitionId: boxDefinitionId },
    select: { id: true },
  });
  return tx.cosmeticShopPurchaseClaim.count({
    where: {
      userId,
      status: SHOP_PURCHASE_CLAIM_STATUS.pending,
      shopItemId: { in: listings.map((listing) => listing.id) },
      transactionId: { not: exceptTransactionId },
    },
  });
}
