import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type {
  SubmitCreatorShopPackInput,
  UpdateCreatorShopPackInput,
} from '~/server/schema/creator-shop.schema';
import {
  CREATOR_SHOP_SUBMISSION_FEE,
  RIGHTS_AFFIRMATION_STATEMENT,
  RIGHTS_AFFIRMATION_VERSION,
  computePackOwnershipDiscount,
  isConsumableCosmeticType,
  packPriceFloor,
  type PackMemberPricing,
} from '~/server/schema/creator-shop.schema';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

type ResolvedMember = PackMemberPricing & {
  name: string;
  data: unknown;
  createdById: number | null;
  creatorUsername: string | null;
  acceptsBlueBuzz: boolean;
};

/**
 * Resolves the members a pack may be built from, at the price bundling them
 * costs.
 *
 * A cosmetic can be reachable through several listings (resale by reference), so
 * the price used is the **highest** Published listing — bundling must not be a
 * way to buy someone's work at whichever listing happens to be cheapest.
 *
 * Delisted members are included: delisting stops individual sale while staying
 * bundlable, which is what `listed` exists for. Archived ones are not.
 */
export const resolvePackMembers = async (cosmeticIds: number[]): Promise<ResolvedMember[]> => {
  if (!cosmeticIds.length) return [];
  const listings = await dbRead.cosmeticShopItem.findMany({
    where: { cosmeticId: { in: cosmeticIds }, status: CosmeticShopItemStatus.Published },
    select: {
      cosmeticId: true,
      unitAmount: true,
      meta: true,
      cosmetic: {
        select: {
          id: true,
          name: true,
          type: true,
          data: true,
          createdById: true,
          creator: { select: { username: true } },
        },
      },
    },
  });

  const byCosmetic = new Map<number, ResolvedMember>();
  for (const listing of listings) {
    if (listing.cosmeticId == null || !listing.cosmetic) continue;
    const meta = (listing.meta ?? {}) as CosmeticShopItemMeta;
    const existing = byCosmetic.get(listing.cosmeticId);
    const candidate: ResolvedMember = {
      cosmeticId: listing.cosmeticId,
      type: listing.cosmetic.type,
      listPrice: listing.unitAmount,
      isOwn: false,
      name: listing.cosmetic.name,
      data: listing.cosmetic.data,
      createdById: listing.cosmetic.createdById,
      creatorUsername: listing.cosmetic.creator?.username ?? null,
      acceptsBlueBuzz: !!meta.acceptsBlueBuzz,
    };
    if (!existing || candidate.listPrice > existing.listPrice)
      byCosmetic.set(listing.cosmeticId, {
        ...candidate,
        // One listing opting out of blue is enough to make the member unable to
        // carry blue into a pack.
        acceptsBlueBuzz: (existing?.acceptsBlueBuzz ?? true) && candidate.acceptsBlueBuzz,
      });
    else if (!candidate.acceptsBlueBuzz)
      byCosmetic.set(listing.cosmeticId, { ...existing, acceptsBlueBuzz: false });
  }

  // Order follows the caller's list so `index` reflects what the builder chose.
  return cosmeticIds.flatMap((id) => {
    const member = byCosmetic.get(id);
    return member ? [member] : [];
  });
};

const assertMembersBundlable = (requested: number[], resolved: ResolvedMember[]) => {
  if (resolved.length === requested.length) return;
  const found = new Set(resolved.map((m) => m.cosmeticId));
  const missing = requested.filter((id) => !found.has(id));
  throw throwBadRequestError(
    `These items can't be bundled — they have no published listing: ${missing.join(', ')}`
  );
};

/**
 * Bundling a sticker is an insertion path like any other, so the flag has to
 * refuse it here. Filtering stickers out of the picker only hides them.
 */
const assertStickerMembersAllowed = (members: ResolvedMember[], stickersEnabled?: boolean) => {
  if (stickersEnabled) return;
  if (members.some((m) => m.type === CosmeticType.Sticker))
    throw throwBadRequestError('Stickers cannot be bundled yet');
};

const withOwnership = (members: ResolvedMember[], userId: number) =>
  members.map((m) => ({ ...m, isOwn: m.createdById === userId }));

/** Members that stop a pack from accepting Blue Buzz — named, so the builder can say which. */
export const blueBuzzBlockers = (members: ResolvedMember[]) =>
  members
    .filter((m) => !m.acceptsBlueBuzz)
    .map((m) => ({ cosmeticId: m.cosmeticId, name: m.name }));

const buildRightsAffirmation = (userId: number) => ({
  userId,
  affirmedAt: new Date().toISOString(),
  version: RIGHTS_AFFIRMATION_VERSION,
  statement: RIGHTS_AFFIRMATION_STATEMENT,
});

export const submitCreatorShopPack = async ({
  userId,
  name,
  description,
  memberCosmeticIds,
  price,
  availableQuantity,
  buzzType,
  acceptsBlueBuzz,
  imageUrl,
  rightsAffirmed,
  stickersEnabled,
}: SubmitCreatorShopPackInput & { userId: number; stickersEnabled?: boolean }) => {
  if (!rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');

  const members = withOwnership(await resolvePackMembers(memberCosmeticIds), userId);
  assertMembersBundlable(memberCosmeticIds, members);
  assertStickerMembersAllowed(members, stickersEnabled);

  const floor = packPriceFloor(members);
  if (price < floor)
    throw throwBadRequestError(
      `This pack must be listed for at least ${floor} Buzz — every item another creator made has to be covered at its own price`
    );

  // A pack accepts blue only if every member does; requesting it when one
  // member opted out is a mistake worth naming rather than silently dropping.
  const blockers = blueBuzzBlockers(members);
  if (acceptsBlueBuzz && blockers.length)
    throw throwBadRequestError(
      `These items don't accept Blue Buzz, so this pack can't either: ${blockers
        .map((b) => b.name)
        .join(', ')}`
    );

  const feeTx = await createBuzzTransaction({
    fromAccountId: userId,
    fromAccountType: buzzType as BuzzSpendType,
    toAccountId: 0,
    amount: CREATOR_SHOP_SUBMISSION_FEE,
    type: TransactionType.Purchase,
    description: `Creator Shop pack submission fee - ${name}`,
    externalTransactionId: `creator-shop-pack-submit-${userId}-${Date.now()}`,
  });
  const feeTxId = feeTx.transactionId;
  if (!feeTxId) throw throwBadRequestError('Unable to charge the submission fee');

  try {
    return await dbWrite.$transaction(async (tx) => {
      const item = await tx.cosmeticShopItem.create({
        data: {
          cosmeticId: null,
          unitAmount: price,
          title: name,
          description: description ?? null,
          availableQuantity: availableQuantity ?? null,
          addedById: userId,
          status: CosmeticShopItemStatus.PendingReview,
          meta: {
            purchases: 0,
            submissionTxId: feeTxId,
            coverUrl: imageUrl,
            packMemberCount: members.length,
            acceptsBlueBuzz,
            rightsAffirmation: buildRightsAffirmation(userId),
          } satisfies CosmeticShopItemMeta as Prisma.InputJsonValue,
        },
      });

      await tx.cosmeticShopItemCosmetic.createMany({
        data: members.map((m, index) => ({
          shopItemId: item.id,
          cosmeticId: m.cosmeticId,
          index,
          // Snapshot: a member's creator raising their price later must not
          // silently re-price every pack that contains them.
          floorAmount: m.listPrice,
        })),
      });

      return item;
    });
  } catch (error) {
    await refundTransaction(feeTxId, 'Creator Shop pack submission failed');
    throw error;
  }
};

export const updateCreatorShopPack = async ({
  userId,
  isModerator,
  id,
  name,
  description,
  price,
  availableQuantity,
  acceptsBlueBuzz,
  imageUrl,
  memberCosmeticIds,
  stickersEnabled,
}: UpdateCreatorShopPackInput & {
  userId: number;
  isModerator?: boolean;
  stickersEnabled?: boolean;
}) => {
  const existing = await dbRead.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      addedById: true,
      status: true,
      meta: true,
      unitAmount: true,
      members: { select: { cosmeticId: true }, orderBy: { index: 'asc' } },
    },
  });
  if (!existing) throw throwNotFoundError('Pack not found');
  if (existing.cosmeticId != null) throw throwBadRequestError('This listing is not a pack');
  if (!isModerator && existing.addedById !== userId)
    throw throwBadRequestError('You can only manage your own shop items');
  if (existing.status === CosmeticShopItemStatus.Rejected)
    throw throwBadRequestError('Rejected items cannot be edited');
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be edited');

  const meta = (existing.meta ?? {}) as CosmeticShopItemMeta;
  const memberIds = memberCosmeticIds ?? existing.members.map((m) => m.cosmeticId);
  // Re-resolved even when the contents didn't change: the price floor has to be
  // checked against today's list prices, not the ones the pack was built against.
  const members = withOwnership(await resolvePackMembers(memberIds), existing.addedById ?? userId);
  assertMembersBundlable(memberIds, members);
  assertStickerMembersAllowed(members, stickersEnabled);

  const nextPrice = price ?? existing.unitAmount;
  const floor = packPriceFloor(members);
  if (nextPrice < floor)
    throw throwBadRequestError(
      `This pack must be listed for at least ${floor} Buzz — every item another creator made has to be covered at its own price`
    );

  const blockers = blueBuzzBlockers(members);
  const nextAcceptsBlue = acceptsBlueBuzz ?? !!meta.acceptsBlueBuzz;
  if (nextAcceptsBlue && blockers.length)
    throw throwBadRequestError(
      `These items don't accept Blue Buzz, so this pack can't either: ${blockers
        .map((b) => b.name)
        .join(', ')}`
    );

  return dbWrite.$transaction(async (tx) => {
    if (memberCosmeticIds) {
      await tx.cosmeticShopItemCosmetic.deleteMany({ where: { shopItemId: id } });
      await tx.cosmeticShopItemCosmetic.createMany({
        data: members.map((m, index) => ({
          shopItemId: id,
          cosmeticId: m.cosmeticId,
          index,
          floorAmount: m.listPrice,
        })),
      });
    }

    return tx.cosmeticShopItem.update({
      where: { id },
      data: {
        ...(name !== undefined ? { title: name } : {}),
        ...(description !== undefined ? { description: description ?? null } : {}),
        ...(price !== undefined ? { unitAmount: price } : {}),
        ...(availableQuantity !== undefined
          ? { availableQuantity: availableQuantity ?? null }
          : {}),
        // Contents or price changing sends the pack back through review, the
        // same way an item's content edit does.
        ...(memberCosmeticIds || price !== undefined
          ? { status: CosmeticShopItemStatus.PendingReview }
          : {}),
        meta: {
          ...meta,
          ...(imageUrl ? { coverUrl: imageUrl } : {}),
          packMemberCount: members.length,
          acceptsBlueBuzz: nextAcceptsBlue,
        } as Prisma.InputJsonValue,
      },
    });
  });
};

/**
 * D14 cascade: a member leaving sale delists every pack containing it.
 *
 * `listed = false`, not Archived — the pack creator can swap the member out and
 * relist. D15 (no nesting) is what keeps this one level deep.
 */
export const delistPacksContaining = async (cosmeticId: number) => {
  // A cosmetic can be listed more than once (resale by reference). It stays
  // bundlable while any Published listing survives, so one listing going away
  // is not grounds for delisting anyone's pack.
  const stillListed = await dbRead.cosmeticShopItem.findFirst({
    where: { cosmeticId, status: CosmeticShopItemStatus.Published },
    select: { id: true },
  });
  if (stillListed) return { delisted: 0 };

  const packs = await dbRead.cosmeticShopItemCosmetic.findMany({
    where: { cosmeticId },
    select: { shopItemId: true },
  });
  if (!packs.length) return { delisted: 0 };
  const { count } = await dbWrite.cosmeticShopItem.updateMany({
    where: { id: { in: packs.map((p) => p.shopItemId) }, listed: true },
    data: { listed: false },
  });
  return { delisted: count };
};

/**
 * A pack's contents, priced for this viewer.
 *
 * Contents being visible before purchase is not decoration — it is the stated
 * mitigation for D16 (a pack may be bought regardless of what you already own).
 */
export const getPackDetail = async ({
  shopItemId,
  userId,
}: {
  shopItemId: number;
  userId?: number;
}) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: {
      id: true,
      title: true,
      description: true,
      unitAmount: true,
      status: true,
      listed: true,
      availableQuantity: true,
      meta: true,
      addedById: true,
      members: { select: { cosmeticId: true, floorAmount: true }, orderBy: { index: 'asc' } },
    },
  });
  if (!item) throw throwNotFoundError('Pack not found');

  const snapshotByCosmetic = new Map(item.members.map((m) => [m.cosmeticId, m.floorAmount]));
  const resolved = await resolvePackMembers(item.members.map((m) => m.cosmeticId));
  const members = resolved.map((m) => ({
    ...m,
    isOwn: m.createdById === item.addedById,
    // What the buyer is paying for this member, which is the snapshot rather
    // than today's list price.
    listPrice: snapshotByCosmetic.get(m.cosmeticId) ?? m.listPrice,
  }));

  const owned = userId
    ? await dbRead.userCosmetic.findMany({
        where: { userId, cosmeticId: { in: members.map((m) => m.cosmeticId) } },
        select: { cosmeticId: true },
      })
    : [];
  const ownedCosmeticIds = [...new Set(owned.map((o) => o.cosmeticId))];

  const { discount, perMember } = computePackOwnershipDiscount({
    packPrice: item.unitAmount,
    members,
    ownedCosmeticIds,
  });
  const discountByCosmetic = new Map(perMember.map((m) => [m.cosmeticId, m.discount]));

  return {
    id: item.id,
    title: item.title,
    description: item.description,
    unitAmount: item.unitAmount,
    status: item.status,
    listed: item.listed,
    availableQuantity: item.availableQuantity,
    meta: (item.meta ?? {}) as CosmeticShopItemMeta,
    // A member the pack no longer resolves is a member that can't be sold; the
    // purchase refuses on the same condition, so say so before they try.
    unavailableCount: item.members.length - members.length,
    discount,
    members: members.map((m) => ({
      cosmeticId: m.cosmeticId,
      name: m.name,
      type: m.type,
      data: m.data,
      creatorUsername: m.creatorUsername,
      isOwn: m.isOwn,
      listPrice: m.listPrice,
      owned: ownedCosmeticIds.includes(m.cosmeticId),
      // Owning a consumable means the purchase tops it up rather than
      // duplicating it (D23), which is also why it earns no discount.
      consumable: isConsumableCosmeticType(m.type),
      discount: discountByCosmetic.get(m.cosmeticId) ?? 0,
    })),
  };
};

/** Cosmetics this creator may bundle: anything with a Published listing. */
export const getBundlableCosmetics = async ({
  query,
  limit = 50,
  types,
}: {
  query?: string;
  limit?: number;
  types?: CosmeticType[];
}) => {
  const listings = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      cosmeticId: { not: null },
      ...(query ? { cosmetic: { name: { contains: query, mode: 'insensitive' } } } : {}),
      ...(types?.length ? { cosmetic: { type: { in: types } } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit * 2,
    select: { cosmeticId: true },
  });
  const cosmeticIds = [...new Set(listings.map((l) => l.cosmeticId as number))].slice(0, limit);
  return resolvePackMembers(cosmeticIds);
};
