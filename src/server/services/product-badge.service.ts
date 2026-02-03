import { dbRead, dbWrite } from '~/server/db/client';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';
import type {
  GetBadgeHistoryInput,
  GetProductsWithBadgesInput,
  UpsertProductBadgeInput,
} from '~/server/schema/product-badge.schema';
import { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';

export const getProductsWithBadges = async (input: GetProductsWithBadgesInput) => {
  const products = await dbRead.product.findMany({
    where: {
      active: true,
      ...(input.name ? { name: { contains: input.name, mode: 'insensitive' as const } } : {}),
      ...(input.provider ? { provider: input.provider as any } : {}),
    },
    select: {
      id: true,
      name: true,
      provider: true,
      metadata: true,
    },
    orderBy: [{ provider: 'asc' }, { name: 'asc' }],
  });

  // For each product, find the latest badge cosmetic
  const productIds = products.map((p) => p.id);
  const latestBadges = productIds.length
    ? await dbRead.cosmetic.findMany({
        where: {
          productId: { in: productIds },
          type: CosmeticType.Badge,
        },
        orderBy: { availableStart: 'desc' },
        select: {
          id: true,
          name: true,
          data: true,
          productId: true,
          availableStart: true,
          availableEnd: true,
        },
      })
    : [];

  // Group cosmetics by productId - take the most recent one per product
  const badgeByProduct = new Map<string, (typeof latestBadges)[number]>();
  for (const badge of latestBadges) {
    if (badge.productId && !badgeByProduct.has(badge.productId)) {
      badgeByProduct.set(badge.productId, badge);
    }
  }

  return products.map((product) => {
    const meta = subscriptionProductMetadataSchema.safeParse(product.metadata);
    const badge = badgeByProduct.get(product.id);
    const badgeData = badge?.data as { url?: string; animated?: boolean } | null;

    return {
      id: product.id,
      name: product.name,
      provider: product.provider,
      tier: meta.success ? meta.data.tier : undefined,
      badgeType: meta.success ? meta.data.badgeType : undefined,
      currentBadge: badge
        ? {
            id: badge.id,
            name: badge.name,
            url: badgeData?.url ?? null,
            animated: badgeData?.animated ?? false,
            availableStart: badge.availableStart,
            availableEnd: badge.availableEnd,
          }
        : null,
    };
  });
};

export const getBadgeHistory = async ({ productId }: GetBadgeHistoryInput) => {
  const badges = await dbRead.cosmetic.findMany({
    where: {
      productId,
      type: CosmeticType.Badge,
    },
    orderBy: { availableStart: 'desc' },
    select: {
      id: true,
      name: true,
      data: true,
      availableStart: true,
      availableEnd: true,
      createdAt: true,
    },
  });

  return badges.map((badge) => {
    const badgeData = badge.data as { url?: string; animated?: boolean } | null;
    return {
      id: badge.id,
      name: badge.name,
      url: badgeData?.url ?? null,
      animated: badgeData?.animated ?? false,
      availableStart: badge.availableStart,
      availableEnd: badge.availableEnd,
      createdAt: badge.createdAt,
    };
  });
};

export const upsertProductBadge = async (input: UpsertProductBadgeInput) => {
  const { id, name, badgeUrl, animated, productIds, availableStart, availableEnd } = input;

  if (availableEnd <= availableStart) {
    throw new Error('Available end date must be after start date');
  }

  const results = [];

  if (id) {
    // Update existing cosmetic
    const existing = await dbRead.cosmetic.findUnique({
      where: { id },
      select: { id: true, productId: true },
    });

    if (!existing) throw new Error('Cosmetic not found');

    const updated = await dbWrite.cosmetic.update({
      where: { id },
      data: {
        name,
        data: { url: badgeUrl, animated },
        availableStart,
        availableEnd,
      },
    });

    results.push(updated);
  } else {
    // Create one cosmetic per product
    for (const productId of productIds) {
      const cosmetic = await dbWrite.cosmetic.create({
        data: {
          name,
          type: CosmeticType.Badge,
          source: CosmeticSource.Membership,
          permanentUnlock: false,
          data: { url: badgeUrl, animated },
          productId,
          availableStart,
          availableEnd,
        },
      });

      results.push(cosmetic);
    }
  }

  // Update product metadata badge & badgeType for each assigned product
  for (const productId of productIds) {
    const product = await dbRead.product.findUnique({
      where: { id: productId },
      select: { metadata: true },
    });

    if (product) {
      const existingMeta = (product.metadata as Record<string, unknown>) ?? {};
      await dbWrite.product.update({
        where: { id: productId },
        data: {
          metadata: {
            ...existingMeta,
            badge: badgeUrl,
            badgeType: animated ? 'animated' : 'static',
          },
        },
      });
    }
  }

  return results;
};
