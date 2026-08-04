import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead, dbWrite } from '~/server/db/client';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import {
  revokeCosmeticsFromUsers,
  validateStickerCosmetic,
} from '~/server/services/cosmetic.service';
import {
  buildCosmeticData,
  creatorGrantRemaining,
  patchCosmeticData,
} from '~/server/services/creator-shop.data';
import type { StickerEconomics } from '~/shared/utils/sticker-token';
import { stickerEconomicsFromCosmeticData } from '~/shared/utils/sticker-token';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  createBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import { NotificationCategory } from '~/server/common/enums';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
  withRetries,
} from '~/server/utils/errorHandling';
import { logToAxiom } from '~/server/logging/client';
import {
  CosmeticShopItemStatus,
  CosmeticSource,
  CosmeticType,
  MediaType,
  ModelStatus,
} from '~/shared/utils/prisma/enums';
import type {
  CosmeticPurchaseMeta,
  CosmeticShopItemMeta,
} from '~/server/schema/cosmetic-shop.schema';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

// Storefront items carry the cosmetic's creator so cards can attribute the owner
// (esp. resold items from other creators). The full avatar selector (profile
// picture + equipped cosmetics) lets the card render the creator's real avatar
// and badge. Only used by the creator storefront.
const creatorStorefrontItemSelect = Prisma.validator<Prisma.CosmeticShopItemSelect>()({
  ...cosmeticShopItemSelect,
  cosmetic: {
    select: {
      ...simpleCosmeticSelect,
      videoUrl: true,
      creator: { select: userWithCosmeticsSelect },
    },
  },
});
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import {
  CREATOR_SHOP_SUBMISSION_FEE,
  STICKER_DEFAULT_USES,
  STICKER_MIN_BUZZ_PER_USE,
  cosmeticPriceFloor,
  stickerPerUseFloor,
  MAX_ANIMATION_FPS,
  MAX_ANIMATION_FRAMES,
  MIN_ANIMATION_FRAME_DELAY_MS,
  PRICE_REVIEW_THRESHOLD,
  RIGHTS_AFFIRMATION_STATEMENT,
  RIGHTS_AFFIRMATION_VERSION,
  cosmeticDimensionsLabel,
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
  computeCreatorShopSplit,
} from '~/server/schema/creator-shop.schema';
import type {
  AutoCheck,
  CosmeticImageMeta,
  CosmeticOffsets,
  GetCommunityCosmeticsInput,
  GetEarlyAccessPricesInput,
  GetPublicShopItemsInput,
  GetReviewQueueInput,
  ResoldItemInput,
  ReviewCreatorShopItemInput,
  SubmitCreatorShopItemInput,
  TakedownCosmeticShopItemInput,
  UpdateCreatorShopItemInput,
  UpdateCreatorShopSettingsInput,
} from '~/server/schema/creator-shop.schema';
import { type ModelVersionTerms } from '@civitai/buzz';
import { getPaidAccess, getViewerMonetization } from '~/server/services/paid-access.service';

// Shop surfaces hide stickers until the flag is on. Rendering is never gated —
// an owned sticker in a comment or DM shows for everyone regardless.
const hideStickers = (stickersEnabled?: boolean) =>
  stickersEnabled ? {} : { cosmetic: { type: { not: CosmeticType.Sticker } } };

// Card/listing shape for the creator management + moderator views.
const creatorShopItemSelect = Prisma.validator<Prisma.CosmeticShopItemSelect>()({
  id: true,
  unitAmount: true,
  title: true,
  description: true,
  availableQuantity: true,
  availableFrom: true,
  availableTo: true,
  status: true,
  listed: true,
  rejectionReason: true,
  reviewedAt: true,
  createdAt: true,
  meta: true,
  cosmetic: {
    select: {
      id: true,
      name: true,
      type: true,
      data: true,
      videoUrl: true,
      createdById: true,
      source: true,
      description: true,
    },
  },
  _count: { select: { purchases: true } },
});

type CreatorShopItemRow = Prisma.CosmeticShopItemGetPayload<{
  select: typeof creatorShopItemSelect;
}>;

const withRemaining = (item: CreatorShopItemRow) => {
  const purchases = item._count.purchases;
  const remaining = item.availableQuantity != null ? item.availableQuantity - purchases : null;
  return { ...item, purchases, remaining, soldOut: remaining != null && remaining <= 0 };
};

// The cosmetic `data` blob is built server-side (never trust client-shaped data).
// Server-side artwork validation (source of truth). Fetches the original upload
// and inspects it with sharp against the per-type requirements.
const validateArtwork = async (imageUrl: string, type: CosmeticType) => {
  const req = cosmeticImageRequirements(type);

  let width = 0;
  let height = 0;
  let format: string | undefined;
  let hasTransparency = false;
  let imageHash = '';
  let frames = 1;
  let minFrameDelay = Infinity;
  try {
    const res = await fetch(getEdgeUrl(imageUrl, { original: true }));
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    imageHash = createHash('sha256').update(buffer).digest('hex');
    const meta = await sharp(buffer).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    format = meta.format;
    hasTransparency = !!meta.hasAlpha;
    frames = meta.pages ?? 1;
    if (meta.delay?.length) minFrameDelay = Math.min(...meta.delay);
  } catch {
    throw throwBadRequestError('Could not read the uploaded artwork for validation');
  }

  const checks: AutoCheck[] = [
    {
      key: 'format',
      label: 'PNG or WebP',
      passed: format === 'png' || format === 'webp',
      detail: format,
    },
    {
      key: 'dimensions',
      label: cosmeticDimensionsLabel(req),
      passed: cosmeticDimensionsPass(req, width, height),
      detail: `${width}×${height}px`,
    },
  ];
  if (req.requireTransparency)
    checks.push({ key: 'transparency', label: 'Transparent background', passed: hasTransparency });
  if (frames > 1) {
    checks.push({
      key: 'frameCount',
      label: `At most ${MAX_ANIMATION_FRAMES} frames`,
      passed: frames <= MAX_ANIMATION_FRAMES,
      detail: `${frames} frames`,
    });
    checks.push({
      key: 'frameRate',
      label: `At most ${MAX_ANIMATION_FPS} fps`,
      // A 0ms delay ("as fast as possible") also fails; missing delay info
      // (Infinity) can't be judged so it passes.
      passed: minFrameDelay >= MIN_ANIMATION_FRAME_DELAY_MS,
      detail: Number.isFinite(minFrameDelay)
        ? `~${Math.round(1000 / Math.max(1, minFrameDelay))} fps peak`
        : undefined,
    });
  }

  const imageMeta: CosmeticImageMeta = { width, height, hasTransparency };
  return { checks, imageMeta, imageHash, allPassed: checks.every((c) => c.passed) };
};

// Blocks re-submitting artwork already in the shop. Exact-match (sha256) — a
// re-encode/resize would slip past, but it catches accidental & copy re-uploads.
const findDuplicateArtwork = async (imageHash: string, excludeId?: number) => {
  if (!imageHash) return null;
  return dbRead.cosmeticShopItem.findFirst({
    where: {
      meta: { path: ['imageHash'], equals: imageHash },
      status: {
        notIn: [CosmeticShopItemStatus.Archived, CosmeticShopItemStatus.Rejected],
      },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
};

// The affirmation is stored with its wording, not just a flag, so a later
// takedown challenge can show what the submitter actually agreed to.
const buildRightsAffirmation = (userId: number) => ({
  userId,
  affirmedAt: new Date().toISOString(),
  version: RIGHTS_AFFIRMATION_VERSION,
  statement: RIGHTS_AFFIRMATION_STATEMENT,
});

// ---------------------------------------------------------------------------
// Creator: submit & manage
// ---------------------------------------------------------------------------

export const submitCreatorShopItem = async ({
  userId,
  cosmeticType,
  name,
  description,
  imageUrl,
  animated,
  price,
  availableQuantity,
  buzzType,
  sellableByOthers,
  sellerShare,
  acceptsBlueBuzz,
  offsets,
  slug,
  uses,
  pricePerUse,
  rightsAffirmed,
}: SubmitCreatorShopItemInput & { userId: number }) => {
  // The zod schema already requires it; this keeps the item from ever being
  // created without the record if the service is called from anywhere else.
  if (!rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');

  // The zod floor is the cross-type minimum; this is the real, type-dependent one.
  const priceFloor = cosmeticPriceFloor(cosmeticType);
  if (price < priceFloor)
    throw throwBadRequestError(`This cosmetic type must be listed for at least ${priceFloor} Buzz`);

  // Stickers are consumable, so the price also has to clear a per-use floor —
  // otherwise a cheap listing with a huge use count undercuts the economics.
  const stickerUses =
    cosmeticType === CosmeticType.Sticker ? uses ?? STICKER_DEFAULT_USES : undefined;
  if (stickerUses && price < stickerUses * STICKER_MIN_BUZZ_PER_USE)
    throw throwBadRequestError(
      `${stickerUses} uses needs at least ${
        stickerUses * STICKER_MIN_BUZZ_PER_USE
      } Buzz (${STICKER_MIN_BUZZ_PER_USE} per use)`
    );

  // Top-up price is sticker-only and has its own floor — the list floor governs
  // an offer of N uses, which is a different thing from one use.
  const stickerPricePerUse = cosmeticType === CosmeticType.Sticker ? pricePerUse : undefined;
  const perUseFloor = stickerPerUseFloor(cosmeticType);
  if (stickerPricePerUse && stickerPricePerUse < perUseFloor)
    throw throwBadRequestError(`A single use must cost at least ${perUseFloor} Buzz`);

  // Validate the artwork server-side BEFORE charging anything.
  const { checks, imageMeta, imageHash, allPassed } = await validateArtwork(imageUrl, cosmeticType);
  if (!allPassed)
    throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');

  // Reject duplicate artwork before charging the fee.
  if (await findDuplicateArtwork(imageHash))
    throw throwBadRequestError('This artwork has already been submitted to the shop.');
  checks.push({ key: 'duplicate', label: 'Original artwork', passed: true });

  // Slug format + collision, also before charging: finding out your slug is
  // taken after paying a non-refundable fee is the worst version of this.
  const normalizedSlug = slug?.trim().toLowerCase();
  await validateStickerCosmetic({ type: cosmeticType, data: { slug: normalizedSlug } });

  // Charge the (non-refundable) submission fee; refunded only if the write fails.
  const feeTx = await createBuzzTransaction({
    fromAccountId: userId,
    fromAccountType: buzzType as BuzzSpendType,
    toAccountId: 0,
    amount: CREATOR_SHOP_SUBMISSION_FEE,
    type: TransactionType.Purchase,
    description: `Creator Shop submission fee - ${name}`,
    externalTransactionId: `creator-shop-submit-${userId}-${Date.now()}`,
  });
  const feeTxId = feeTx.transactionId;
  if (!feeTxId) throw throwBadRequestError('Unable to charge the submission fee');

  try {
    return await dbWrite.$transaction(async (tx) => {
      const cosmetic = await tx.cosmetic.create({
        data: {
          name,
          description: description ?? null,
          type: cosmeticType,
          source: CosmeticSource.Purchase,
          permanentUnlock: true,
          data: buildCosmeticData(cosmeticType, imageUrl, animated, offsets, normalizedSlug, {
            uses: stickerUses,
            pricePerUse: stickerPricePerUse,
          }) as Prisma.InputJsonValue,
          createdById: userId,
        },
      });

      return tx.cosmeticShopItem.create({
        data: {
          cosmeticId: cosmetic.id,
          unitAmount: price,
          title: name,
          description: description ?? null,
          availableQuantity: availableQuantity ?? null,
          addedById: userId,
          status: CosmeticShopItemStatus.PendingReview,
          meta: {
            purchases: 0,
            submissionTxId: feeTxId,
            autoChecks: checks,
            imageMeta,
            imageHash,
            sellableByOthers,
            sellerShare: sellableByOthers ? sellerShare : 0,
            acceptsBlueBuzz,
            rightsAffirmation: buildRightsAffirmation(userId),
          } satisfies CosmeticShopItemMeta,
        },
        select: creatorShopItemSelect,
      });
    });
  } catch (error) {
    await refundTransaction(feeTxId, 'Creator Shop submission failed');
    throw error;
  }
};

// Load an item and assert the caller may manage it (its creator, or a moderator).
const getOwnedItemOrThrow = async (id: number, userId: number, isModerator = false) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      unitAmount: true,
      status: true,
      meta: true,
      addedById: true,
      cosmetic: { select: { id: true, createdById: true, type: true, data: true } },
      _count: { select: { purchases: true } },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  // Ownership is the lister (addedById), which may differ from the cosmetic's
  // original creator for cross-listed items.
  if (!isModerator && item.addedById !== userId)
    throw throwAuthorizationError('You can only manage your own shop items');
  return item;
};

export const updateCreatorShopItem = async ({
  userId,
  isModerator,
  id,
  name,
  description,
  imageUrl,
  animated,
  price,
  availableQuantity,
  acceptsBlueBuzz,
  offsets,
  slug,
  uses,
  pricePerUse,
  rightsAffirmed,
}: UpdateCreatorShopItemInput & { userId: number; isModerator?: boolean }) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  // Rejected is terminal; archived items must be restored before editing.
  if (existing.status === CosmeticShopItemStatus.Rejected)
    throw throwBadRequestError('Rejected items cannot be edited');
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be edited');

  // Fit offsets only apply to avatar decorations; undefined = keep, null = clear.
  const isDecoration = existing.cosmetic.type === CosmeticType.ProfileDecoration;
  const existingData = (existing.cosmetic.data ?? {}) as {
    offsets?: CosmeticOffsets;
  } & Record<string, unknown>;
  const offsetsChange = isDecoration && offsets !== undefined;
  const nextOffsets = !isDecoration
    ? null
    : offsets === undefined
    ? existingData.offsets ?? null
    : offsets;

  // Slug rules are Sticker-only — the schema accepts `slug` on any type, so
  // without this gate a crafted request would hit them on a Badge.
  const isStickerItem = existing.cosmetic.type === CosmeticType.Sticker;
  const existingSlug = (existing.cosmetic.data as { slug?: string } | null)?.slug;
  const requestedSlug = isStickerItem ? slug?.trim().toLowerCase() : undefined;
  // Rebuilding `data` from scratch would drop the slug on an artwork swap, and
  // owners' `:slug:` text depends on it — so carry the existing one forward.
  const nextSlug = requestedSlug ?? existingSlug;
  const slugChange = requestedSlug !== undefined && requestedSlug !== existingSlug;
  // Same carry-forward reasoning as the slug: rebuilding `data` would drop the
  // economics, and buyers' balances and top-ups were priced by them. Read as one
  // object so a field added later is carried without a new call site to update.
  const existingEconomics = stickerEconomicsFromCosmeticData(existing.cosmetic.data);
  const requestedUses = isStickerItem ? uses : undefined;
  const requestedPricePerUse = isStickerItem ? pricePerUse : undefined;
  const nextEconomics: StickerEconomics = {
    ...existingEconomics,
    ...(requestedUses !== undefined ? { uses: requestedUses } : {}),
    ...(requestedPricePerUse !== undefined ? { pricePerUse: requestedPricePerUse } : {}),
  };
  const nextUses = nextEconomics.uses;
  const usesChange = requestedUses !== undefined && requestedUses !== existingEconomics.uses;
  const pricePerUseChange =
    requestedPricePerUse !== undefined && requestedPricePerUse !== existingEconomics.pricePerUse;
  const economicsChange = usesChange || pricePerUseChange;

  // Cross-listings point at another creator's shared cosmetic — the seller may
  // never touch its art/name/description/payment terms, only price & quantity.
  // The slug belongs to the original creator too: a reseller renaming it would
  // break every owner's typed `:slug:` on someone else's cosmetic.
  const isOriginalCreator = isModerator || existing.cosmetic.createdById === userId;
  if (
    !isOriginalCreator &&
    (name !== undefined ||
      description !== undefined ||
      imageUrl !== undefined ||
      acceptsBlueBuzz !== undefined ||
      offsetsChange ||
      slugChange ||
      economicsChange)
  )
    throw throwBadRequestError(
      "You can only change price and quantity for another creator's cosmetic"
    );

  if (price != null) {
    const priceFloor = cosmeticPriceFloor(existing.cosmetic.type);
    if (price < priceFloor)
      throw throwBadRequestError(
        `This cosmetic type must be listed for at least ${priceFloor} Buzz`
      );
  }
  // Re-check the per-use floor whenever either side of it moves.
  const effectivePrice = price ?? existing.unitAmount;
  if (nextUses && effectivePrice < nextUses * STICKER_MIN_BUZZ_PER_USE)
    throw throwBadRequestError(
      `${nextUses} uses needs at least ${
        nextUses * STICKER_MIN_BUZZ_PER_USE
      } Buzz (${STICKER_MIN_BUZZ_PER_USE} per use)`
    );
  const perUseFloor = stickerPerUseFloor(existing.cosmetic.type);
  if (nextEconomics.pricePerUse && nextEconomics.pricePerUse < perUseFloor)
    throw throwBadRequestError(`A single use must cost at least ${perUseFloor} Buzz`);

  const isPublished = existing.status === CosmeticShopItemStatus.Published;
  const artChanged = imageUrl !== undefined;
  // A live item may already have buyers — creators may only change price &
  // quantity, but moderators can fix name/description/fit post-publish (the
  // edit stays live; it does not re-enter review).
  if (
    isPublished &&
    !isModerator &&
    (name !== undefined || description !== undefined || artChanged || offsetsChange)
  )
    throw throwBadRequestError('Published items can only change price and quantity');
  // The slug is the token owners type, not metadata. Renaming it breaks every
  // owner's muscle memory and their picker search, while already-sent messages
  // keep working off the id — so the creator gets no signal they broke anything.
  // Mods can still fix a genuine typo.
  if (isPublished && !isModerator && slugChange)
    throw throwBadRequestError('The sticker slug cannot be changed once published');
  // Buyers already have the art — it can't change once sold.
  if (artChanged && existing._count.purchases > 0)
    throw throwBadRequestError('Artwork cannot be changed once an item has sold');
  // The stored affirmation covers the art it was made against, so swapping the
  // art needs a fresh one. A moderator swapping art isn't claiming any rights of
  // their own, so they neither affirm nor overwrite the creator's record.
  const requiresAffirmation = artChanged && !isModerator;
  if (requiresAffirmation && !rightsAffirmed)
    throw throwBadRequestError('You must confirm you have the rights to sell this artwork');

  if (slugChange)
    await validateStickerCosmetic({
      id: existing.cosmetic.id,
      type: existing.cosmetic.type,
      data: { slug: nextSlug },
    });

  // Validate + build replaced artwork server-side.
  let artwork:
    | {
        data: Prisma.InputJsonValue;
        checks: AutoCheck[];
        imageMeta: CosmeticImageMeta;
        imageHash: string;
      }
    | undefined;
  if (artChanged && imageUrl) {
    const { checks, imageMeta, imageHash, allPassed } = await validateArtwork(
      imageUrl,
      existing.cosmetic.type
    );
    if (!allPassed)
      throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');
    if (await findDuplicateArtwork(imageHash, id))
      throw throwBadRequestError('This artwork has already been submitted to the shop.');
    checks.push({ key: 'duplicate', label: 'Original artwork', passed: true });
    artwork = {
      // The economics matter here: replacing artwork REBUILDS `data` rather than
      // patching it (patchCosmeticData returns artworkData wholesale), so
      // omitting uses silently turned a finite sticker into an unlimited one for
      // every future buyer.
      data: buildCosmeticData(
        existing.cosmetic.type,
        imageUrl,
        animated,
        nextOffsets,
        nextSlug,
        nextEconomics
      ) as Prisma.InputJsonValue,
      checks,
      imageMeta,
      imageHash,
    };
  }

  const contentChanged =
    name !== undefined ||
    description !== undefined ||
    artChanged ||
    offsetsChange ||
    slugChange ||
    economicsChange;
  const meta = (existing.meta ?? {}) as CosmeticShopItemMeta;
  const base = meta.lastApprovedAmount ?? existing.unitAmount;
  const bigPriceChange =
    price != null && base > 0 && Math.abs(price - base) / base > PRICE_REVIEW_THRESHOLD;

  // Published re-enters review only on a >±25% price change (a small tweak stays
  // live). RequestedChanges & PendingReview edits (re)enter the queue.
  const backToReview =
    (isPublished && bigPriceChange) ||
    existing.status === CosmeticShopItemStatus.RequestedChanges ||
    existing.status === CosmeticShopItemStatus.PendingReview;
  const status = backToReview ? CosmeticShopItemStatus.PendingReview : existing.status;

  if (contentChanged) {
    const patchedData = patchCosmeticData({
      existingData,
      artworkData: artwork?.data as Record<string, unknown> | undefined,
      offsetsChange,
      slugChange,
      economicsChange,
      nextOffsets,
      nextSlug,
      nextEconomics,
    }) as Prisma.InputJsonValue | undefined;
    await dbWrite.cosmetic.update({
      where: { id: existing.cosmeticId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(patchedData !== undefined ? { data: patchedData } : {}),
      },
    });
  }

  return dbWrite.cosmeticShopItem.update({
    where: { id },
    data: {
      ...(name !== undefined ? { title: name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(price != null ? { unitAmount: price } : {}),
      ...(availableQuantity !== undefined ? { availableQuantity } : {}),
      status,
      // Clear the prior verdict whenever it re-enters the review queue.
      ...(backToReview ? { rejectionReason: null, reviewedById: null, reviewedAt: null } : {}),
      meta: {
        ...meta,
        ...(acceptsBlueBuzz !== undefined ? { acceptsBlueBuzz } : {}),
        ...(artwork
          ? {
              autoChecks: artwork.checks,
              imageMeta: artwork.imageMeta,
              imageHash: artwork.imageHash,
            }
          : {}),
        ...(requiresAffirmation ? { rightsAffirmation: buildRightsAffirmation(userId) } : {}),
      } as Prisma.InputJsonValue,
    },
    select: creatorShopItemSelect,
  });
};

export const archiveCreatorShopItem = async ({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
}) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Item is already archived');
  const meta = (existing.meta ?? {}) as CosmeticShopItemMeta;
  const updated = await dbWrite.cosmeticShopItem.update({
    where: { id },
    data: {
      status: CosmeticShopItemStatus.Archived,
      archivedAt: new Date(),
      // Remember where to restore it to when unarchived.
      meta: { ...meta, preArchiveStatus: existing.status } as Prisma.InputJsonValue,
    },
    select: creatorShopItemSelect,
  });

  // An archived item can't be featured — free up its featured slot (owner must
  // re-feature it after unarchiving).
  if (existing.addedById) {
    const settings = await getCreatorShopSettings({ userId: existing.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: existing.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  return updated;
};

/**
 * Delisting withdraws an item from individual sale while leaving it Published,
 * so other creators can still bundle it. Archiving removes it from both.
 */
export const setCreatorShopItemListed = async ({
  userId,
  isModerator,
  id,
  listed,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
  listed: boolean;
}) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Restore this item before changing its listing');

  const updated = await dbWrite.cosmeticShopItem.update({
    where: { id },
    data: { listed },
    select: creatorShopItemSelect,
  });

  // A delisted item can't sit in a featured slot, same as an archived one.
  if (!listed && existing.addedById) {
    const settings = await getCreatorShopSettings({ userId: existing.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: existing.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  return updated;
};

export const unarchiveCreatorShopItem = async ({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
}) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  if (existing.status !== CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Only archived items can be restored');
  const { preArchiveStatus, ...meta } = (existing.meta ?? {}) as CosmeticShopItemMeta & {
    preArchiveStatus?: CosmeticShopItemStatus;
  };
  if (meta.takedown)
    throw throwBadRequestError('This item was taken down and cannot be restored to sale');
  return dbWrite.cosmeticShopItem.update({
    where: { id },
    data: {
      status: preArchiveStatus ?? CosmeticShopItemStatus.Published,
      archivedAt: null,
      meta: meta as Prisma.InputJsonValue,
    },
    select: creatorShopItemSelect,
  });
};

export const deleteCreatorShopItem = async ({
  userId,
  isModerator,
  id,
}: {
  userId: number;
  isModerator?: boolean;
  id: number;
}) => {
  // Deleting wipes purchase records — a moderator-only action; creators archive.
  if (!isModerator) throw throwAuthorizationError('Only moderators can delete shop items');
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  // Hard delete. FK cascades wipe the purchase records (sales totals) and any
  // official-shop section links. Buyers keep what they bought: UserCosmetic is
  // keyed by cosmeticId and the Cosmetic row is intentionally left in place.
  await dbWrite.cosmeticShopItem.delete({ where: { id } });

  // Free its featured slot. Stale ids in other creators' resoldItemIds
  // self-heal — the lookups drop ids that no longer resolve to an item.
  if (existing.addedById) {
    const settings = await getCreatorShopSettings({ userId: existing.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: existing.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  return { id, purchases: existing._count.purchases };
};

// A creator's own items (any status) for the "Manage your shop" view. The router
// only lets a moderator pass someone else's userId.
export const getCreatorShopManageItems = async ({ userId }: { userId: number }) => {
  const items = await dbRead.cosmeticShopItem.findMany({
    where: { addedById: userId },
    select: creatorShopItemSelect,
    orderBy: { createdAt: 'desc' },
  });
  return items.map(withRemaining);
};

// ---------------------------------------------------------------------------
// Public: creator storefront
// ---------------------------------------------------------------------------

export const getCreatorShop = async ({
  userId,
  viewerId,
  stickersEnabled,
  isModerator,
  preview,
}: {
  userId: number;
  viewerId?: number;
  stickersEnabled?: boolean;
  isModerator?: boolean;
  // Moderator-only design aid: ignore this creator's own inventory/config and
  // fill every section with real site-wide sample data (see the router — only
  // honored for mods).
  preview?: boolean;
}) => {
  const settings = await getCreatorShopSettings({ userId });
  // Owners and moderators can always see the shop (to edit / moderate); a
  // disabled shop is hidden from everyone else.
  if (!preview && viewerId !== userId && !isModerator && settings.enabled !== true)
    throw throwNotFoundError('Shop not found');

  // A block between viewer and shop owner (either direction) hides the whole
  // shop — same NotFound as a private shop so the block isn't revealed.
  const viewerPairIds =
    !preview && !isModerator && viewerId && viewerId !== userId
      ? await getBlockedPairIds(viewerId)
      : [];
  if (viewerPairIds.includes(userId)) throw throwNotFoundError('Shop not found');

  const now = new Date();
  const resoldIds = settings.resoldItemIds ?? [];
  // Blocks remove a resold item from the storefront: owner↔item-creator (the
  // block forbids the resale pairing; the owner still sees it in their manage
  // list so they can remove it) and viewer↔item-creator (a creator who blocked
  // the viewer shouldn't surface in any shop the viewer browses).
  const blockedPairIds = preview
    ? []
    : [...new Set([...(await getBlockedPairIds(userId)), ...viewerPairIds])];
  const [items, resoldItems, earlyAccessModelCount] = await Promise.all([
    dbRead.cosmeticShopItem.findMany({
      where: {
        status: CosmeticShopItemStatus.Published,
        listed: true,
        ...hideStickers(stickersEnabled),
        // Preview draws cosmetics from every creator so the section is populated
        // regardless of whose (possibly empty) shop is being viewed.
        ...(preview ? {} : { addedById: userId }),
        AND: [
          { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
          { OR: [{ availableTo: null }, { availableTo: { gte: now } }] },
        ],
      },
      // Reuse the official shop's selector (+ creator) so cards render with the
      // exact same <ShopItem> component + purchase modal as /shop.
      select: creatorStorefrontItemSelect,
      orderBy: { createdAt: 'desc' },
      ...(preview ? { take: 12 } : {}),
    }),
    // Resold items reference other creators' still-sellable published items —
    // one inventory, owned by the original creator (no copy). Preview shows a
    // sample of any sellable items instead of this creator's chosen list.
    dbRead.cosmeticShopItem.findMany({
      where: {
        ...(preview ? {} : { id: { in: resoldIds } }),
        status: CosmeticShopItemStatus.Published,
        // Delisted items stay Published (still bundlable) but are off sale, so
        // no individual-sale surface may show them — resale included.
        listed: true,
        ...hideStickers(stickersEnabled),
        meta: { path: ['sellableByOthers'], equals: true },
        // Hide resold items whose owner has since made their shop private.
        addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
        ...(blockedPairIds.length ? { addedById: { notIn: blockedPairIds } } : {}),
      },
      select: creatorStorefrontItemSelect,
      ...(preview ? { take: 6, orderBy: { id: 'desc' } } : {}),
    }),
    // Drives the Models section visibility — the storefront only lists the
    // creator's currently-Early-Access models (paid tiers come later). Preview
    // counts site-wide so the Models section always renders.
    dbRead.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT m.id)::int AS count
      FROM "Model" m
      JOIN "ModelVersion" mv ON mv."modelId" = m.id
      JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
      WHERE m.status = 'Published'::"ModelStatus" AND m."deletedAt" IS NULL
        AND mv.status = 'Published'::"ModelStatus"
        AND pa."endsAt" > NOW()
        ${preview ? Prisma.empty : Prisma.sql`AND m."userId" = ${userId}`}
    `.then((r) => r[0]?.count ?? 0),
  ]);

  // Sanitize meta to what the card/checkout needs — never the creator
  // payout/fee internals.
  const sanitize = (item: (typeof items)[number]) => ({
    ...item,
    meta: {
      purchases: (item.meta as CosmeticShopItemMeta)?.purchases ?? 0,
      acceptsBlueBuzz: (item.meta as CosmeticShopItemMeta)?.acceptsBlueBuzz ?? false,
    },
  });
  const cosmetics = items.map(sanitize);
  // Resold items keep the seller share so the buyer can see the split at checkout.
  const sanitizeResold = (item: (typeof resoldItems)[number]) => ({
    ...item,
    meta: {
      purchases: (item.meta as CosmeticShopItemMeta)?.purchases ?? 0,
      sellerShare: (item.meta as CosmeticShopItemMeta)?.sellerShare ?? 0,
      acceptsBlueBuzz: (item.meta as CosmeticShopItemMeta)?.acceptsBlueBuzz ?? false,
    },
  });
  const resold = preview
    ? resoldItems.map(sanitizeResold)
    : // Preserve the creator's chosen resold order.
      (() => {
        const resoldById = new Map(resoldItems.map((i) => [i.id, sanitizeResold(i)]));
        return resoldIds
          .map((id) => resoldById.get(id))
          .filter((x): x is ReturnType<typeof sanitizeResold> => !!x);
      })();
  const featured = preview
    ? cosmetics.slice(0, 3)
    : (settings.featuredItemIds ?? [])
        .map((fid) => cosmetics.find((c) => c.id === fid))
        .filter((x): x is (typeof cosmetics)[number] => !!x);

  // In preview, force every section on so the layout is fully exercised.
  const effectiveSettings = preview
    ? { ...settings, enabled: true, showModels: true, sections: undefined }
    : settings;

  return {
    cosmetics,
    featured,
    resold,
    settings: effectiveSettings,
    earlyAccessModelCount,
  };
};

// Site-wide hub feed of every published community cosmetic (creator-submitted
// items from public shops), newest first. Powers the /shop marketplace section.
export const getCommunityCosmetics = async ({
  viewerId,
  limit,
  cursor,
  cosmeticTypes,
  stickersEnabled,
}: GetCommunityCosmeticsInput & { viewerId?: number; stickersEnabled?: boolean }) => {
  const now = new Date();
  // A block between viewer and a cosmetic's creator (either direction) hides
  // that creator's items from the feed.
  const blockedPairIds = viewerId ? await getBlockedPairIds(viewerId) : [];
  const raw = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      // Discovery surface that leads straight to checkout — a delisted item
      // here would be a dead end.
      listed: true,
      // Creator-submitted only (official cosmetics have no creator). Blocks
      // filter both the original creator and the lister — they can differ on
      // cross-listed items.
      cosmetic: {
        createdById: {
          not: null,
          ...(blockedPairIds.length ? { notIn: blockedPairIds } : {}),
        },
        // Merged into one `type` filter: a second `type` key would silently
        // overwrite the caller's requested types.
        ...(cosmeticTypes?.length || !stickersEnabled
          ? {
              type: {
                ...(cosmeticTypes?.length ? { in: cosmeticTypes } : {}),
                ...(stickersEnabled ? {} : { not: CosmeticType.Sticker }),
              },
            }
          : {}),
      },
      // Only items whose owner's shop is public.
      addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
      ...(blockedPairIds.length ? { addedById: { notIn: blockedPairIds } } : {}),
      AND: [
        { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
        { OR: [{ availableTo: null }, { availableTo: { gte: now } }] },
      ],
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
    orderBy: { id: 'desc' },
    // addedById lets the client attribute the purchase to the owner's shop.
    select: { ...creatorStorefrontItemSelect, addedById: true },
  });
  let nextCursor: number | undefined;
  if (raw.length > limit) nextCursor = raw.pop()?.id;
  // Same meta sanitation as the storefront.
  const items = raw.map((item) => ({
    ...item,
    meta: {
      purchases: (item.meta as CosmeticShopItemMeta)?.purchases ?? 0,
      acceptsBlueBuzz: (item.meta as CosmeticShopItemMeta)?.acceptsBlueBuzz ?? false,
    },
  }));
  return { items, nextCursor };
};

// Early Access download prices for the shop's Models section, keyed by model
// version id (the model feed doesn't carry earlyAccessConfig).
export const getEarlyAccessModelPrices = async ({ modelVersionIds }: GetEarlyAccessPricesInput) => {
  const prices: Record<number, number> = {};
  if (!modelVersionIds.length) return prices;
  const paidAccess = await getPaidAccess('ModelVersion', modelVersionIds);
  const gatedIds = modelVersionIds.filter((id) => paidAccess[id]?.terms);
  if (!gatedIds.length) return prices;

  // Owner comes from the model, not PaidAccess.ownerId, so a transferred model prices off whoever owns
  // it now. The shop is a public listing — no viewer, so nobody gets the owner's stored prices.
  const owners = await dbRead.modelVersion.findMany({
    where: { id: { in: gatedIds } },
    select: { id: true, baseModel: true, model: { select: { userId: true } } },
  });
  const monetization = await getViewerMonetization({
    versions: owners.map((v) => ({ id: v.id, ownerId: v.model.userId, baseModel: v.baseModel })),
    viewer: {},
  });

  for (const id of gatedIds) {
    const terms = monetization[id]?.paidAccess?.terms as ModelVersionTerms | undefined;
    const price = terms?.download?.price ?? 0;
    if (price > 0) prices[id] = price;
  }
  return prices;
};

// ---------------------------------------------------------------------------
// Cross-creator selling: resell another creator's sellable shop item
// ---------------------------------------------------------------------------

// Gallery of published shop items other creators have marked sellable, excluding
// the caller's own and ones they already resell.
export const getPublicShopItemsForResale = async ({
  userId,
  limit,
  cursor,
  cosmeticTypes,
  query,
  stickersEnabled,
}: GetPublicShopItemsInput & { userId: number; stickersEnabled?: boolean }) => {
  const settings = await getCreatorShopSettings({ userId });
  const alreadyResold = settings.resoldItemIds ?? [];
  // A block in either direction removes the pairing from the resale gallery.
  const blockedPairIds = await getBlockedPairIds(userId);
  const raw = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      meta: { path: ['sellableByOthers'], equals: true },
      addedById: {
        not: userId,
        ...(blockedPairIds.length ? { notIn: blockedPairIds } : {}),
      },
      // Only surface items from creators whose shop is public (enabled).
      addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { addedBy: { username: { contains: query, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(cosmeticTypes?.length || !stickersEnabled
        ? {
            cosmetic: {
              type: {
                ...(cosmeticTypes?.length ? { in: cosmeticTypes } : {}),
                ...(stickersEnabled ? {} : { not: CosmeticType.Sticker }),
              },
            },
          }
        : {}),
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
    orderBy: { id: 'desc' },
    select: {
      id: true,
      unitAmount: true,
      availableQuantity: true,
      meta: true,
      listed: true,
      cosmetic: { select: { id: true, name: true, type: true, data: true } },
      addedBy: { select: { id: true, username: true, image: true } },
    },
  });
  let nextCursor: number | undefined;
  if (raw.length > limit) nextCursor = raw.pop()?.id;
  const items = raw.map(({ meta, ...i }) => ({
    ...i,
    sellerShare: (meta as CosmeticShopItemMeta | null)?.sellerShare ?? 0,
    // Already in this creator's shop — the picker shows it as added/removable.
    isResold: alreadyResold.includes(i.id),
    // Delisted items stay in the picker, badged. Resale is by reference, so one
    // that's temporarily off sale starts working again when its creator relists
    // — hiding it would just make the reseller find it again later.
    listed: i.listed,
  }));
  return { items, nextCursor };
};

// Load + validate a sellable shop item the caller may resell.
const getResellableItemOrThrow = async (shopItemId: number, userId: number) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: { id: true, status: true, addedById: true, meta: true },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  const meta = (item.meta ?? {}) as CosmeticShopItemMeta;
  if (!meta.sellableByOthers)
    throw throwAuthorizationError('This item is not available for other creators to sell');
  if (item.status !== CosmeticShopItemStatus.Published)
    throw throwBadRequestError('Only published items can be resold');
  if (item.addedById === userId) throw throwBadRequestError('This is already your own item');
  // NotFound (not authorization) so the block itself isn't revealed, mirroring
  // the read-side block enforcement.
  if (item.addedById && (await getBlockedPairIds(userId)).includes(item.addedById))
    throw throwNotFoundError('Shop item not found');
  return item;
};

export const addResoldItem = async ({
  userId,
  shopItemId,
}: ResoldItemInput & { userId: number }) => {
  await getResellableItemOrThrow(shopItemId, userId);
  const settings = await getCreatorShopSettings({ userId });
  const resoldItemIds = settings.resoldItemIds ?? [];
  if (resoldItemIds.includes(shopItemId))
    throw throwBadRequestError('You are already reselling this item');
  return updateCreatorShopSettings({ userId, resoldItemIds: [...resoldItemIds, shopItemId] });
};

export const removeResoldItem = async ({
  userId,
  shopItemId,
}: ResoldItemInput & { userId: number }) => {
  const settings = await getCreatorShopSettings({ userId });
  const resoldItemIds = (settings.resoldItemIds ?? []).filter((id) => id !== shopItemId);
  return updateCreatorShopSettings({ userId, resoldItemIds });
};

// The creator's own resell listings, in their saved order — powers the manage
// picker's reorder list. Unlike the storefront query this keeps items whose
// source shop is currently private so the owner can still see and remove them.
export const getResoldItemsForManage = async ({ userId }: { userId: number }) => {
  const settings = await getCreatorShopSettings({ userId });
  const resoldIds = settings.resoldItemIds ?? [];
  if (!resoldIds.length) return [];
  const rows = await dbRead.cosmeticShopItem.findMany({
    where: { id: { in: resoldIds } },
    select: {
      id: true,
      unitAmount: true,
      meta: true,
      cosmetic: { select: { id: true, name: true, type: true, data: true } },
      addedBy: { select: { id: true, username: true, image: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return resoldIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map(({ meta, ...r }) => ({
      ...r,
      sellerShare: (meta as CosmeticShopItemMeta | null)?.sellerShare ?? 0,
    }));
};

// ---------------------------------------------------------------------------
// Moderator: review queue
// ---------------------------------------------------------------------------

export const getCreatorShopReviewQueue = async ({
  limit,
  cursor,
  status,
  username,
  userId,
  cosmeticTypes,
}: GetReviewQueueInput) => {
  const items = await dbRead.cosmeticShopItem.findMany({
    where: {
      // A specific status filters to it (including Archived); no status = every
      // status except Archived (the "All" option in the review queue).
      ...(status ? { status } : { status: { not: CosmeticShopItemStatus.Archived } }),
      // Only creator-submitted items (exclude official/admin cosmetics).
      cosmetic: {
        createdById: userId ?? { not: null },
        ...(cosmeticTypes?.length ? { type: { in: cosmeticTypes } } : {}),
        ...(username ? { creator: { username: { contains: username, mode: 'insensitive' } } } : {}),
      },
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
    orderBy: { createdAt: 'asc' },
    select: {
      ...creatorShopItemSelect,
      cosmetic: {
        select: {
          id: true,
          name: true,
          type: true,
          data: true,
          videoUrl: true,
          createdById: true,
          source: true,
          description: true,
          creator: { select: { id: true, username: true, image: true } },
        },
      },
    },
  });

  let nextCursor: number | undefined;
  if (items.length > limit) nextCursor = items.pop()?.id;
  return { items, nextCursor };
};

// Backs the review queue's creator filter: every user who has ever submitted a
// shop item, mirroring the queue's own creator predicate (a creator-owned
// cosmetic with at least one shop item). Deliberately not scoped to the active
// status/type filters so the selection survives flipping between them. The set
// is small enough to send whole — no cursor.
export const getCreatorShopReviewQueueCreators = async () => {
  const creators = await dbRead.user.findMany({
    where: {
      username: { not: null },
      createdCosmetics: { some: { cosmeticShopItems: { some: {} } } },
    },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
  return creators.map(({ id, username }) => ({ id, username: username as string }));
};

export const reviewCreatorShopItem = async ({
  reviewerId,
  id,
  action,
  rejectionReason,
}: ReviewCreatorShopItemInput & { reviewerId: number }) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      unitAmount: true,
      status: true,
      meta: true,
      title: true,
      addedById: true,
      cosmetic: {
        // type + data feed creatorGrantRemaining below.
        select: {
          createdById: true,
          type: true,
          data: true,
          creator: { select: { username: true } },
        },
      },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  if (item.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be reviewed');
  if (action === 'revert' && item.status !== CosmeticShopItemStatus.Published)
    throw throwBadRequestError('Only published items can be reverted to pending review');

  const meta = (item.meta ?? {}) as CosmeticShopItemMeta;
  const now = new Date();
  const reviewFields = { reviewedById: reviewerId, reviewedAt: now };

  const updated =
    action === 'approve'
      ? // Publish + record the approved price. Payout is wired at purchase time
        // from cosmetic.createdById — no paidToUserIds needed.
        await dbWrite.cosmeticShopItem.update({
          where: { id },
          data: {
            ...reviewFields,
            status: CosmeticShopItemStatus.Published,
            rejectionReason: null,
            meta: { ...meta, lastApprovedAmount: item.unitAmount } as Prisma.InputJsonValue,
          },
          select: creatorShopItemSelect,
        })
      : // reject = terminal; request-changes = creator can edit & resubmit;
        // revert = unpublish back into the review queue. The note is kept on
        // rejectionReason so both the queue and the creator see why.
        await dbWrite.cosmeticShopItem.update({
          where: { id },
          data: {
            ...reviewFields,
            status:
              action === 'reject'
                ? CosmeticShopItemStatus.Rejected
                : action === 'revert'
                ? CosmeticShopItemStatus.PendingReview
                : CosmeticShopItemStatus.RequestedChanges,
            rejectionReason: rejectionReason ?? null,
          },
          select: creatorShopItemSelect,
        });

  // On approval, grant the creator their own cosmetic (idempotent).
  if (action === 'approve' && item.cosmetic.createdById) {
    await dbWrite.userCosmetic.createMany({
      data: [
        {
          userId: item.cosmetic.createdById,
          cosmeticId: item.cosmeticId,
          claimKey: 'creator-shop',
          remaining: creatorGrantRemaining(item.cosmetic.type, item.cosmetic.data),
        },
      ],
      skipDuplicates: true,
    });
    await refreshOwnedStickerCache([item.cosmetic.createdById]);
  }

  // An unpublished item can't stay featured — free up its slot.
  if (action === 'revert' && item.addedById) {
    const settings = await getCreatorShopSettings({ userId: item.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: item.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  // Let the creator know the review outcome (best-effort).
  const creatorId = item.cosmetic.createdById;
  if (creatorId) {
    const username = item.cosmetic.creator?.username ?? undefined;
    const type =
      action === 'approve'
        ? 'creator-shop-item-approved'
        : action === 'request-changes'
        ? 'creator-shop-item-changes-requested'
        : action === 'revert'
        ? 'creator-shop-item-reverted'
        : 'creator-shop-item-rejected';
    await createNotification({
      type,
      userId: creatorId,
      category: NotificationCategory.System,
      // Approvals dedupe per item; review verdicts can recur, so stamp them.
      key: action === 'approve' ? `${type}:${id}` : `${type}:${id}:${now.getTime()}`,
      details: { title: item.title, username, reason: rejectionReason ?? undefined },
    });
  }

  return updated;
};

type TakedownFailure = {
  stage: 'refund' | 'clawback';
  userId: number;
  amount?: number;
  error: string;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error');

// A takedown can run for minutes across hundreds of Buzz calls, so every money
// move gets a few attempts before it's written off as a failure a human has to
// finish. Transient 5xx/timeouts from the Buzz service are the common case.
const TAKEDOWN_MONEY_RETRIES = 3;
const TAKEDOWN_RETRY_DELAY_MS = 1000;

const takedownMoneyMove = <T>(fn: () => Promise<T>) =>
  withRetries(fn, TAKEDOWN_MONEY_RETRIES, TAKEDOWN_RETRY_DELAY_MS);

const logTakedown = (level: 'info' | 'error', message: string, data: MixedObject) =>
  logToAxiom({ level, name: 'cosmetic-takedown', message, data }).catch(() => undefined);

/**
 * Pull a cosmetic that can't stay on sale (IP infringement / TOS) in one
 * operation: stop sales, refund every buyer, take back the Buzz the seller was
 * paid for those sales, and strip the cosmetic from everyone who owns or has it
 * equipped.
 *
 * The creator's submission fee is deliberately NOT refunded — a takedown is a
 * terms violation, and the fee paid for the review that caught it.
 *
 * Money moves are best-effort per buyer: one failed refund doesn't abort the
 * rest, it lands in `failures` for a moderator to finish by hand.
 */
export const takedownCosmeticShopItem = async ({
  id,
  reason,
  moderatorId,
}: TakedownCosmeticShopItemInput & { moderatorId: number }) => {
  const item = await dbRead.cosmeticShopItem.findUnique({
    where: { id },
    select: {
      id: true,
      cosmeticId: true,
      title: true,
      meta: true,
      addedById: true,
      cosmetic: { select: { createdById: true, creator: { select: { username: true } } } },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');

  const meta = (item.meta ?? {}) as CosmeticShopItemMeta;
  const now = new Date();

  // Stop sales first so nothing can be bought while the refunds run.
  const updated = await dbWrite.cosmeticShopItem.update({
    where: { id },
    data: {
      status: CosmeticShopItemStatus.Archived,
      listed: false,
      archivedAt: now,
      meta: {
        ...meta,
        takedown: { reason, moderatorId, at: now.toISOString() },
      } as Prisma.InputJsonValue,
    },
    select: creatorShopItemSelect,
  });
  // Official-shop placements are curated rows, not a status filter — drop them
  // or the item keeps rendering in its section.
  await dbWrite.cosmeticShopSectionItem.deleteMany({ where: { shopItemId: id } });

  if (item.addedById) {
    const settings = await getCreatorShopSettings({ userId: item.addedById });
    const featuredItemIds = settings.featuredItemIds ?? [];
    if (featuredItemIds.includes(id))
      await updateCreatorShopSettings({
        userId: item.addedById,
        featuredItemIds: featuredItemIds.filter((fid) => fid !== id),
      });
  }

  // Primary, not the replica: a sale made seconds ago may not have replicated
  // yet, and missing it would strip that buyer's cosmetic without refunding it.
  const purchases = await dbWrite.userCosmeticShopPurchases.findMany({
    where: { shopItemId: id, refunded: false },
    select: { userId: true, buzzTransactionId: true, unitAmount: true, meta: true },
  });

  const failures: TakedownFailure[] = [];
  // Payouts we can undo by refunding the exact transaction that paid them.
  const refundablePayouts: { userId: number; amount: number; transactionId: string }[] = [];
  // Everything else has to be reversed by charging the recipient, keyed per
  // recipient AND color: payouts were made in the colors the buyer paid with, so
  // they have to come back the same way.
  const clawback = new Map<string, number>();
  const addClawback = (userId: number, color: BuzzSpendType, amount: number) => {
    if (amount <= 0) return;
    const key = `${userId}:${color}`;
    clawback.set(key, (clawback.get(key) ?? 0) + amount);
  };

  const creatorId = item.cosmetic.createdById;
  let unrecoveredResellerShare = 0;
  let refundedValue = 0;
  const refundedUserIds: number[] = [];

  await logTakedown('info', 'Takedown started', {
    shopItemId: id,
    moderatorId,
    reason,
    purchases: purchases.length,
  });

  for (const purchase of purchases) {
    const price = purchase.unitAmount;
    let refund: Awaited<ReturnType<typeof refundMultiAccountTransaction>>;
    try {
      refund = await takedownMoneyMove(() =>
        refundMultiAccountTransaction({
          externalTransactionIdPrefix: purchase.buzzTransactionId,
          description: `Cosmetic removed - ${item.title}`,
        })
      );
    } catch (error) {
      failures.push({
        stage: 'refund',
        userId: purchase.userId,
        amount: price,
        error: errorMessage(error),
      });
      // The buyer loses the cosmetic below regardless, so an unrefunded sale is
      // money owed to a real person — loud, and with the ids needed to finish it.
      await logTakedown('error', 'Buyer refund failed', {
        shopItemId: id,
        userId: purchase.userId,
        buzzTransactionId: purchase.buzzTransactionId,
        amount: price,
        error: errorMessage(error),
      });
      continue;
    }

    await dbWrite.userCosmeticShopPurchases.update({
      where: { buzzTransactionId: purchase.buzzTransactionId },
      data: { refunded: true },
    });
    refundedUserIds.push(purchase.userId);
    refundedValue += price;

    // Sales made since the payout-recording migration carry exactly who was paid
    // what, in which color — reverse those verbatim, refunding the payout
    // transaction itself where its id was recorded.
    const recordedPayouts = (purchase.meta as CosmeticPurchaseMeta | null)?.payouts;
    if (recordedPayouts?.length) {
      for (const payout of recordedPayouts) {
        if (payout.amount <= 0) continue;
        if (payout.transactionId)
          refundablePayouts.push({
            userId: payout.userId,
            amount: payout.amount,
            transactionId: payout.transactionId,
          });
        else addClawback(payout.userId, payout.color as BuzzSpendType, payout.amount);
      }
      continue;
    }

    // Legacy rows (pre-migration): the split has to be re-derived from the item.
    const bluePaid = refund.refundedTransactions
      .filter((t) => t.accountType === 'blue')
      .reduce((sum, t) => sum + t.amount, 0);
    const domainColor = (refund.refundedTransactions.find((t) => t.accountType !== 'blue')
      ?.accountType ?? 'yellow') as BuzzSpendType;

    const { creatorPool, creatorAmount, sellerAmount } = computeCreatorShopSplit(
      price,
      meta.sellerShare ?? 0
    );
    let recipients: { userId: number; amount: number }[];
    if (creatorId) {
      // Without a payout record there's no way to tell whether another creator's
      // storefront or the platform took the seller share, so a resellable item
      // only claws back what the creator is certain to have received.
      recipients = [
        { userId: creatorId, amount: meta.sellableByOthers ? creatorAmount : creatorPool },
      ];
      if (meta.sellableByOthers) unrecoveredResellerShare += sellerAmount;
    } else {
      const paidToUserIds = meta.paidToUserIds ?? [];
      recipients = paidToUserIds.map((uid) => ({
        userId: uid,
        amount: Math.floor(price / paidToUserIds.length),
      }));
    }

    for (const recipient of recipients) {
      const blue = price > 0 ? Math.floor((recipient.amount * bluePaid) / price) : 0;
      addClawback(recipient.userId, 'blue', blue);
      addClawback(recipient.userId, domainColor, recipient.amount - blue);
    }
  }

  let clawedBack = 0;
  // Refunding the payout transaction is the cleanest reversal: the Buzz service
  // ties it to the original, so it can't double-apply and needs no external id of
  // our own.
  for (const payout of refundablePayouts) {
    try {
      await takedownMoneyMove(() =>
        refundTransaction(payout.transactionId, `Cosmetic removed - ${item.title}`)
      );
      clawedBack += payout.amount;
    } catch (error) {
      failures.push({
        stage: 'clawback',
        userId: payout.userId,
        amount: payout.amount,
        error: errorMessage(error),
      });
      await logTakedown('error', 'Payout refund failed', {
        shopItemId: id,
        userId: payout.userId,
        payoutTransactionId: payout.transactionId,
        amount: payout.amount,
        error: errorMessage(error),
      });
    }
  }

  for (const [key, amount] of clawback) {
    const [recipientId, color] = key.split(':') as [string, BuzzSpendType];
    // Retried on the same external id on purpose: if an attempt actually landed
    // before erroring, the duplicate is rejected rather than charged twice.
    const externalTransactionId = `cosmetic-takedown-${id}:clawback:${recipientId}:${color}:${now.getTime()}`;
    try {
      await takedownMoneyMove(() =>
        createBuzzTransaction({
          fromAccountId: Number(recipientId),
          fromAccountType: color,
          toAccountId: 0,
          amount,
          type: TransactionType.Refund,
          description: `Cosmetic removed - earnings reversed - ${item.title}`,
          // Stamped per run: the amount is an aggregate over the sales refunded in
          // THIS run, so a second takedown pass (sales that failed or landed late)
          // must not be swallowed as a duplicate of the first.
          externalTransactionId,
        })
      );
      clawedBack += amount;
    } catch (error) {
      failures.push({
        stage: 'clawback',
        userId: Number(recipientId),
        amount,
        error: errorMessage(error),
      });
      await logTakedown('error', 'Earnings clawback failed', {
        shopItemId: id,
        userId: Number(recipientId),
        color,
        amount,
        externalTransactionId,
        error: errorMessage(error),
      });
    }
  }

  // Everyone loses the cosmetic — buyers, the creator's own grant, and anyone it
  // was gifted to. Equipped placements are cleaned up by the revoke helper.
  const owners = await dbWrite.userCosmetic.findMany({
    where: { cosmeticId: item.cosmeticId },
    select: { userId: true },
  });
  const ownerIds = [...new Set(owners.map((o) => o.userId))];
  const { revoked } = ownerIds.length
    ? await revokeCosmeticsFromUsers({ userIds: ownerIds, cosmeticIds: [item.cosmeticId] })
    : { revoked: 0 };

  if (creatorId) {
    await createNotification({
      type: 'creator-shop-item-taken-down',
      userId: creatorId,
      category: NotificationCategory.System,
      key: `creator-shop-item-taken-down:${id}:${now.getTime()}`,
      details: { title: item.title, reason },
    });
  }
  for (const userId of new Set(refundedUserIds)) {
    await createNotification({
      type: 'cosmetic-shop-item-taken-down',
      userId,
      category: NotificationCategory.System,
      key: `cosmetic-shop-item-taken-down:${id}:${userId}`,
      details: { title: item.title },
    });
  }

  const owedBack =
    refundablePayouts.reduce((sum, p) => sum + p.amount, 0) +
    [...clawback.values()].reduce((sum, amount) => sum + amount, 0);

  // One record per run with the totals, so a partially-completed takedown can be
  // reconciled without replaying the individual failure logs.
  await logTakedown(failures.length ? 'error' : 'info', 'Takedown finished', {
    shopItemId: id,
    moderatorId,
    purchases: purchases.length,
    refunded: refundedUserIds.length,
    refundedValue,
    owedBack,
    clawedBack,
    unrecoveredResellerShare,
    revokedFrom: revoked,
    failures,
  });

  return {
    item: updated,
    purchases: purchases.length,
    refunded: refundedUserIds.length,
    refundedValue,
    // What the sellers were paid for the refunded sales, and the share of those
    // sales it represents — `clawedBack` is what actually moved back, `owedBack`
    // what was due, so a failed transfer is visible as the gap between them.
    owedBack,
    clawedBack,
    clawedBackPct: refundedValue > 0 ? Math.round((owedBack / refundedValue) * 100) : 0,
    unrecoveredResellerShare,
    revokedFrom: revoked,
    failures,
  };
};

// ---------------------------------------------------------------------------
// Shop settings (stored on User.settings JSON — no dedicated table)
// ---------------------------------------------------------------------------

type CreatorShopSettings = NonNullable<UserSettingsSchema['creatorShop']>;

export const getCreatorShopSettings = async ({
  userId,
}: {
  userId: number;
}): Promise<CreatorShopSettings> => {
  const user = await dbRead.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = (user?.settings ?? {}) as UserSettingsSchema;
  return settings.creatorShop ?? {};
};

export const updateCreatorShopSettings = async ({
  userId,
  ...patch
}: UpdateCreatorShopSettingsInput & { userId: number }) => {
  // Read-merge-write the JSON blob so we only touch the creatorShop key.
  return dbWrite.$transaction(async (tx) => {
    if (patch.enabled === true) {
      // Don't let a creator publish an empty shop — there'd be nothing to show.
      const itemCount = await tx.cosmeticShopItem.count({ where: { addedById: userId } });
      if (itemCount === 0)
        throw throwBadRequestError('Add at least one item to your shop before publishing.');
    }

    const user = await tx.user.findUnique({ where: { id: userId }, select: { settings: true } });
    const settings = (user?.settings ?? {}) as UserSettingsSchema;
    const creatorShop: CreatorShopSettings = { ...(settings.creatorShop ?? {}), ...patch };
    await tx.user.update({
      where: { id: userId },
      data: { settings: { ...settings, creatorShop } as Prisma.InputJsonValue },
    });
    return creatorShop;
  });
};
