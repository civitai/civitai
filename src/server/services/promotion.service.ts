import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import type { ModelGallerySettingsSchema } from '~/server/schema/model.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { isImageReviewed } from '~/server/common/image-visibility';
import { getCreatorGalleryHiddenUserIds } from '~/server/services/creator-gallery-hidden-users.service';
import {
  holdPlacementEscrow,
  isPlacementEscrowFunded,
  settlePlacement,
} from '~/server/services/placement-escrow.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  allBrowsingLevelsFlag,
  modelBrowsingLevelLimit,
} from '~/shared/constants/browsingLevel.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Flags } from '~/shared/utils/flags';
import { declineFeeAmount, PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type {
  GalleryHostSettings,
  GalleryPromotionData,
  GalleryPromotionRefusal,
  ModelPromotionData,
  PromotionAcceptance,
  PromotionRunDays,
  PromotionSurface,
} from '~/shared/utils/promotion';
import {
  galleryPromotionRefusal,
  isPromotionLive,
  isPromotionRunDays,
  isPromotionSurface,
  parseGalleryPromotionData,
  parseModelPromotionData,
  promotionAmount,
  promotionRunEndsAt,
  PROMOTION_QUEUE_LIMIT,
  PROMOTION_RUN_DAYS,
  PROMOTION_TARGET_TYPE,
} from '~/shared/utils/promotion';

const LIVE_STATUSES = ['pending', 'approved'] as const;
const MAX_RUN_MS = Math.max(...PROMOTION_RUN_DAYS) * 24 * 60 * 60 * 1000;

type HostModel = {
  id: number;
  userId: number;
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
  sfwOnly: boolean;
  status: string;
  mode: string | null;
  availability: string;
  deletedAt: Date | null;
  gallerySettings: Prisma.JsonValue;
};

/** From the primary: these decide a mutation and what it charges. */
async function loadModel(modelId: number): Promise<HostModel> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      userId: true,
      nsfwLevel: true,
      poi: true,
      minor: true,
      sfwOnly: true,
      status: true,
      mode: true,
      availability: true,
      deletedAt: true,
      gallerySettings: true,
    },
  });
  if (!model) throw throwNotFoundError('promotion: that model no longer exists');
  return model;
}

const isShowableModel = (
  model: Pick<HostModel, 'status' | 'deletedAt' | 'poi' | 'availability' | 'mode'>
) =>
  model.status === ModelStatus.Published &&
  !model.deletedAt &&
  !model.poi &&
  model.availability !== 'Private' &&
  model.mode !== ModelModifier.TakenDown &&
  model.mode !== ModelModifier.Archived;

export const platformPromotionLevel = (model: Pick<HostModel, 'minor' | 'sfwOnly'>) =>
  modelBrowsingLevelLimit(model);

/**
 * The highest browsing level the host's page accepts a promotion at. The host
 * sets it through the model's gallery level; a minor or SFW-only model is held
 * to PG/PG-13 and the host cannot raise it, matching the gallery's own lock.
 */
export function hostPromotionLevel(
  model: Pick<HostModel, 'minor' | 'sfwOnly' | 'gallerySettings'>
) {
  const platform = platformPromotionLevel(model);
  if (platform !== allBrowsingLevelsFlag) return platform;
  const level = (model.gallerySettings as ModelGallerySettingsSchema | null)?.level;
  return level ? Flags.intersection(level, allBrowsingLevelsFlag) : allBrowsingLevelsFlag;
}

/**
 * What a running promotion may be shown at on its page now. The host's own cap
 * is the one frozen at accept, so lowering it cannot hide a paid run; the
 * platform lock is read as it stands today, because it is a safety rule and not
 * the host's choice. `undefined` when the page is gone.
 */
async function promotionServingLevel(modelId: number, acceptedLevel: number | undefined) {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: { minor: true, sfwOnly: true, gallerySettings: true },
  });
  if (!model) return undefined;
  return acceptedLevel
    ? Flags.intersection(acceptedLevel, platformPromotionLevel(model))
    : hostPromotionLevel(model);
}

async function loadGalleryHostSettings(model: HostModel): Promise<GalleryHostSettings> {
  const settings = (model.gallerySettings ?? {}) as ModelGallerySettingsSchema;
  const creatorHidden = await getCreatorGalleryHiddenUserIds(model.userId, { fresh: true });
  return {
    hiddenUserIds: [...(settings.users ?? []), ...creatorHidden],
    hiddenTagIds: settings.tags ?? [],
    hiddenImageIds: Object.values(settings.hiddenImages ?? {}).flat(),
  };
}

const GALLERY_REFUSAL_MESSAGE: Record<GalleryPromotionRefusal, string> = {
  noImages: 'promotion: that post has no images to show',
  unrated: 'promotion: that post is still being rated',
  aboveMaxLevel: "promotion: that post is rated above what this model's page shows",
  hiddenByHost: 'promotion: not available for this gallery',
};

type PromotedPostImage = {
  id: number;
  nsfwLevel: number;
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  nsfwLevelReason: string | null;
  scanFailureClass: string | null;
  needsReview: string | null;
  minor: boolean;
  acceptableMinor: boolean;
  poi: boolean;
  tosViolation: boolean;
};

async function loadPromotedPost(postId: number) {
  const post = await dbWrite.post.findUnique({
    where: { id: postId },
    select: { id: true, userId: true, publishedAt: true, tosViolation: true },
  });
  if (!post) throw throwNotFoundError('promotion: that post no longer exists');

  const images = await dbWrite.$queryRaw<PromotedPostImage[]>`
    SELECT i.id, i."nsfwLevel", i.ingestion::text AS ingestion, i."nsfwLevelLocked",
           i.metadata->>'nsfwLevelReason' AS "nsfwLevelReason",
           i."scanJobs"->'error'->>'failureClass' AS "scanFailureClass",
           i."needsReview", i.minor, i."acceptableMinor", i.poi, i."tosViolation"
    FROM "Image" i
    WHERE i."postId" = ${postId}
  `;
  return { post, images };
}

/** Which of the host model's versions the post's images were made with, per resource detection. */
async function hostVersionsUsedByPost({ postId, modelId }: { postId: number; modelId: number }) {
  const rows = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
    SELECT DISTINCT ir."modelVersionId"
    FROM "ImageResourceNew" ir
    JOIN "Image" i ON i.id = ir."imageId"
    JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
    WHERE i."postId" = ${postId} AND mv."modelId" = ${modelId}
  `;
  return rows.map((row) => row.modelVersionId);
}

/**
 * Everything that decides whether a post may be promoted in a gallery right now.
 * Run at purchase and again when the host accepts, so an accept honours the
 * host's settings as they stand at review.
 */
async function assertGalleryPromotable({
  placerId,
  postId,
  host,
}: {
  placerId: number;
  postId: number;
  host: HostModel;
}) {
  if (!isShowableModel(host))
    throw throwBadRequestError('promotion: this model is not accepting promotions right now');

  const { post, images } = await loadPromotedPost(postId);
  if (post.userId !== placerId)
    throw throwAuthorizationError('promotion: you can only promote your own posts');
  if (!post.publishedAt || post.tosViolation)
    throw throwBadRequestError('promotion: only published posts can be promoted');
  if (
    images.some(
      (image) =>
        !isImageReviewed(image) ||
        image.needsReview ||
        image.minor ||
        image.acceptableMinor ||
        image.poi ||
        image.tosViolation
    )
  )
    throw throwBadRequestError('promotion: that post cannot be promoted');

  const modelVersionIds = await hostVersionsUsedByPost({ postId, modelId: host.id });
  if (!modelVersionIds.length)
    throw throwBadRequestError('promotion: that post was not made with this model');

  const tagIds = await tagIdsForImagesCache.fetch(images.map((image) => image.id));
  const refusal = galleryPromotionRefusal({
    placerId,
    images: images.map((image) => ({
      id: image.id,
      nsfwLevel: image.nsfwLevel,
      tagIds: tagIds[image.id]?.tags ?? [],
    })),
    host: await loadGalleryHostSettings(host),
    maxLevel: hostPromotionLevel(host),
  });
  if (refusal) throw throwBadRequestError(GALLERY_REFUSAL_MESSAGE[refusal]);

  return { modelVersionIds, imageIds: images.map((image) => image.id) };
}

async function assertModelPromotable({
  placerId,
  promotedModelId,
  host,
}: {
  placerId: number;
  promotedModelId: number;
  host: HostModel;
}) {
  if (!isShowableModel(host))
    throw throwBadRequestError('promotion: this model is not accepting promotions right now');
  if (promotedModelId === host.id)
    throw throwBadRequestError('promotion: a model cannot be promoted on its own page');

  const promoted = await loadModel(promotedModelId);
  if (promoted.userId !== placerId)
    throw throwAuthorizationError('promotion: you can only promote your own models');
  if (!isShowableModel(promoted) || promoted.minor)
    throw throwBadRequestError('promotion: that model cannot be promoted');
  if (!promoted.nsfwLevel || !Flags.hasFlag(hostPromotionLevel(host), promoted.nsfwLevel))
    throw throwBadRequestError("promotion: that model is rated above what this model's page shows");
}

type CreatePromotionBase = {
  placerId: number;
  /** The host model: the page the promotion shows on. */
  modelId: number;
  days: number;
  /** The daily price the buyer was shown. Refused if the host has moved it since. */
  expectedPrice?: number;
  /**
   * The decline fee the buyer was shown, in whole percent. Required: without it
   * a buyer would be held to a fee they never saw.
   */
  expectedDeclineFeePercent: number;
  /** Decided at the router from the request's domain, never from the client. */
  spendType: BuzzSpendType;
};

/** Everything both surfaces refuse on before a row exists. */
async function preparePromotion({
  surface,
  placerId,
  modelId,
  days,
  expectedPrice,
  expectedDeclineFeePercent,
}: CreatePromotionBase & { surface: PromotionSurface }) {
  if (!isPromotionRunDays(days))
    throw throwBadRequestError(`promotion: runs are ${PROMOTION_RUN_DAYS.join(', ')} days`);

  const space = await resolvePlacementSpaceFor({
    surface,
    targetType: PROMOTION_TARGET_TYPE,
    targetId: modelId,
  });
  if (space.mode === 'off')
    throw throwBadRequestError('promotion: this creator is not accepting promotions');
  // `review` is the only open mode these surfaces allow. A row written outside
  // the settings mutation would still read back, so this refuses it.
  if (space.mode !== 'review')
    throw throwBadRequestError('promotion: promotions here need the creator to review them');
  if (space.ownerId === placerId)
    throw throwBadRequestError('promotion: you cannot promote on your own page');

  if (space.price == null)
    throw throwBadRequestError('promotion: this creator has not set a price yet');
  if (space.price < PLACEMENT_SURFACES[surface].serverMinPrice)
    throw throwBadRequestError('promotion: this page is not priced for promotions');
  if (expectedPrice != null && expectedPrice !== space.price)
    throw throwBadRequestError(
      `promotion: the price changed to ${space.price} Buzz a day while you were deciding`
    );
  if (space.hostDeclineFeePercent == null)
    throw new Error(`promotion: ${surface} must carry a host decline fee`);
  if (expectedDeclineFeePercent !== space.hostDeclineFeePercent)
    throw throwBadRequestError(
      `promotion: the decline fee changed to ${space.hostDeclineFeePercent}% while you were deciding`
    );

  return { space, days, dailyPrice: space.price };
}

async function assertUnderPendingCap({
  surface,
  ownerId,
  placerId,
}: {
  surface: PromotionSurface;
  ownerId: number;
  placerId: number;
}) {
  const pending = await dbWrite.placement.count({
    where: { surface, ownerId, placerId, status: 'pending' },
  });
  if (pending >= PLACEMENT_SURFACES[surface].maxPendingPerOwner)
    throw throwBadRequestError(
      'promotion: you already have the maximum promotions waiting with this creator'
    );
}

/**
 * One promoted thing per page at a time, pending or live. A second copy would
 * only buy a second slot of the same rotation, or hand the host a second fee for
 * the same decision.
 */
async function assertNotAlreadyPromoted({
  surface,
  modelId,
  key,
  value,
}: {
  surface: PromotionSurface;
  modelId: number;
  key: 'postId' | 'modelId';
  value: number;
}) {
  const rows = await dbWrite.placement.findMany({
    where: {
      surface,
      targetType: PROMOTION_TARGET_TYPE,
      targetId: modelId,
      status: { in: [...LIVE_STATUSES] },
      data: { path: [key], equals: value },
    },
    select: { status: true, resolvedAt: true, data: true },
  });
  const parse =
    surface === 'galleryPromotion' ? parseGalleryPromotionData : parseModelPromotionData;
  const blocking = rows.some((row) => {
    if (row.status === 'pending') return true;
    const data = parse(row.data);
    // Serving refuses the same unreadable row, so it holds no slot.
    if (!data) return false;
    return !!row.resolvedAt && isPromotionLive({ acceptedAt: row.resolvedAt, ...data });
  });
  if (blocking) throw throwBadRequestError('promotion: that is already promoted on this page');
}

/**
 * Creates the placement row and takes the escrow. The row must exist before the
 * escrow can reference it, so a failure after the insert expires it, which
 * refunds through real refunds of real holds. Same order as the remix gallery.
 */
async function createPromotionPlacement({
  surface,
  modelId,
  ownerId,
  placerId,
  amount,
  declineFeeRate,
  data,
  spendType,
}: {
  surface: PromotionSurface;
  modelId: number;
  ownerId: number;
  placerId: number;
  amount: number;
  declineFeeRate: number;
  data: GalleryPromotionData | ModelPromotionData;
  spendType: BuzzSpendType;
}) {
  await assertCanPlace({ ownerId, placerId });
  await assertUnderPendingCap({ surface, ownerId, placerId });

  const placement = await dbWrite.placement.create({
    data: {
      surface,
      targetType: PROMOTION_TARGET_TYPE,
      targetId: modelId,
      ownerId,
      placerId,
      sellerId: null,
      amount,
      status: 'pending',
      data: data as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  try {
    await holdPlacementEscrow({
      placementId: placement.id,
      placerId,
      surface,
      amount,
      declineFeeRate,
      spendType,
    });
  } catch (error) {
    await settlePlacement({ placementId: placement.id, action: 'expire' }).catch((settleError) =>
      logToAxiom({
        name: 'promotion',
        type: 'error',
        message: 'compensating settle failed; escrow may be held for a rejected promotion',
        placementId: placement.id,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      }).catch(() => undefined)
    );
    throw error;
  }

  return placement;
}

export async function createGalleryPromotion({
  postId,
  ...input
}: CreatePromotionBase & { postId: number }) {
  const surface = 'galleryPromotion' as const;
  const { space, days, dailyPrice } = await preparePromotion({ ...input, surface });
  const host = await loadModel(input.modelId);
  const { modelVersionIds, imageIds } = await assertGalleryPromotable({
    placerId: input.placerId,
    postId,
    host,
  });
  await assertNotAlreadyPromoted({ surface, modelId: host.id, key: 'postId', value: postId });

  return createPromotionPlacement({
    surface,
    modelId: host.id,
    ownerId: space.ownerId,
    placerId: input.placerId,
    amount: promotionAmount(dailyPrice, days),
    declineFeeRate: space.declineFeeRate,
    data: { postId, days, modelVersionIds, imageIds },
    spendType: input.spendType,
  });
}

export async function createModelPromotion({
  promotedModelId,
  ...input
}: CreatePromotionBase & { promotedModelId: number }) {
  const surface = 'modelPromotion' as const;
  const { space, days, dailyPrice } = await preparePromotion({ ...input, surface });
  const host = await loadModel(input.modelId);
  await assertModelPromotable({ placerId: input.placerId, promotedModelId, host });
  await assertNotAlreadyPromoted({
    surface,
    modelId: host.id,
    key: 'modelId',
    value: promotedModelId,
  });

  return createPromotionPlacement({
    surface,
    modelId: host.id,
    ownerId: space.ownerId,
    placerId: input.placerId,
    amount: promotionAmount(dailyPrice, days),
    declineFeeRate: space.declineFeeRate,
    data: { modelId: promotedModelId, days },
    spendType: input.spendType,
  });
}

/**
 * The host's answer to a pending promotion. Accepting pays the host at once
 * (the standard placement settle) and starts the run; `resolvedAt` is the start.
 *
 * There is deliberately no remove: the host is paid at accept, so a host who
 * could end the run could keep the Buzz and drop the promotion. A run ends early
 * only through a moderator takedown or the buyer's own change.
 */
export async function actOnPromotion({
  placementId,
  action,
  userId,
}: {
  placementId: number;
  action: 'approve' | 'decline';
  userId: number;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: {
      id: true,
      surface: true,
      targetId: true,
      ownerId: true,
      placerId: true,
      status: true,
      amount: true,
      data: true,
    },
  });
  if (!placement || !isPromotionSurface(placement.surface))
    throw throwNotFoundError('promotion: that promotion no longer exists');
  if (placement.ownerId !== userId)
    throw throwAuthorizationError('promotion: that promotion is not on your page');
  if (placement.status !== 'pending')
    throw throwBadRequestError(`promotion: that promotion is already ${placement.status}`);

  if (action === 'approve') {
    // The row is committed before its escrow is taken, so a host can see it while
    // the hold is still in flight. Accepting then would pay out of nothing.
    if (!(await isPlacementEscrowFunded({ placementId, amount: placement.amount })))
      throw throwBadRequestError('promotion: the payment for this is still processing');

    const host = await loadModel(placement.targetId);
    let accepted: GalleryPromotionData | ModelPromotionData;
    if (placement.surface === 'galleryPromotion') {
      const data = parseGalleryPromotionData(placement.data);
      if (!data) throw throwBadRequestError('promotion: that promotion cannot be shown');
      // What the host accepted is the post as it is now. Serving shows only these
      // images, so anything the buyer adds afterwards never reaches the page.
      const approved = await assertGalleryPromotable({
        placerId: placement.placerId,
        postId: data.postId,
        host,
      });
      accepted = { ...data, ...approved };
    } else {
      const data = parseModelPromotionData(placement.data);
      if (!data) throw throwBadRequestError('promotion: that promotion cannot be shown');
      await assertModelPromotable({
        placerId: placement.placerId,
        promotedModelId: data.modelId,
        host,
      });
      accepted = data;
    }

    const acceptance: PromotionAcceptance = {
      acceptedLevel: hostPromotionLevel(host),
      endsAt: promotionRunEndsAt(new Date(), accepted.days).toISOString(),
    };
    await dbWrite.placement.updateMany({
      where: { id: placementId, status: 'pending' },
      data: { data: { ...accepted, ...acceptance } as Prisma.InputJsonValue },
    });
  }

  const result = await settlePlacement({ placementId, action, actorId: userId });
  if (!result.settled)
    throw throwBadRequestError('promotion: that promotion was already answered elsewhere');
  return result;
}

type LivePromotionRow = { id: number; placerId: number; resolvedAt: Date | null; data: unknown };

async function liveApprovedPromotions({
  surface,
  modelId,
}: {
  surface: PromotionSurface;
  modelId: number;
}) {
  const rows: LivePromotionRow[] = await dbRead.placement.findMany({
    where: {
      surface,
      targetType: PROMOTION_TARGET_TYPE,
      targetId: modelId,
      status: 'approved',
      resolvedAt: { gt: new Date(Date.now() - MAX_RUN_MS) },
    },
    select: { id: true, placerId: true, resolvedAt: true, data: true },
  });
  return rows;
}

const pickOne = <T>(items: T[]) =>
  items.length ? items[Math.floor(Math.random() * items.length)] : undefined;

/**
 * The sponsored post for one version's gallery, if any is running. Rotates
 * between overlapping runs per request.
 *
 * The host's gallery settings are deliberately NOT re-applied here: they were
 * checked at purchase and at accept, and the removal lock means a later change
 * does not end an accepted run. Viewer-side filtering still happens when the
 * post's images are fetched.
 */
export async function getSponsoredGalleryPost({
  modelId,
  modelVersionId,
  features,
}: {
  modelId: number;
  modelVersionId: number;
  /** The viewer's flags. Taken here so no caller can serve a promotion without the gate. */
  features: Pick<FeatureAccess, 'creatorPromotions'>;
}) {
  if (!features.creatorPromotions) return undefined;
  const rows = await liveApprovedPromotions({ surface: 'galleryPromotion', modelId });
  const live = rows.flatMap((row) => {
    const data = parseGalleryPromotionData(row.data);
    if (!data || !row.resolvedAt) return [];
    if (!isPromotionLive({ acceptedAt: row.resolvedAt, ...data })) return [];
    if (!data.modelVersionIds.includes(modelVersionId)) return [];
    return [{ placementId: row.id, ...data }];
  });
  const picked = pickOne(live);
  if (!picked) return undefined;

  const servingLevel = await promotionServingLevel(modelId, picked.acceptedLevel);
  if (!servingLevel) return undefined;
  return {
    placementId: picked.placementId,
    postId: picked.postId,
    imageIds: picked.imageIds,
    servingLevel,
  };
}

/** The sponsored model card for a model page's Suggested Resources, if any is running. */
export async function getSponsoredModel({
  modelId,
  features,
}: {
  modelId: number;
  features: Pick<FeatureAccess, 'creatorPromotions'>;
}) {
  if (!features.creatorPromotions) return undefined;
  const rows = await liveApprovedPromotions({ surface: 'modelPromotion', modelId });
  const live = rows.flatMap((row) => {
    const data = parseModelPromotionData(row.data);
    if (!data || !row.resolvedAt) return [];
    if (!isPromotionLive({ acceptedAt: row.resolvedAt, ...data })) return [];
    return [{ placementId: row.id, ...data }];
  });
  const picked = pickOne(live);
  if (!picked) return undefined;

  const servingLevel = await promotionServingLevel(modelId, picked.acceptedLevel);
  if (!servingLevel) return undefined;
  return { placementId: picked.placementId, modelId: picked.modelId, servingLevel };
}

/**
 * The models a post was made with, other than the buyer's own, with each
 * page's resolved promotion price. A listing only: the purchase re-decides all
 * of it.
 */
export async function getPromotionHostsForPost({
  postId,
  placerId,
}: {
  postId: number;
  placerId: number;
}) {
  const post = await dbRead.post.findUnique({ where: { id: postId }, select: { userId: true } });
  if (!post || post.userId !== placerId) return [];

  // The primary, like the purchase: the replica can be missing resource rows the
  // purchase would accept.
  const used = await dbWrite.$queryRaw<
    (Pick<HostModel, 'id' | 'userId' | 'status' | 'deletedAt' | 'poi' | 'availability' | 'mode'> & {
      name: string;
    })[]
  >`
    SELECT DISTINCT m.id, m.name, m."userId", m.status::text AS status, m."deletedAt", m.poi,
           m.availability::text AS availability, m.mode::text AS mode
    FROM "ImageResourceNew" ir
    JOIN "Image" i ON i.id = ir."imageId"
    JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE i."postId" = ${postId} AND m."userId" != ${placerId}
  `;
  const models = used.filter(isShowableModel);

  // A model's promotion space is its owner's account, so one quote per owner. A
  // post can use a hundred models, hence the concurrency limit as well.
  const quotes = new Map<number, Awaited<ReturnType<typeof promotionQuote>>>();
  const owners = [...new Map(models.map((model) => [model.userId, model.id])).entries()];
  await limitConcurrency(
    owners.map(([ownerId, modelId]) => async () => {
      quotes.set(ownerId, await promotionQuote({ surface: 'galleryPromotion', modelId }));
    }),
    5
  );

  return models.flatMap((model) => {
    const quote = quotes.get(model.userId);
    return quote ? [{ modelId: model.id, name: model.name, ...quote }] : [];
  });
}

/**
 * A page's promotion price and what the host keeps on a decline, for each run
 * length. `null` when the page is not taking promotions on this surface. Display
 * only: the purchase re-decides all of it.
 */
async function promotionQuote({
  surface,
  modelId,
}: {
  surface: PromotionSurface;
  modelId: number;
}) {
  const space = await resolvePlacementSpaceFor({
    surface,
    targetType: PROMOTION_TARGET_TYPE,
    targetId: modelId,
  }).catch(() => null);
  if (!space || space.mode !== 'review' || space.price == null) return null;
  if (space.price < PLACEMENT_SURFACES[surface].serverMinPrice) return null;
  if (space.hostDeclineFeePercent == null) return null;

  const dailyPrice = space.price;
  return {
    ownerId: space.ownerId,
    ownerUsername: space.ownerUsername,
    dailyPrice,
    declineFeePercent: space.hostDeclineFeePercent,
    // Amounts, not a rate: the fee floors at 1 Buzz, so a client multiplying a
    // percentage would be wrong on a cheap run.
    declineFees: Object.fromEntries(
      PROMOTION_RUN_DAYS.map((days) => [
        days,
        declineFeeAmount(promotionAmount(dailyPrice, days), space.declineFeeRate),
      ])
    ) as Record<PromotionRunDays, number>,
  };
}

export type PromotionOffer =
  | { open: false; reason: string }
  | ({ open: true; modelId: number; name: string } & NonNullable<
      Awaited<ReturnType<typeof promotionQuote>>
    >);

/** Whether a model page takes model promotions from this buyer, and at what price. */
export async function getModelPromotionOffer({
  modelId,
  placerId,
}: {
  modelId: number;
  placerId: number;
}): Promise<PromotionOffer> {
  const host = await dbRead.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      name: true,
      userId: true,
      nsfwLevel: true,
      poi: true,
      minor: true,
      sfwOnly: true,
      status: true,
      mode: true,
      availability: true,
      deletedAt: true,
      gallerySettings: true,
    },
  });
  if (!host || !isShowableModel(host))
    return { open: false, reason: 'That model is not accepting promotions right now.' };
  if (host.userId === placerId)
    return { open: false, reason: 'You cannot promote on your own model page.' };

  const quote = await promotionQuote({ surface: 'modelPromotion', modelId });
  if (!quote) return { open: false, reason: 'This creator is not taking model promotions.' };
  return { open: true, modelId: host.id, name: host.name, ...quote };
}

/** What a queue row needs to be read: the page it is on, what it promotes and for how long. */
async function describePromotionRows<T extends { targetId: number; data: unknown }>(
  surface: PromotionSurface,
  rows: T[]
) {
  const described = rows.map((row) => {
    const gallery = surface === 'galleryPromotion' ? parseGalleryPromotionData(row.data) : null;
    const model = surface === 'modelPromotion' ? parseModelPromotionData(row.data) : null;
    return {
      row,
      postId: gallery?.postId ?? null,
      promotedModelId: model?.modelId ?? null,
      days: gallery?.days ?? model?.days ?? null,
      endsAt: gallery?.endsAt ?? model?.endsAt ?? null,
    };
  });

  const modelIds = new Set<number>();
  for (const { row, promotedModelId } of described) {
    modelIds.add(row.targetId);
    if (promotedModelId) modelIds.add(promotedModelId);
  }
  const models = modelIds.size
    ? await dbRead.model.findMany({
        where: { id: { in: [...modelIds] } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(models.map((model) => [model.id, model.name]));

  return described.map(({ row, postId, promotedModelId, days, endsAt }) => ({
    ...row,
    hostModelName: names.get(row.targetId) ?? null,
    postId,
    promotedModelId,
    promotedModelName: promotedModelId ? names.get(promotedModelId) ?? null : null,
    days,
    endsAt,
  }));
}

/** Promotions waiting on this host, oldest first so the ones about to expire lead. */
export async function getPendingPromotions({
  surface,
  ownerId,
}: {
  surface: PromotionSurface;
  ownerId: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: { surface, ownerId, status: 'pending' },
    select: {
      id: true,
      targetId: true,
      amount: true,
      data: true,
      createdAt: true,
      expiresAt: true,
      placer: { select: { id: true, username: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PROMOTION_QUEUE_LIMIT,
  });
  return describePromotionRows(surface, rows);
}

/** What this buyer has promoted, newest first, with enough to show the run's state. */
export async function getMyPromotions({
  surface,
  placerId,
}: {
  surface: PromotionSurface;
  placerId: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: { surface, placerId },
    select: {
      id: true,
      targetId: true,
      amount: true,
      status: true,
      removedBy: true,
      data: true,
      createdAt: true,
      resolvedAt: true,
      takenDownAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PROMOTION_QUEUE_LIMIT,
  });
  return describePromotionRows(surface, rows);
}
