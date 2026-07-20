import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead, dbWrite } from '~/server/db/client';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { hasValidCreatorMembership } from '~/server/services/creator-program.service';
import { createNotification } from '~/server/services/notification.service';
import { NotificationCategory, OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  CosmeticShopItemStatus,
  CosmeticSource,
  CosmeticType,
  MediaType,
  ModelStatus,
} from '~/shared/utils/prisma/enums';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
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
  PRICE_REVIEW_THRESHOLD,
  cosmeticDimensionsLabel,
  cosmeticDimensionsPass,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import type {
  AutoCheck,
  CosmeticImageMeta,
  GetEarlyAccessPricesInput,
  GetPublicShopItemsInput,
  GetReviewQueueInput,
  ResoldItemInput,
  ReviewCreatorShopItemInput,
  SubmitCreatorShopItemInput,
  UpdateCreatorShopItemInput,
  UpdateCreatorShopSettingsInput,
} from '~/server/schema/creator-shop.schema';
import type { ModelVersionEarlyAccessConfig } from '~/server/schema/model-version.schema';

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
const buildCosmeticData = (type: CosmeticType, imageUrl: string, animated?: boolean) => {
  if (type === CosmeticType.ProfileBackground)
    return { url: imageUrl, type: MediaType.image, animated: !!animated };
  if (type === CosmeticType.Badge || type === CosmeticType.ProfileDecoration)
    return { url: imageUrl, animated: !!animated };
  return { url: imageUrl };
};

// Server-side artwork validation (source of truth). Fetches the original upload
// and inspects it with sharp against the per-type requirements.
const validateArtwork = async (imageUrl: string, type: CosmeticType) => {
  const req = cosmeticImageRequirements(type);

  let width = 0;
  let height = 0;
  let format: string | undefined;
  let hasTransparency = false;
  let imageHash = '';
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

// ---------------------------------------------------------------------------
// Creator: submit & manage
// ---------------------------------------------------------------------------

// The shop is gated on Creator Program *membership* — i.e. the creator has
// joined (OnboardingSteps.CreatorProgram), which requires a valid subscription,
// the minimum creator score, and not being banned. A qualifying-but-not-joined
// subscription is not enough.
const assertCreatorProgramMember = async (userId: number) => {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: { onboarding: true },
  });
  const joined = !!user && Flags.hasFlag(user.onboarding, OnboardingSteps.CreatorProgram);
  if (!joined)
    throw throwAuthorizationError('The Creator Shop is available to Creator Program members only');
  // Membership must still be active — a lapsed membership loses shop access.
  if (!(await hasValidCreatorMembership(userId)))
    throw throwAuthorizationError(
      'An active Creator Program membership is required. Renew your membership to use your shop.'
    );
};

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
}: SubmitCreatorShopItemInput & { userId: number }) => {
  // The Creator Shop is a Creator Program member benefit.
  await assertCreatorProgramMember(userId);

  // Validate the artwork server-side BEFORE charging anything.
  const { checks, imageMeta, imageHash, allPassed } = await validateArtwork(imageUrl, cosmeticType);
  if (!allPassed)
    throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');

  // Reject duplicate artwork before charging the fee.
  if (await findDuplicateArtwork(imageHash))
    throw throwBadRequestError('This artwork has already been submitted to the shop.');
  checks.push({ key: 'duplicate', label: 'Original artwork', passed: true });

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
          data: buildCosmeticData(cosmeticType, imageUrl, animated) as Prisma.InputJsonValue,
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
      cosmetic: { select: { createdById: true, type: true } },
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
}: UpdateCreatorShopItemInput & { userId: number; isModerator?: boolean }) => {
  const existing = await getOwnedItemOrThrow(id, userId, isModerator);
  // Rejected is terminal; archived items must be restored before editing.
  if (existing.status === CosmeticShopItemStatus.Rejected)
    throw throwBadRequestError('Rejected items cannot be edited');
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be edited');

  // Cross-listings point at another creator's shared cosmetic — the seller may
  // never touch its art/name/description, only price & quantity.
  const isOriginalCreator = isModerator || existing.cosmetic.createdById === userId;
  if (
    !isOriginalCreator &&
    (name !== undefined || description !== undefined || imageUrl !== undefined)
  )
    throw throwBadRequestError(
      "You can only change price and quantity for another creator's cosmetic"
    );

  const isPublished = existing.status === CosmeticShopItemStatus.Published;
  const artChanged = imageUrl !== undefined;
  // A live item may already have buyers — only price & quantity may change.
  if (isPublished && (name !== undefined || description !== undefined || artChanged))
    throw throwBadRequestError('Published items can only change price and quantity');
  // Buyers already have the art — it can't change once sold.
  if (artChanged && existing._count.purchases > 0)
    throw throwBadRequestError('Artwork cannot be changed once an item has sold');

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
      data: buildCosmeticData(existing.cosmetic.type, imageUrl, animated) as Prisma.InputJsonValue,
      checks,
      imageMeta,
      imageHash,
    };
  }

  const contentChanged = name !== undefined || description !== undefined || artChanged;
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
    await dbWrite.cosmetic.update({
      where: { id: existing.cosmeticId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(artwork ? { data: artwork.data } : {}),
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
        ...(artwork
          ? {
              autoChecks: artwork.checks,
              imageMeta: artwork.imageMeta,
              imageHash: artwork.imageHash,
            }
          : {}),
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
  return dbWrite.cosmeticShopItem.update({
    where: { id },
    data: {
      status: CosmeticShopItemStatus.Archived,
      archivedAt: new Date(),
      // Remember where to restore it to when unarchived.
      meta: { ...meta, preArchiveStatus: existing.status } as Prisma.InputJsonValue,
    },
    select: creatorShopItemSelect,
  });
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
  isModerator,
  preview,
}: {
  userId: number;
  viewerId?: number;
  isModerator?: boolean;
  // Moderator-only design aid: ignore this creator's own inventory/config and
  // fill every section with real site-wide sample data (see the router — only
  // honored for mods).
  preview?: boolean;
}) => {
  const settings = await getCreatorShopSettings({ userId });
  // A shop is only public if it's enabled AND the owner still has an active
  // Creator Program membership. Query membership only for enabled shops (draft
  // shops are hidden regardless).
  const membershipActive =
    settings.enabled !== true ? true : await hasValidCreatorMembership(userId);
  // Enabled but hidden because the owner's membership lapsed — surfaced to the
  // owner so they know to renew.
  const membershipLapsed = !preview && settings.enabled === true && !membershipActive;

  // Owners and moderators can always see the shop (to renew / moderate); a
  // lapsed membership shutters it for everyone else.
  if (
    !preview &&
    viewerId !== userId &&
    !isModerator &&
    (settings.enabled !== true || !membershipActive)
  )
    throw throwNotFoundError('Shop not found');

  const now = new Date();
  const resoldIds = settings.resoldItemIds ?? [];
  const [items, resoldItems, earlyAccessModelCount] = await Promise.all([
    dbRead.cosmeticShopItem.findMany({
      where: {
        status: CosmeticShopItemStatus.Published,
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
        meta: { path: ['sellableByOthers'], equals: true },
        // Hide resold items whose owner has since made their shop private.
        addedBy: { settings: { path: ['creatorShop', 'enabled'], equals: true } },
      },
      select: creatorStorefrontItemSelect,
      ...(preview ? { take: 6, orderBy: { id: 'desc' } } : {}),
    }),
    // Drives the Models section visibility — the storefront only lists the
    // creator's currently-Early-Access models (paid tiers come later). Preview
    // counts site-wide so the Models section always renders.
    dbRead.model.count({
      where: {
        ...(preview ? {} : { userId }),
        status: ModelStatus.Published,
        deletedAt: null,
        earlyAccessDeadline: { gte: now },
      },
    }),
  ]);

  // Sanitize meta to only the purchase count the card needs — never the creator
  // payout/fee internals.
  const sanitize = (item: (typeof items)[number]) => ({
    ...item,
    meta: { purchases: (item.meta as CosmeticShopItemMeta)?.purchases ?? 0 },
  });
  const cosmetics = items.map(sanitize);
  // Resold items keep the seller share so the buyer can see the split at checkout.
  const sanitizeResold = (item: (typeof resoldItems)[number]) => ({
    ...item,
    meta: {
      purchases: (item.meta as CosmeticShopItemMeta)?.purchases ?? 0,
      sellerShare: (item.meta as CosmeticShopItemMeta)?.sellerShare ?? 0,
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
    membershipLapsed,
  };
};

// Early Access download prices for the shop's Models section, keyed by model
// version id (the model feed doesn't carry earlyAccessConfig).
export const getEarlyAccessModelPrices = async ({ modelVersionIds }: GetEarlyAccessPricesInput) => {
  const prices: Record<number, number> = {};
  if (!modelVersionIds.length) return prices;
  const versions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: { id: true, earlyAccessConfig: true },
  });
  for (const v of versions) {
    const cfg = v.earlyAccessConfig as ModelVersionEarlyAccessConfig | null;
    if (cfg?.chargeForDownload && cfg.downloadPrice) prices[v.id] = cfg.downloadPrice;
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
}: GetPublicShopItemsInput & { userId: number }) => {
  const settings = await getCreatorShopSettings({ userId });
  const alreadyResold = settings.resoldItemIds ?? [];
  const raw = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      meta: { path: ['sellableByOthers'], equals: true },
      addedById: { not: userId },
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
      ...(cosmeticTypes?.length ? { cosmetic: { type: { in: cosmeticTypes } } } : {}),
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor } } : {}),
    orderBy: { id: 'desc' },
    select: {
      id: true,
      unitAmount: true,
      availableQuantity: true,
      meta: true,
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
  return item;
};

export const addResoldItem = async ({
  userId,
  shopItemId,
}: ResoldItemInput & { userId: number }) => {
  await assertCreatorProgramMember(userId);
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
}: GetReviewQueueInput) => {
  const items = await dbRead.cosmeticShopItem.findMany({
    where: {
      // A specific status filters to it; no status = every status except
      // Archived (the "All" option in the review queue).
      ...(status ? { status } : { status: { not: CosmeticShopItemStatus.Archived } }),
      // Only creator-submitted items (exclude official/admin cosmetics).
      cosmetic: {
        createdById: { not: null },
        ...(username ? { creator: { username: { equals: username, mode: 'insensitive' } } } : {}),
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
      cosmetic: { select: { createdById: true, creator: { select: { username: true } } } },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  if (item.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be reviewed');

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
      : // reject = terminal; request-changes = creator can edit & resubmit.
        await dbWrite.cosmeticShopItem.update({
          where: { id },
          data: {
            ...reviewFields,
            status:
              action === 'reject'
                ? CosmeticShopItemStatus.Rejected
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
        },
      ],
      skipDuplicates: true,
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
      // Can't (re)open a shop without an active Creator Program membership.
      if (!(await hasValidCreatorMembership(userId)))
        throw throwBadRequestError(
          'An active Creator Program membership is required to open your shop.'
        );
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
