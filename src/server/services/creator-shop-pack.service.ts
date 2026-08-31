import type { Prisma } from '@prisma/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { dbRead, dbWrite } from '~/server/db/client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type {
  SubmitCreatorShopPackInput,
  UpdateCreatorShopPackInput,
} from '~/server/schema/creator-shop.schema';
import {
  RIGHTS_AFFIRMATION_STATEMENT,
  RIGHTS_AFFIRMATION_VERSION,
  computePackAmountDue,
  creatorCosmeticTypes,
  isCreatorCosmeticType,
  isConsumableCosmeticType,
  packPriceFloor,
  type PackMemberPricing,
} from '~/server/schema/creator-shop.schema';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { assertQuotedFee, getCreatorShopFees } from '~/server/services/creator-shop-fees.service';
import { getCosmeticArtworkUrl } from '~/server/services/cosmetic-phash.service';
import { REJECTED_IS_FINAL } from '~/server/services/creator-shop.data';
import { stickerUsesFromCosmeticData } from '~/shared/utils/sticker-token';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

type ResolvedMember = PackMemberPricing & {
  name: string;
  data: unknown;
  createdById: number | null;
  creatorUsername: string | null;
  acceptsBlueBuzz: boolean;
  /** The resolved listing's resale opt-in — see `isBundlableBy`. */
  sellableByOthers: boolean;
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
    where: {
      cosmeticId: { in: cosmeticIds },
      status: CosmeticShopItemStatus.Published,
      // See getPackMembers: a mod archive stamps the date without moving status.
      archivedAt: null,
    },
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
      sellableByOthers: !!meta.sellableByOthers,
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

/**
 * Who may bundle a member. A creator bundles their own work freely; another
 * creator's only when its listing opted into resale (`sellableByOthers`) — the
 * same consent the official shop enforces in `upsertCosmeticShopSection`. A pack
 * is somebody else selling the item, so an opt-out has to block it here too.
 *
 * A member with no creator is a platform cosmetic, which the resale-consent rule
 * doesn't govern — the official shop scopes its check to `createdById != null`
 * for the same reason, so this stays in step with it. `resolvePackMembers`
 * already restricts to Published, non-archived listings, so those guards aren't
 * repeated here.
 */
export const isBundlableBy = (
  member: { createdById: number | null; sellableByOthers: boolean },
  ownerId: number
) => member.createdById == null || member.createdById === ownerId || member.sellableByOthers;

/** Refuses members whose creator has not allowed others to sell them. */
export const assertMembersResellable = (members: ResolvedMember[], ownerId: number) => {
  const forbidden = members.filter((m) => !isBundlableBy(m, ownerId));
  if (forbidden.length)
    throw throwBadRequestError(
      `These items can't be bundled — their creator hasn't allowed other creators to sell them: ${forbidden
        .map((m) => m.name)
        .join(', ')}`
    );
};

const withOwnership = (members: ResolvedMember[], userId: number) =>
  members.map((m) => ({ ...m, isOwn: m.createdById === userId }));

/** Members that stop a pack from accepting Blue Buzz — named, so the builder can say which. */
export const blueBuzzBlockers = (members: ResolvedMember[]) =>
  members
    .filter((m) => !m.acceptsBlueBuzz)
    .map((m) => ({ cosmeticId: m.cosmeticId, name: m.name }));

const COVER_TILE_COUNT = 4;
const coverTilesFrom = (members: ResolvedMember[]) =>
  members
    .map((m) => getCosmeticArtworkUrl(m.data as Prisma.JsonValue))
    .filter((url): url is string => !!url)
    .slice(0, COVER_TILE_COUNT);

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
  quotedFee,
  stickersEnabled,
}: SubmitCreatorShopPackInput & { userId: number; stickersEnabled?: boolean }) => {
  // The same CosmeticShopItem.title/description columns the moderator-only upsert guards; these
  // are the CREATOR-facing doors into them. Guarding only the moderator one would have closed
  // the lower-risk door and left these open.
  await throwOnBlockedUserContent([name, description], { surface: 'creatorShop' });

  // Only artwork needs affirming, and only a cover is artwork the lister
  // supplied — the members were each affirmed when they were submitted.
  if (imageUrl && !rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');

  const members = withOwnership(await resolvePackMembers(memberCosmeticIds), userId);
  assertMembersBundlable(memberCosmeticIds, members);
  assertMembersResellable(members, userId);
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

  const submissionFee = (await getCreatorShopFees()).pack;
  assertQuotedFee(quotedFee, submissionFee);
  const feeTx = await createBuzzTransaction({
    fromAccountId: userId,
    fromAccountType: buzzType as BuzzSpendType,
    toAccountId: 0,
    amount: submissionFee,
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
            submissionFee,
            // `null` clears, `undefined` leaves alone — without the distinction
            // the clear button emptied the form and saved nothing.
            ...(imageUrl === undefined ? {} : { coverUrl: imageUrl ?? undefined }),
            coverTiles: coverTilesFrom(members),
            packMemberCount: members.length,
            acceptsBlueBuzz,
            // Only when a cover was actually supplied. The affirmation is a
            // statement about artwork; recording one for a pack with no cover
            // makes the review panel quote it back to a moderator as though the
            // lister claimed rights over art they never uploaded.
            ...(imageUrl ? { rightsAffirmation: buildRightsAffirmation(userId) } : {}),
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
  await throwOnBlockedUserContent([name, description], { isModerator, surface: 'creatorShop' });

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
    throw throwBadRequestError(REJECTED_IS_FINAL);
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be edited');

  const meta = (existing.meta ?? {}) as CosmeticShopItemMeta;
  const memberIds = memberCosmeticIds ?? existing.members.map((m) => m.cosmeticId);
  // Re-resolved even when the contents didn't change: the price floor has to be
  // checked against today's list prices, not the ones the pack was built against.
  const packOwnerId = existing.addedById ?? userId;
  const members = withOwnership(await resolvePackMembers(memberIds), packOwnerId);
  assertMembersBundlable(memberIds, members);
  assertMembersResellable(members, packOwnerId);
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

  // Re-snapshot whenever the price moves, not only when the contents do. The
  // floor is checked against today's list prices; leaving yesterday's snapshots
  // in place lets a lowered member price drag the pack's price down while its
  // component still pays out the old, higher amount.
  const reSnapshot = !!memberCosmeticIds || price !== undefined;

  return dbWrite.$transaction(async (tx) => {
    if (reSnapshot) {
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
          // `null` clears, `undefined` leaves alone — without the distinction
          // the clear button emptied the form and saved nothing.
          ...(imageUrl === undefined ? {} : { coverUrl: imageUrl ?? undefined }),
          ...(memberCosmeticIds ? { coverTiles: coverTilesFrom(members) } : {}),
          // Only re-baselined when the contents were actually chosen. A member
          // Cosmetic being deleted cascades its join row away, so rewriting this
          // on a price-only edit would quietly ratify the shrunken pack.
          ...(memberCosmeticIds ? { packMemberCount: members.length } : {}),
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
    where: { cosmeticId, status: CosmeticShopItemStatus.Published, archivedAt: null },
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
  isModerator,
}: {
  shopItemId: number;
  userId?: number;
  isModerator?: boolean;
}) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: {
      id: true,
      cosmeticId: true,
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
  if (item.cosmeticId != null) throw throwBadRequestError('This listing is not a pack');
  // Every other read path in the shop gates on Published. Without this, an id is
  // enough to read an unreviewed or rejected pack's contents and pricing.
  if (
    item.status !== CosmeticShopItemStatus.Published &&
    !isModerator &&
    (!userId || userId !== item.addedById)
  )
    throw throwNotFoundError('Pack not found');

  const snapshotByCosmetic = new Map(item.members.map((m) => [m.cosmeticId, m.floorAmount]));
  const resolved = await resolvePackMembers(item.members.map((m) => m.cosmeticId));
  const members = resolved.map((m) => ({
    ...m,
    isOwn: m.createdById === item.addedById,
    // What the buyer is paying for this member, which is the snapshot rather
    // than today's list price.
    listPrice: snapshotByCosmetic.get(m.cosmeticId) ?? m.listPrice,
  }));

  // On the writer, like the purchase path: the quote gates the buy button, so a
  // replica that hasn't caught up quotes a price above what will be charged and
  // blocks a buyer who can afford the real one.
  const owned = userId
    ? await dbWrite.userCosmetic.findMany({
        where: { userId, cosmeticId: { in: members.map((m) => m.cosmeticId) } },
        select: { cosmeticId: true },
      })
    : [];
  const ownedCosmeticIds = [...new Set(owned.map((o) => o.cosmeticId))];

  // The same helper the purchase path charges with, so the quote and the charge
  // cannot drift.
  const { discount, perMember, selfAuthored, amountDue } = computePackAmountDue({
    packPrice: item.unitAmount,
    members,
    ownedCosmeticIds,
    buyerId: userId,
    packCreatorId: item.addedById,
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
    // The purchase refuses the lister outright, and without this the client
    // cannot tell them apart — it would render a priced, enabled button that
    // always fails.
    isPackCreator: !!userId && userId === item.addedById,
    discount,
    selfAuthored,
    /** What this viewer will actually be charged. */
    amountDue,
    members: members.map((m) => ({
      cosmeticId: m.cosmeticId,
      name: m.name,
      type: m.type,
      data: m.data,
      creatorUsername: m.creatorUsername,
      isOwn: m.isOwn,
      listPrice: m.listPrice,
      // Today's list price, which is what an edit is re-checked against — the
      // snapshot above is only what this pack charges.
      currentListPrice:
        resolved.find((r) => r.cosmeticId === m.cosmeticId)?.listPrice ?? m.listPrice,
      acceptsBlueBuzz: m.acceptsBlueBuzz,
      owned: ownedCosmeticIds.includes(m.cosmeticId),
      // Owning a consumable means the purchase tops it up rather than
      // duplicating it (D23), which is also why it earns no discount.
      consumable: isConsumableCosmeticType(m.type),
      // What a consumable member grants. For a sticker this is the whole offer.
      uses: stickerUsesFromCosmeticData(m.data),
      discount: discountByCosmetic.get(m.cosmeticId) ?? 0,
    })),
  };
};

/**
 * Cosmetics this creator may bundle: their own work, plus other creators' items
 * whose listing opted into resale. Anything a creator placed off limits
 * (`sellableByOthers` false) is never offered, so the composer can't stage a
 * member the save would refuse — see `isBundlableBy`.
 */
export const getBundlableCosmetics = async ({
  userId,
  query,
  limit = 50,
  types,
}: {
  userId: number;
  query?: string;
  limit?: number;
  types?: CosmeticType[];
}) => {
  const listings = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      archivedAt: null,
      cosmeticId: { not: null },
      // One `cosmetic` object: two spreads onto the same key meant the type
      // filter silently overwrote the search.
      cosmetic: {
        ...(query ? { name: { contains: query, mode: 'insensitive' as const } } : {}),
        // Always bounded by what a creator may list. Without this the picker
        // offered every published cosmetic — including NamePlates, which
        // creators cannot make and which have no artwork to show.
        type: {
          in: types?.length ? types.filter(isCreatorCosmeticType) : [...creatorCosmeticTypes],
        },
      },
    },
    orderBy: { id: 'desc' },
    take: limit * 2,
    select: { cosmeticId: true },
  });
  // Filter after resolving, on the same highest-priced listing the composer and
  // payout price against: a cosmetic listed both sellable and not must be judged
  // by the listing the pack would actually use, not by whichever row matched.
  const cosmeticIds = [...new Set(listings.map((l) => l.cosmeticId as number))];
  const resolved = await resolvePackMembers(cosmeticIds);
  return resolved.filter((m) => isBundlableBy(m, userId)).slice(0, limit);
};
