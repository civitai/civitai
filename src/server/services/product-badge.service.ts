import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { submitWorkflow } from '@civitai/client';
import type { ConvertImageStepTemplate, ResizeTransform } from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { subscriptionProductMetadataSchema } from '~/server/schema/subscriptions.schema';
import type {
  GetBadgeHistoryInput,
  GetProductsWithBadgesInput,
  UpsertProductBadgeInput,
} from '~/server/schema/product-badge.schema';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getImageUploadBackend } from '~/utils/s3-utils';
import { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';

const BADGE_TARGET_SIZE = 200;

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

/**
 * Run an uploaded badge image through the orchestrator's convertImage workflow
 * to produce a 200x200 webp. Source must be square (1:1) — the orchestrator's
 * resize transform preserves aspect ratio. Returns the new Cloudflare image id.
 * If width/height are already 200x200 (or unknown and equal to the target),
 * the original id is returned unchanged.
 */
export const resizeBadgeImage = async ({
  url,
  width,
  height,
}: {
  url: string;
  width?: number;
  height?: number;
}): Promise<string> => {
  if (width === BADGE_TARGET_SIZE && height === BADGE_TARGET_SIZE) return url;

  const sourceUrl = url.startsWith('http') ? url : getEdgeUrl(url, { type: 'image' });

  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: 30 },
    body: {
      tags: ['badge-resize'],
      currencies: [],
      steps: [
        {
          $type: 'convertImage',
          input: {
            image: sourceUrl,
            transforms: [{ type: 'resize', targetWidth: BADGE_TARGET_SIZE } as ResizeTransform],
            output: {
              format: 'webp',
              quality: 100,
              lossless: true,
              hideMetadata: false,
            },
          },
        } as ConvertImageStepTemplate,
      ],
    },
  });

  if (!data) {
    const message =
      typeof error === 'string' ? error : (error as any)?.detail ?? response?.statusText;
    throw new Error(`Badge resize failed: ${message ?? 'unknown error'}`);
  }

  // The orchestrator may return before the step finishes when wait=30 isn't
  // enough (e.g. animated sources). Treat anything other than `succeeded` as a
  // failure rather than reading garbage off `step.output`.
  const workflowStatus = (data as any)?.status as string | undefined;
  const step = (data.steps ?? [])[0] as any;
  const stepStatus = step?.status as string | undefined;
  if (workflowStatus && workflowStatus !== 'succeeded') {
    throw new Error(
      `Badge resize workflow did not complete (status: ${workflowStatus}${
        stepStatus ? `, step: ${stepStatus}` : ''
      })`
    );
  }
  if (stepStatus && stepStatus !== 'succeeded') {
    throw new Error(`Badge resize step did not complete (status: ${stepStatus})`);
  }
  const blobUrl: string | undefined = step?.output?.blob?.url;
  if (!blobUrl) throw new Error('Badge resize did not return an output blob');

  const blobResponse = await fetch(blobUrl);
  if (!blobResponse.ok) {
    throw new Error(`Failed to download resized badge: ${blobResponse.status}`);
  }

  const buffer = Buffer.from(await blobResponse.arrayBuffer());
  const s3Key = randomUUID();
  const { s3, bucket, backend } = await getImageUploadBackend();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: buffer,
      ContentType: blobResponse.headers.get('content-type') || 'image/webp',
    })
  );
  registerMediaLocation(s3Key, backend, buffer.length);

  return s3Key;
};

export const upsertProductBadge = async (input: UpsertProductBadgeInput) => {
  const {
    id,
    name,
    badgeUrl,
    animated,
    productIds,
    availableStart,
    availableEnd,
    sourceWidth,
    sourceHeight,
  } = input;

  if (availableEnd <= availableStart) {
    throw new Error('Available end date must be after start date');
  }

  // On edit, fetch the existing cosmetic up-front so we can skip the orchestrator
  // workflow when the badge image hasn't actually changed — otherwise saving
  // unrelated metadata (name, dates) would re-encode and re-upload the same
  // image, churning the stored UUID on every save.
  const existing = id
    ? await dbRead.cosmetic.findUnique({
        where: { id },
        select: { id: true, productId: true, data: true },
      })
    : null;
  if (id && !existing) throw new Error('Cosmetic not found');

  const existingUrl = (existing?.data as { url?: string } | null)?.url;
  const isUnchangedUrl = !!existingUrl && existingUrl === badgeUrl;
  // Normalize badge dimensions to 200x200 so the live UI stays consistent.
  // The convertImage workflow preserves all frames for animated sources by
  // default (maxFrames is unset), so animated badges flow through the same path.
  const resolvedBadgeUrl = isUnchangedUrl
    ? existingUrl
    : await resizeBadgeImage({
        url: badgeUrl,
        width: sourceWidth,
        height: sourceHeight,
      });

  const results = [];

  if (id) {
    const updated = await dbWrite.cosmetic.update({
      where: { id },
      data: {
        name,
        data: { url: resolvedBadgeUrl, animated },
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
          data: { url: resolvedBadgeUrl, animated },
          productId,
          availableStart,
          availableEnd,
        },
      });

      results.push(cosmetic);
    }
  }

  // Sync each affected product's metadata.badge to the currently-active badge
  // cosmetic. Future-dated badges do NOT overwrite the live badge — they're
  // promoted on their availableStart by syncActiveBadgeMetadata via the daily
  // cron (see prepaid-membership-jobs).
  await syncActiveBadgeMetadata({ productIds });

  return results;
};

/**
 * For each given product (or all subscription products if omitted), set
 * Product.metadata.badge / badgeType to the badge cosmetic that is currently
 * within its availability window. Leaves metadata untouched when no badge is
 * active for a product so we don't blank out the live UI.
 */
export const syncActiveBadgeMetadata = async ({
  productIds,
}: {
  productIds?: string[];
} = {}) => {
  const now = new Date();

  const activeBadges = await dbRead.cosmetic.findMany({
    where: {
      type: CosmeticType.Badge,
      productId: productIds ? { in: productIds } : { not: null },
      AND: [
        { OR: [{ availableStart: null }, { availableStart: { lte: now } }] },
        { OR: [{ availableEnd: null }, { availableEnd: { gte: now } }] },
      ],
    },
    orderBy: { availableStart: 'desc' },
    select: { id: true, data: true, productId: true },
  });

  // Take the most recently-started active badge per product
  const byProduct = new Map<string, (typeof activeBadges)[number]>();
  for (const badge of activeBadges) {
    if (badge.productId && !byProduct.has(badge.productId)) {
      byProduct.set(badge.productId, badge);
    }
  }

  // Batch-fetch every product's metadata in one query (the daily cron runs
  // without `productIds`, so a per-product findUnique would be N+1).
  const productIdsToCheck = Array.from(byProduct.keys());
  const products = productIdsToCheck.length
    ? await dbRead.product.findMany({
        where: { id: { in: productIdsToCheck } },
        select: { id: true, metadata: true },
      })
    : [];
  const metadataByProductId = new Map(products.map((p) => [p.id, p.metadata]));

  let synced = 0;
  for (const [productId, badge] of byProduct.entries()) {
    const badgeData = badge.data as { url?: string; animated?: boolean } | null;
    if (!badgeData?.url) continue;

    if (!metadataByProductId.has(productId)) continue;

    const existingMeta = (metadataByProductId.get(productId) as Record<string, unknown>) ?? {};
    const nextBadgeType = badgeData.animated ? 'animated' : 'static';

    if (existingMeta.badge === badgeData.url && existingMeta.badgeType === nextBadgeType) {
      continue;
    }

    await dbWrite.product.update({
      where: { id: productId },
      data: {
        metadata: {
          ...existingMeta,
          badge: badgeData.url,
          badgeType: nextBadgeType,
        },
      },
    });
    synced++;
  }

  return { synced };
};
