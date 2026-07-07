import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead, dbWrite } from '~/server/db/client';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
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
} from '~/shared/utils/prisma/enums';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import {
  CREATOR_SHOP_SUBMISSION_FEE,
  PRICE_REVIEW_THRESHOLD,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import type {
  AutoCheck,
  CosmeticImageMeta,
  GetReviewQueueInput,
  ReviewCreatorShopItemInput,
  SubmitCreatorShopItemInput,
  UpdateCreatorShopItemInput,
  UpdateCreatorShopSettingsInput,
} from '~/server/schema/creator-shop.schema';

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
  if (type === CosmeticType.ProfileBackground) return { url: imageUrl, type: MediaType.image };
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
  try {
    const res = await fetch(getEdgeUrl(imageUrl, { original: true }));
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    format = meta.format;
    hasTransparency = !!meta.hasAlpha;
  } catch {
    throw throwBadRequestError('Could not read the uploaded artwork for validation');
  }

  const dimensionsOk = req.exact
    ? width === req.width && height === req.height
    : width >= req.width && height >= req.height;

  const checks: AutoCheck[] = [
    {
      key: 'format',
      label: 'PNG or WebP',
      passed: format === 'png' || format === 'webp',
      detail: format,
    },
    {
      key: 'dimensions',
      label: req.exact ? `${req.width}×${req.height}px` : `At least ${req.width}×${req.height}px`,
      passed: dimensionsOk,
      detail: `${width}×${height}px`,
    },
  ];
  if (req.requireTransparency)
    checks.push({ key: 'transparency', label: 'Transparent background', passed: hasTransparency });

  const imageMeta: CosmeticImageMeta = { width, height, hasTransparency };
  return { checks, imageMeta, allPassed: checks.every((c) => c.passed) };
};

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
}: SubmitCreatorShopItemInput & { userId: number }) => {
  // Validate the artwork server-side BEFORE charging anything.
  const { checks, imageMeta, allPassed } = await validateArtwork(imageUrl, cosmeticType);
  if (!allPassed)
    throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');

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
      cosmetic: { select: { createdById: true, type: true } },
      _count: { select: { purchases: true } },
    },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  if (!isModerator && item.cosmetic.createdById !== userId)
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
  if (existing.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be edited');

  const artChanged = imageUrl !== undefined;
  // Buyers already have the art — it can't change once published or sold.
  if (
    artChanged &&
    (existing.status === CosmeticShopItemStatus.Published || existing._count.purchases > 0)
  )
    throw throwBadRequestError('Artwork cannot be changed once an item is published or sold');

  // Validate + build replaced artwork server-side.
  let artwork:
    | { data: Prisma.InputJsonValue; checks: AutoCheck[]; imageMeta: CosmeticImageMeta }
    | undefined;
  if (artChanged && imageUrl) {
    const { checks, imageMeta, allPassed } = await validateArtwork(
      imageUrl,
      existing.cosmetic.type
    );
    if (!allPassed)
      throw throwBadRequestError('Artwork does not meet the requirements for this cosmetic type');
    artwork = {
      data: buildCosmeticData(existing.cosmetic.type, imageUrl, animated) as Prisma.InputJsonValue,
      checks,
      imageMeta,
    };
  }

  const contentChanged = name !== undefined || description !== undefined || artChanged;
  const meta = (existing.meta ?? {}) as CosmeticShopItemMeta;
  const base = meta.lastApprovedAmount ?? existing.unitAmount;
  const bigPriceChange =
    price != null && base > 0 && Math.abs(price - base) / base > PRICE_REVIEW_THRESHOLD;

  // Published → back to review on a content change or a >±25% price change (a
  // small price tweak stays live). Rejected / PendingReview → (re)submit.
  const backToReview =
    (existing.status === CosmeticShopItemStatus.Published && (contentChanged || bigPriceChange)) ||
    existing.status === CosmeticShopItemStatus.Rejected ||
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
        ...(artwork ? { autoChecks: artwork.checks, imageMeta: artwork.imageMeta } : {}),
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
  await getOwnedItemOrThrow(id, userId, isModerator);
  return dbWrite.cosmeticShopItem.update({
    where: { id },
    data: { status: CosmeticShopItemStatus.Archived, archivedAt: new Date() },
    select: creatorShopItemSelect,
  });
};

// A creator's own items (any status) for the "Manage your shop" view. The router
// only lets a moderator pass someone else's userId.
export const getCreatorShopManageItems = async ({ userId }: { userId: number }) => {
  const items = await dbRead.cosmeticShopItem.findMany({
    where: { cosmetic: { createdById: userId } },
    select: creatorShopItemSelect,
    orderBy: { createdAt: 'desc' },
  });
  return items.map(withRemaining);
};

// ---------------------------------------------------------------------------
// Public: creator storefront
// ---------------------------------------------------------------------------

export const getCreatorShop = async ({ userId }: { userId: number }) => {
  const now = new Date();
  const items = await dbRead.cosmeticShopItem.findMany({
    where: {
      status: CosmeticShopItemStatus.Published,
      cosmetic: { createdById: userId },
      AND: [
        { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
        { OR: [{ availableTo: null }, { availableTo: { gte: now } }] },
      ],
    },
    // Reuse the official shop's selector so creator cards render with the exact
    // same <ShopItem> component + purchase modal as /shop.
    select: cosmeticShopItemSelect,
    orderBy: { createdAt: 'desc' },
  });

  const settings = await getCreatorShopSettings({ userId });
  // Sanitize meta to only the purchase count the card needs — never the creator
  // payout/fee internals.
  const cosmetics = items.map((item) => ({
    ...item,
    meta: { purchases: (item.meta as CosmeticShopItemMeta)?.purchases ?? 0 },
  }));
  const featuredIds = settings.featuredItemIds ?? [];
  const featured = featuredIds
    .map((fid) => cosmetics.find((c) => c.id === fid))
    .filter((x): x is (typeof cosmetics)[number] => !!x);

  return { cosmetics, featured, settings };
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
      status: status ?? CosmeticShopItemStatus.PendingReview,
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
    select: { id: true, unitAmount: true, status: true, meta: true },
  });
  if (!item) throw throwNotFoundError('Shop item not found');
  if (item.status === CosmeticShopItemStatus.Archived)
    throw throwBadRequestError('Archived items cannot be reviewed');

  const meta = (item.meta ?? {}) as CosmeticShopItemMeta;

  if (action === 'reject') {
    return dbWrite.cosmeticShopItem.update({
      where: { id },
      data: {
        status: CosmeticShopItemStatus.Rejected,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        rejectionReason: rejectionReason ?? null,
      },
      select: creatorShopItemSelect,
    });
  }

  // Approve: publish + record the approved price. Payout is wired at purchase
  // time from cosmetic.createdById — no paidToUserIds needed.
  return dbWrite.cosmeticShopItem.update({
    where: { id },
    data: {
      status: CosmeticShopItemStatus.Published,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
      rejectionReason: null,
      meta: { ...meta, lastApprovedAmount: item.unitAmount } as Prisma.InputJsonValue,
    },
    select: creatorShopItemSelect,
  });
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
