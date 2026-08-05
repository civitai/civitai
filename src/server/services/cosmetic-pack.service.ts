import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type {
  CosmeticPurchaseMeta,
  CosmeticShopItemMeta,
} from '~/server/schema/cosmetic-shop.schema';
import {
  computeCreatorShopSplit,
  isConsumableCosmeticType,
} from '~/server/schema/creator-shop.schema';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import { throwBadRequestError, withRetries } from '~/server/utils/errorHandling';
import { stickerUsesFromCosmeticData } from '~/shared/utils/sticker-token';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export type PackMemberListing = {
  cosmeticId: number;
  type: CosmeticType;
  data: unknown;
  createdById: number | null;
  /** The member's own listing — a pack does not create one for it. */
  listingId: number;
  listingMeta: CosmeticShopItemMeta;
  addedById: number | null;
  availableQuantity: number | null;
  /** Individual sales plus grants made through any pack, so an edition cap holds. */
  soldCount: number;
  /** Price snapshotted into the pack at build time. */
  floorAmount: number;
};

/**
 * Loads each member alongside the listing that authorises selling it.
 *
 * Delisted members are deliberately included: delisting stops individual sale
 * while staying bundlable, which is the whole reason `listed` exists. Archived
 * and never-published ones are not — withdrawn is withdrawn.
 */
export const getPackMembers = async (shopItemId: number): Promise<PackMemberListing[]> => {
  const rows = await dbRead.cosmeticShopItemCosmetic.findMany({
    where: { shopItemId },
    orderBy: { index: 'asc' },
    select: {
      cosmeticId: true,
      floorAmount: true,
      cosmetic: { select: { id: true, type: true, data: true, createdById: true } },
    },
  });
  if (!rows.length) return [];

  const cosmeticIds = rows.map((r) => r.cosmeticId);
  const listings = await dbRead.cosmeticShopItem.findMany({
    where: { cosmeticId: { in: cosmeticIds }, status: CosmeticShopItemStatus.Published },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      cosmeticId: true,
      meta: true,
      addedById: true,
      availableQuantity: true,
      _count: { select: { purchases: true } },
    },
  });
  // A pack sale never writes a purchase row against the member's own listing, so
  // counting only those would let limited members be oversold through bundles.
  const packSales = await dbRead.userCosmeticShopPurchaseCosmetic.groupBy({
    by: ['cosmeticId'],
    where: { cosmeticId: { in: cosmeticIds } },
    _count: { cosmeticId: true },
  });
  const packSoldByCosmetic = new Map(packSales.map((s) => [s.cosmeticId, s._count.cosmeticId]));

  const listingByCosmetic = new Map<number, (typeof listings)[number]>();
  for (const listing of listings)
    if (listing.cosmeticId != null && !listingByCosmetic.has(listing.cosmeticId))
      listingByCosmetic.set(listing.cosmeticId, listing);

  return rows.flatMap((row) => {
    const listing = listingByCosmetic.get(row.cosmeticId);
    if (!listing || !row.cosmetic) return [];
    return [
      {
        cosmeticId: row.cosmeticId,
        type: row.cosmetic.type,
        data: row.cosmetic.data,
        createdById: row.cosmetic.createdById,
        listingId: listing.id,
        listingMeta: (listing.meta ?? {}) as CosmeticShopItemMeta,
        addedById: listing.addedById,
        availableQuantity: listing.availableQuantity,
        soldCount: listing._count.purchases + (packSoldByCosmetic.get(row.cosmeticId) ?? 0),
        floorAmount: row.floorAmount,
      },
    ];
  });
};

/**
 * A pack accepts Blue Buzz only if every member's own listing does (zuri,
 * 2026-08-04). `acceptsBlueBuzz` is a creator's decision about their own
 * cosmetic, and paying blue for a pack pays each member's creator in blue, so
 * one opt-out has to veto the pack. Returns the members that block it, which is
 * what the pack builder needs to show.
 */
export const packBlueBuzzVeto = (members: PackMemberListing[]) =>
  members.filter((m) => !m.listingMeta.acceptsBlueBuzz);

/**
 * Every guard the single purchase enforces, answered once per member.
 *
 * The failure this exists to prevent is a rule that is correct for the pack and
 * wrong for a member: a pack must not sell a sold-out member, a withdrawn one,
 * or one whose creator the buyer has blocked. The pack's own status says nothing
 * about any of that.
 */
export const assertPackPurchasable = async ({
  userId,
  members,
  memberCount,
  stickersEnabled,
}: {
  userId: number;
  members: PackMemberListing[];
  /** How many members the pack is *supposed* to have. */
  memberCount: number;
  stickersEnabled?: boolean;
}) => {
  // A member that resolved to no Published listing was dropped by getPackMembers.
  // Selling the rest at the full pack price would quietly short the buyer.
  if (members.length !== memberCount)
    throw throwBadRequestError('This pack contains an item that is no longer available');

  if (!stickersEnabled && members.some((m) => m.type === CosmeticType.Sticker))
    throw throwBadRequestError('This pack is not available');

  const creatorIds = members
    .flatMap((m) => [m.createdById, m.addedById])
    .filter((id): id is number => id != null);
  if (creatorIds.length) {
    const blockedPairIds = await getBlockedPairIds(userId);
    // Same generic error as the single purchase so a block isn't revealed.
    if (creatorIds.some((id) => blockedPairIds.includes(id)))
      throw throwBadRequestError('This pack is not available');
  }

  for (const member of members) {
    if (member.availableQuantity !== null && member.soldCount >= member.availableQuantity)
      throw throwBadRequestError('This pack contains an item that is sold out');
  }
};

/**
 * Grants every member to the buyer.
 *
 * Two behaviours, per D16 and D23. A consumable the buyer already holds is not a
 * duplicate — the purchase adds uses, so it lands as `remaining + n` on the
 * existing holding. Everything else is granted only if lacking. Neither can be
 * expressed as `createMany({ skipDuplicates: true })`: the `UserCosmetic` key is
 * `[userId, cosmeticId, claimKey]` and each purchase carries a fresh claimKey,
 * so nothing ever collides and the skip never fires.
 */
export const grantPackMembers = async ({
  tx,
  userId,
  members,
  claimKey,
}: {
  tx: Prisma.TransactionClient;
  userId: number;
  members: PackMemberListing[];
  claimKey: string;
}) => {
  const consumable = members.filter((m) => isConsumableCosmeticType(m.type));
  const durable = members.filter((m) => !isConsumableCosmeticType(m.type));

  for (const member of consumable) {
    const uses = stickerUsesFromCosmeticData(member.data);
    // No usable `uses` means the grant would read as unlimited. That state is a
    // data fault (see creatorGrantRemaining), and honouring it here would sell
    // an unlimited balance at a finite price.
    if (!uses)
      throw throwBadRequestError('This pack contains an item that cannot be granted right now');
    await tx.$executeRaw`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "remaining")
      VALUES (${userId}, ${member.cosmeticId}, ${claimKey}, ${uses})
      ON CONFLICT ("userId", "cosmeticId", "claimKey")
      DO UPDATE SET "remaining" = COALESCE("UserCosmetic"."remaining", 0) + ${uses}
    `;
  }

  if (durable.length) {
    const owned = await tx.userCosmetic.findMany({
      where: { userId, cosmeticId: { in: durable.map((m) => m.cosmeticId) } },
      select: { cosmeticId: true },
    });
    const ownedIds = new Set(owned.map((o) => o.cosmeticId));
    const toGrant = durable.filter((m) => !ownedIds.has(m.cosmeticId));
    if (toGrant.length)
      await tx.userCosmetic.createMany({
        data: toGrant.map((m) => ({ userId, cosmeticId: m.cosmeticId, claimKey })),
      });
  }
};

/**
 * What each party is owed for a pack sale.
 *
 * Foreign members pay their creator as if sold at the price snapshotted into the
 * pack, with their own listing's sellerShare. The pack creator is paid on the
 * remainder, so the platform's 30% comes out of every component and the total
 * paid can never exceed 70% of the price — a pack that paid out more than it
 * collected would mint Buzz.
 */
export const computePackPayouts = ({
  packPrice,
  packCreatorId,
  members,
}: {
  packPrice: number;
  packCreatorId: number | null;
  members: PackMemberListing[];
}) => {
  const components: { cosmeticId: number; userId: number; amount: number; unitAmount: number }[] =
    [];
  let foreignTotal = 0;

  for (const member of members) {
    const isForeign = member.createdById != null && member.createdById !== packCreatorId;
    if (!isForeign) continue;
    foreignTotal += member.floorAmount;
    const { creatorPool, sellerAmount, creatorAmount } = computeCreatorShopSplit(
      member.floorAmount,
      member.listingMeta.sellerShare ?? 0
    );
    // The member's own reseller, if it has one, is paid out of that member's
    // pool rather than the pack creator's.
    const resellerId =
      member.addedById && member.addedById !== member.createdById ? member.addedById : null;
    if (resellerId && sellerAmount > 0) {
      if (creatorAmount > 0)
        components.push({
          cosmeticId: member.cosmeticId,
          userId: member.createdById as number,
          amount: creatorAmount,
          unitAmount: member.floorAmount,
        });
      components.push({
        cosmeticId: member.cosmeticId,
        userId: resellerId,
        amount: sellerAmount,
        unitAmount: member.floorAmount,
      });
    } else if (creatorPool > 0) {
      components.push({
        cosmeticId: member.cosmeticId,
        userId: member.createdById as number,
        amount: creatorPool,
        unitAmount: member.floorAmount,
      });
    }
  }

  // Never negative: the pack floor guarantees foreign members are covered, but a
  // member re-priced upward after the pack was built could otherwise invert it.
  const remainder = Math.max(0, packPrice - foreignTotal);
  const packCreatorAmount = packCreatorId ? computeCreatorShopSplit(remainder).creatorPool : 0;

  return { components, foreignTotal, remainder, packCreatorAmount };
};

export const purchaseCosmeticPack = async ({
  userId,
  shopItem,
  members,
  payWith = 'default',
  buzzType = 'yellow',
  stickersEnabled,
}: {
  userId: number;
  shopItem: {
    id: number;
    title: string;
    unitAmount: number;
    addedById: number | null;
    meta: CosmeticShopItemMeta;
    memberCount: number;
  };
  members: PackMemberListing[];
  payWith?: 'default' | 'blue' | 'blue-first';
  buzzType?: BuzzSpendType;
  stickersEnabled?: boolean;
}) => {
  await assertPackPurchasable({
    userId,
    members,
    memberCount: shopItem.memberCount,
    stickersEnabled,
  });

  // AND across members, not the pack's own flag: the pack listing's
  // acceptsBlueBuzz is a request, and one member's opt-out vetoes it.
  if (payWith !== 'default') {
    if (!shopItem.meta.acceptsBlueBuzz || packBlueBuzzVeto(members).length)
      throw throwBadRequestError('This pack does not accept Blue Buzz');
  }
  const fromAccountTypes: BuzzSpendType[] =
    payWith === 'blue-first' ? ['blue', buzzType] : [buzzType];

  // Random rather than a timestamp: a pack is repeatable (a consumable member
  // tops up), so two calls in the same millisecond would share an external id —
  // and a duplicate reads as "the money already moved".
  const transactionId = `cosmetic-pack-${userId}-${shopItem.id}-${randomUUID()}`;
  const transaction = await createMultiAccountBuzzTransaction({
    fromAccountId: userId,
    fromAccountTypes,
    toAccountId: 0,
    amount: shopItem.unitAmount,
    type: TransactionType.Purchase,
    description: `Cosmetic pack purchase - ${shopItem.title}`,
    externalTransactionIdPrefix: transactionId,
  });
  if (!transaction.transactionCount)
    throw throwBadRequestError('There was an error creating the transaction');
  const bluePaid = transaction.transactionIds
    .filter((t) => t.accountType === 'blue')
    .reduce((sum, t) => sum + t.amount, 0);

  try {
    await dbWrite.$transaction(async (tx) => {
      await tx.userCosmeticShopPurchases.create({
        data: {
          userId,
          cosmeticId: null,
          shopItemId: shopItem.id,
          unitAmount: shopItem.unitAmount,
          buzzTransactionId: transactionId,
          refunded: false,
        },
      });

      const { components } = computePackPayouts({
        packPrice: shopItem.unitAmount,
        packCreatorId: shopItem.addedById,
        members,
      });
      const attributedByCosmetic = new Map<number, number>();
      for (const member of members) attributedByCosmetic.set(member.cosmeticId, member.floorAmount);
      for (const c of components) attributedByCosmetic.set(c.cosmeticId, c.unitAmount);

      await tx.userCosmeticShopPurchaseCosmetic.createMany({
        data: members.map((m) => ({
          buzzTransactionId: transactionId,
          cosmeticId: m.cosmeticId,
          unitAmount: attributedByCosmetic.get(m.cosmeticId) ?? m.floorAmount,
        })),
      });

      await grantPackMembers({ tx, userId, members, claimKey: transactionId });

      await tx.cosmeticShopItem.update({
        where: { id: shopItem.id },
        data: {
          meta: {
            ...shopItem.meta,
            purchases: (shopItem.meta.purchases ?? 0) + 1,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await refreshOwnedStickerCache([userId]);
  } catch (error) {
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: transactionId,
      description: `Failed to purchase cosmetic pack - ${shopItem.title}`,
    });
    throw throwBadRequestError('Failed to purchase pack');
  }

  try {
    await withRetries(async () => {
      const price = shopItem.unitAmount;
      const { components, packCreatorAmount } = computePackPayouts({
        packPrice: price,
        packCreatorId: shopItem.addedById,
        members,
      });
      const recipients = [
        ...components.map((c) => ({
          userId: c.userId,
          amount: c.amount,
          cosmeticId: c.cosmeticId,
        })),
        ...(shopItem.addedById && packCreatorAmount > 0
          ? [{ userId: shopItem.addedById, amount: packCreatorAmount, cosmeticId: null }]
          : []),
      ];

      // Paid in the colors the buyer paid with, pro-rated and floored per
      // recipient, exactly as a single purchase does.
      const payouts = recipients.flatMap((r) => {
        const blueAmount = price > 0 ? Math.floor((r.amount * bluePaid) / price) : 0;
        return [
          { ...r, amount: blueAmount, color: 'blue' as BuzzSpendType },
          { ...r, amount: r.amount - blueAmount, color: buzzType },
        ].filter((p) => p.amount > 0);
      });

      const paid = await Promise.all(
        payouts.map(async (p) => {
          const { transactionId: payoutTransactionId } = await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: p.userId,
            toAccountType: p.color,
            amount: p.amount,
            type: TransactionType.Sell,
            description: `A user has purchased your cosmetic - ${shopItem.title}`,
            // Unique per recipient, color AND member: one user can be paid for
            // several members of the same pack.
            externalTransactionId: `${transactionId}:sell:${p.userId}:${p.color}:${
              p.cosmeticId ?? 'pack'
            }`,
            details: { purchasedBy: userId, originalAmount: price },
          });
          return {
            userId: p.userId,
            amount: p.amount,
            color: p.color,
            transactionId: payoutTransactionId ?? undefined,
          };
        })
      );

      await dbWrite.userCosmeticShopPurchases.update({
        where: { buzzTransactionId: transactionId },
        data: {
          meta: {
            payouts: paid,
            platformCut: price - paid.reduce((sum, p) => sum + p.amount, 0),
          } satisfies CosmeticPurchaseMeta as Prisma.InputJsonValue,
        },
      });
    }, 3);
  } catch (e) {
    logToAxiom({
      level: 'error',
      message: 'Failed to distribute pack funds',
      data: { shopItemId: shopItem.id, userId, transactionId, error: e },
    });
  }

  return { transactionId, granted: members.map((m) => m.cosmeticId) };
};
