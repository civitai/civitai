import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import type { ImageReferenceInput } from '~/server/schema/image.schema';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import { isImageOwner } from '~/server/services/util.service';
import { updateServiceOfferingNsfwLevels } from '~/server/services/nsfwLevels.service';
import {
  requeueBlockedServiceOffering,
  scanServiceOffering,
} from '~/server/services/service-offering-moderation.adapter';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getHiddenOrBlockedUserIds } from '~/server/services/user-preferences.service';
import { assertCreatorShopVisible } from '~/server/services/creator-shop.service';
import { countOpenDealsByOffering } from '~/server/services/creator-service-deal.service';
import { getServicesMinCreatorScore } from '~/server/services/creator-service-min-score';
import { createNotification } from '~/server/services/notification.service';
import {
  SERVICE_OFFERING_TAKEN_DOWN,
  sellerFacingTakedownDetails,
  serviceOfferingTakenDownKey,
} from '@civitai/shared/service-offering-takedown';
import { NotificationCategory } from '~/server/common/enums';
import { SERVICE_DEAL_OPEN_STATUSES } from '~/shared/constants/creator-services.constants';
import type {
  GetServiceOfferingFeedInput,
  GetShopServiceOfferingsInput,
  ServiceOfferingFeedSort,
  SetServiceOfferingStatusInput,
  TakedownServiceOfferingInput,
  UpsertServiceOfferingInput,
} from '~/server/schema/creator-service.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { NsfwLevel } from '~/server/common/enums';
import {
  SERVICE_MAX_ACTIVE_OFFERINGS,
  SERVICE_OFFERING_DEFAULT_RATING,
  SERVICE_OFFERING_RATINGS,
  servableServiceRatings,
  visibleMatureServiceRatings,
} from '~/shared/constants/creator-service.constants';
import {
  SELLER_AFFIRMATION_STATEMENT,
  SERVICES_TERMS_VERSION,
} from '~/shared/constants/creator-service-terms.constants';
import { MUTE_POINTS } from '~/shared/constants/strike.constants';
import { creatorAggregateScoreFromMeta } from '~/shared/utils/creator-score';
import {
  ImageIngestionStatus,
  ServiceOfferingIngestionStatus,
  ServiceOfferingStatus,
  StrikeStatus,
} from '~/shared/utils/prisma/enums';

export const serviceOfferingSelect = {
  id: true,
  title: true,
  description: true,
  price: true,
  previewKind: true,
  deliveryDays: true,
  revisionsIncluded: true,
  maxOpenDeals: true,
  maxNsfwLevel: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  coverImage: { select: profileImageSelect },
} satisfies Prisma.ServiceOfferingSelect;

/** What only the seller and moderators see: the seller's own rating and the content check. */
const ownServiceOfferingSelect = {
  ...serviceOfferingSelect,
  coverImage: { select: { ...profileImageSelect, needsReview: true, tosViolation: true } },
  declaredNsfwLevel: true,
  ingestion: true,
  sellerAffirmation: true,
} satisfies Prisma.ServiceOfferingSelect;

/**
 * Whether Active offerings count as shop items when publishing. Only the owner's own session
 * carries the owner's flags, so a moderator acting for a seller fails closed to cosmetics-only.
 */
export const servicesCountForPublish = ({
  shopOwnerId,
  callerId,
  callerHasServicesFlag,
}: {
  shopOwnerId: number;
  callerId: number;
  callerHasServicesFlag: boolean;
}) => shopOwnerId === callerId && callerHasServicesFlag;

export type ServiceSellEligibility = {
  canSell: boolean;
  score: { current: number; min: number };
  /** Why an account at or above the score still cannot sell; null when standing is clean. */
  standingIssue: string | null;
};

export async function getServiceSellEligibility(userId: number): Promise<ServiceSellEligibility> {
  const [user, strikes, minScore] = await Promise.all([
    dbRead.user.findUnique({
      where: { id: userId },
      select: { meta: true, bannedAt: true, muted: true, deletedAt: true },
    }),
    dbRead.userStrike.aggregate({
      where: { userId, status: StrikeStatus.Active, expiresAt: { gt: new Date() } },
      _sum: { points: true },
    }),
    getServicesMinCreatorScore(),
  ]);
  if (!user) throw throwNotFoundError('User not found');

  const current = creatorAggregateScoreFromMeta(user.meta);
  let standingIssue: string | null = null;
  if (user.bannedAt || user.deletedAt)
    standingIssue = 'Your account is not eligible to sell services.';
  else if (user.muted) standingIssue = 'Muted accounts cannot sell services.';
  else if ((strikes._sum.points ?? 0) >= MUTE_POINTS)
    standingIssue = 'Your account has active strikes and cannot sell services right now.';

  return {
    canSell: !standingIssue && current >= minScore,
    score: { current, min: minScore },
    standingIssue,
  };
}

/** Whether the user is buyer or seller on any open deal: their way back to a deal when the flag is off. */
export async function hasOpenServiceDeal(userId: number) {
  const deal = await dbRead.serviceDeal.findFirst({
    where: {
      OR: [{ buyerId: userId }, { sellerId: userId }],
      status: { in: [...SERVICE_DEAL_OPEN_STATUSES] },
    },
    select: { id: true },
  });
  return !!deal;
}

export async function assertCanSellServices(userId: number) {
  const eligibility = await getServiceSellEligibility(userId);
  if (eligibility.standingIssue) throw throwAuthorizationError(eligibility.standingIssue);
  if (!eligibility.canSell)
    throw throwAuthorizationError(
      `Selling services unlocks at a Creator Score of ${eligibility.score.min.toLocaleString()}.`
    );
}

const hasCurrentAffirmation = (record: Prisma.JsonValue | null | undefined) =>
  !!record &&
  typeof record === 'object' &&
  !Array.isArray(record) &&
  record.version === SERVICES_TERMS_VERSION;

const sellerAffirmationRecord = (userId: number, offeringId: number) => ({
  userId,
  offeringId,
  affirmedAt: new Date().toISOString(),
  version: SERVICES_TERMS_VERSION,
  statement: SELLER_AFFIRMATION_STATEMENT,
});

/**
 * Publishing needs the seller's agreement to the current terms, ticked now or already recorded
 * against this offering. Returns the record to write, or undefined when one is already on file.
 */
function affirmationForPublish({
  sellerId,
  offeringId,
  existing,
  affirmedTermsVersion,
}: {
  sellerId: number;
  offeringId: number;
  existing: Prisma.JsonValue | null | undefined;
  affirmedTermsVersion?: string;
}) {
  // A record on file is never replaced, so it keeps the time of the first agreement.
  if (hasCurrentAffirmation(existing)) return undefined;
  if (affirmedTermsVersion === SERVICES_TERMS_VERSION)
    return sellerAffirmationRecord(sellerId, offeringId);
  throw throwBadRequestError('Confirm the seller terms to publish this service.');
}

async function assertUnderActiveOfferingCap(sellerId: number) {
  const active = await dbWrite.serviceOffering.count({
    where: { sellerId, status: ServiceOfferingStatus.Active },
  });
  if (active >= SERVICE_MAX_ACTIVE_OFFERINGS)
    throw throwBadRequestError(
      `You can have at most ${SERVICE_MAX_ACTIVE_OFFERINGS} active services. Pause one first.`
    );
}

/** A seller's own offerings. Ones this domain may not show are counted, never listed. */
export async function getMyServiceOfferings({
  sellerId,
  servable,
}: {
  sellerId: number;
  /** What this domain may be sent: `domainServableLevels(ctx)`. */
  servable: number;
}) {
  const shown = servableServiceRatings(servable);
  const where = { sellerId, status: { not: ServiceOfferingStatus.Removed } };
  const [rows, hiddenOffDomain] = await Promise.all([
    dbRead.serviceOffering.findMany({
      where: { ...where, maxNsfwLevel: { in: shown } },
      select: ownServiceOfferingSelect,
      orderBy: { createdAt: 'desc' },
    }),
    shown.length === SERVICE_OFFERING_RATINGS.length
      ? 0
      : dbRead.serviceOffering.count({ where: { ...where, maxNsfwLevel: { notIn: shown } } }),
  ]);
  const items = rows.map(({ sellerAffirmation, ...offering }) => ({
    ...offering,
    termsAffirmed: hasCurrentAffirmation(sellerAffirmation),
    review: serviceOfferingReviewState(offering),
  }));
  return { items, hiddenOffDomain };
}

export type ServiceOfferingReviewState = 'reviewing' | 'held' | null;

/** What the seller is told about their offering's content checks; null once it can be shown. */
export function serviceOfferingReviewState(offering: {
  ingestion: ServiceOfferingIngestionStatus;
  coverImage: {
    ingestion: ImageIngestionStatus;
    needsReview: string | null;
    tosViolation: boolean;
  } | null;
}): ServiceOfferingReviewState {
  const cover = offering.coverImage;
  if (
    offering.ingestion === ServiceOfferingIngestionStatus.Blocked ||
    cover?.tosViolation ||
    cover?.ingestion === ImageIngestionStatus.Blocked ||
    cover?.ingestion === ImageIngestionStatus.NotFound
  )
    return 'held';
  if (
    offering.ingestion !== ServiceOfferingIngestionStatus.Scanned ||
    (cover && (cover.ingestion !== ImageIngestionStatus.Scanned || cover.needsReview !== null))
  )
    return 'reviewing';
  return null;
}

/**
 * Offerings whose content checks have completed, with a cover (if any) that has too and is at a
 * rating this viewer may see. `matureRatings` as for `shopRatingFilter`.
 */
export const serviceOfferingShowableWhere = (matureRatings: readonly number[]) =>
  ({
    ingestion: ServiceOfferingIngestionStatus.Scanned,
    AND: [
      {
        OR: [
          { coverImageId: null },
          {
            coverImage: {
              ingestion: ImageIngestionStatus.Scanned,
              needsReview: null,
              tosViolation: false,
              nsfwLevel: { in: [NsfwLevel.PG, NsfwLevel.PG13, ...matureRatings] },
            },
          },
        ],
      },
    ],
  } satisfies Prisma.ServiceOfferingWhereInput);

/** Offerings rated PG/PG-13, plus the mature ratings this viewer may see (see `visibleMatureServiceRatings`). */
export const shopRatingFilter = (matureRatings: readonly number[]) =>
  matureRatings.length
    ? {
        OR: [
          { maxNsfwLevel: { lte: NsfwLevel.PG13 } },
          { maxNsfwLevel: { in: [...matureRatings] } },
        ],
      }
    : { maxNsfwLevel: { lte: NsfwLevel.PG13 } };

/**
 * The storefront's listing rule, shared by a seller's storefront and the cross-seller feed: Active
 * offerings of a seller in good standing, at the ratings this viewer and domain may see, whose
 * content checks have completed.
 */
const listableServiceOfferingWhere = ({
  browsingLevel,
  servable,
}: {
  browsingLevel: number | undefined;
  servable: number;
}) => {
  const matureRatings = visibleMatureServiceRatings({ browsingLevel, servable });
  return {
    status: ServiceOfferingStatus.Active,
    seller: { bannedAt: null, deletedAt: null, muted: false },
    ...shopRatingFilter(matureRatings),
    ...serviceOfferingShowableWhere(matureRatings),
  } satisfies Prisma.ServiceOfferingWhereInput;
};

// Display only: `requestServiceDeal` enforces the cap against the same count.
async function withOpenSlots<T extends { id: number; maxOpenDeals: number | null }>(
  offerings: T[]
) {
  const open = await countOpenDealsByOffering(offerings.map((o) => o.id));
  return offerings.map((offering) => ({
    ...offering,
    slotsOpen:
      offering.maxOpenDeals == null
        ? null
        : Math.max(0, offering.maxOpenDeals - (open.get(offering.id) ?? 0)),
  }));
}

export async function getShopServiceOfferings({
  userId,
  browsingLevel,
  servable,
  viewerId,
  isModerator,
}: GetShopServiceOfferingsInput & {
  /** What this domain may be sent: `domainServableLevels(ctx)`. */
  servable: number;
  viewerId?: number;
  isModerator?: boolean;
}) {
  await assertCreatorShopVisible({ userId, viewerId, isModerator });
  const offerings = await dbRead.serviceOffering.findMany({
    where: { sellerId: userId, ...listableServiceOfferingWhere({ browsingLevel, servable }) },
    select: serviceOfferingSelect,
    orderBy: { createdAt: 'asc' },
  });
  return withOpenSlots(offerings);
}

const feedOrderBy = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  price_asc: [{ price: 'asc' }, { id: 'asc' }],
  price_desc: [{ price: 'desc' }, { id: 'desc' }],
} satisfies Record<ServiceOfferingFeedSort, Prisma.ServiceOfferingOrderByWithRelationInput[]>;

/**
 * Active offerings across every seller whose storefront a visitor could open: the storefront's
 * listing rule, plus a published shop and no block either way (`assertCreatorShopVisible`), and
 * minus the creators this viewer hid. Owners and moderators get no bypass: the feed is what
 * visitors see.
 */
export async function getServiceOfferingFeed({
  browsingLevel,
  servable,
  viewerId,
  sort,
  cursor,
  limit,
}: GetServiceOfferingFeedInput & {
  /** What this domain may be sent: `domainServableLevels(ctx)`. */
  servable: number;
  viewerId?: number;
}) {
  const excludedSellerIds = viewerId ? await getHiddenOrBlockedUserIds(viewerId) : [];
  const listable = listableServiceOfferingWhere({ browsingLevel, servable });
  const rows = await dbRead.serviceOffering.findMany({
    where: {
      ...listable,
      seller: {
        ...listable.seller,
        // The card links to the storefront, which is addressed by username.
        username: { not: null },
        settings: { path: ['creatorShop', 'enabled'], equals: true },
      },
      ...(excludedSellerIds.length ? { sellerId: { notIn: excludedSellerIds } } : {}),
    },
    select: { ...serviceOfferingSelect, seller: { select: userWithCosmeticsSelect } },
    orderBy: feedOrderBy[sort],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: await withOpenSlots(page),
    nextCursor: rows.length > limit ? page[page.length - 1].id : undefined,
  };
}

export async function upsertServiceOffering({
  sellerId,
  input,
}: {
  sellerId: number;
  input: UpsertServiceOfferingInput;
}) {
  const { id, publish, affirmedTermsVersion, coverImage, ...fields } = input;
  await assertCanSellServices(sellerId);
  await throwOnBlockedUserContent([fields.title, fields.description], {
    surface: 'creator-service-offering',
  });

  if (!id) {
    if (publish) {
      // Checked before the cap so a missing tick never reads as a cap error.
      affirmationForPublish({ sellerId, offeringId: 0, existing: null, affirmedTermsVersion });
      await assertUnderActiveOfferingCap(sellerId);
    }
    const coverImageId = coverImage
      ? await resolveServiceCoverImageId({ coverImage, sellerId, currentCoverId: null })
      : null;
    const declaredNsfwLevel = fields.declaredNsfwLevel ?? SERVICE_OFFERING_DEFAULT_RATING;
    // The record carries the offering's id, which exists only once it is created.
    const created = await dbWrite.$transaction(async (tx) => {
      const created = await tx.serviceOffering.create({
        data: {
          ...fields,
          declaredNsfwLevel,
          maxNsfwLevel: declaredNsfwLevel,
          coverImageId,
          sellerId,
          status: publish ? ServiceOfferingStatus.Active : ServiceOfferingStatus.Draft,
        },
        select: { id: true },
      });
      if (publish)
        await tx.serviceOffering.update({
          where: { id: created.id },
          data: { sellerAffirmation: sellerAffirmationRecord(sellerId, created.id) },
        });
      return created;
    });
    return afterServiceOfferingWrite(created.id, { textChanged: true });
  }

  const owned = { id, sellerId, status: { not: ServiceOfferingStatus.Removed } };
  const existing = await dbWrite.serviceOffering.findFirst({
    where: owned,
    select: {
      status: true,
      sellerAffirmation: true,
      title: true,
      description: true,
      ingestion: true,
      coverImageId: true,
    },
  });
  if (!existing) throw throwNotFoundError('Service not found');
  const textChanged =
    existing.title !== fields.title || existing.description !== fields.description;
  const coverImageId =
    coverImage === undefined
      ? undefined
      : coverImage === null
      ? null
      : await resolveServiceCoverImageId({
          coverImage,
          sellerId,
          currentCoverId: existing.coverImageId,
        });

  const activating = publish && existing.status !== ServiceOfferingStatus.Active;
  const affirmation = activating
    ? affirmationForPublish({
        sellerId,
        offeringId: id,
        existing: existing.sellerAffirmation,
        affirmedTermsVersion,
      })
    : undefined;
  if (activating) await assertUnderActiveOfferingCap(sellerId);

  // Re-scoped so a remove that lands after the read above can't be undone by this write.
  const { count } = await dbWrite.serviceOffering.updateMany({
    // New text resets the check only from the state read above, so a block landing since is kept.
    where: textChanged ? { ...owned, ingestion: existing.ingestion } : owned,
    data: {
      ...fields,
      ...(coverImageId !== undefined ? { coverImageId } : {}),
      // New text is shown once it is checked; a blocked offering's goes back below.
      ...(textChanged && existing.ingestion !== ServiceOfferingIngestionStatus.Blocked
        ? { ingestion: ServiceOfferingIngestionStatus.Pending, scanWorkflowId: null }
        : {}),
      ...(activating ? { status: ServiceOfferingStatus.Active } : {}),
      ...(affirmation ? { sellerAffirmation: affirmation } : {}),
    },
  });
  if (count === 0)
    throw textChanged
      ? throwConflictError('This service changed while you were editing it. Reload and try again.')
      : throwNotFoundError('Service not found');
  if (textChanged && existing.ingestion === ServiceOfferingIngestionStatus.Blocked)
    await requeueBlockedServiceOffering(id);
  return afterServiceOfferingWrite(id, { textChanged });
}

async function resolveServiceCoverImageId({
  coverImage,
  sellerId,
  currentCoverId,
}: {
  coverImage: ImageReferenceInput;
  sellerId: number;
  currentCoverId: number | null;
}) {
  return resolveCoverImageId({
    coverImage,
    userId: sellerId,
    currentCoverId,
    assertOwnership: async (imageId) => {
      if (imageId === currentCoverId) return;
      if (!(await isImageOwner({ userId: sellerId, imageId, allowMods: false })))
        throw throwAuthorizationError('Invalid cover image');
    },
  });
}

/** The rating follows the new declared level and cover at once; new text goes to its check. */
async function afterServiceOfferingWrite(id: number, { textChanged }: { textChanged: boolean }) {
  await updateServiceOfferingNsfwLevels([id]);
  if (textChanged) await scanServiceOffering(id);
  return dbWrite.serviceOffering.findUniqueOrThrow({
    where: { id },
    select: ownServiceOfferingSelect,
  });
}

export async function setServiceOfferingStatus({
  sellerId,
  input: { id, status, affirmedTermsVersion },
}: {
  sellerId: number;
  input: SetServiceOfferingStatusInput;
}) {
  const from =
    status === ServiceOfferingStatus.Active
      ? [ServiceOfferingStatus.Draft, ServiceOfferingStatus.Paused]
      : [ServiceOfferingStatus.Active];

  let affirmation: ReturnType<typeof sellerAffirmationRecord> | undefined;
  if (status === ServiceOfferingStatus.Active) {
    await assertCanSellServices(sellerId);
    const existing = await dbWrite.serviceOffering.findFirst({
      where: { id, sellerId, status: { in: from } },
      select: { sellerAffirmation: true },
    });
    if (!existing) throw throwNotFoundError('Service not found');
    affirmation = affirmationForPublish({
      sellerId,
      offeringId: id,
      existing: existing.sellerAffirmation,
      affirmedTermsVersion,
    });
    await assertUnderActiveOfferingCap(sellerId);
  }

  const { count } = await dbWrite.serviceOffering.updateMany({
    where: { id, sellerId, status: { in: from } },
    data: { status, ...(affirmation ? { sellerAffirmation: affirmation } : {}) },
  });
  if (count === 0) throw throwNotFoundError('Service not found');
}

// Never a hard delete: deals reference the offering with RESTRICT.
export async function removeServiceOffering({ sellerId, id }: { sellerId: number; id: number }) {
  const { count } = await dbWrite.serviceOffering.updateMany({
    where: { id, sellerId, status: { not: ServiceOfferingStatus.Removed } },
    data: { status: ServiceOfferingStatus.Removed },
  });
  if (count === 0) throw throwNotFoundError('Service not found');
}

/**
 * A moderator takedown: status Removed plus the reason, time and moderator, which is what tells it
 * apart from a seller's own remove. Open deals carry on under the terms they copied at request time;
 * new requests are refused because the offering is no longer Active, and pending ones can no longer
 * be accepted. There is no restore.
 *
 * Decision (briony, 2026-10-15): it also applies to an offering the seller already removed, or a
 * seller could dodge it by removing first and still accept pending requests. An offering already
 * taken down is refused, so the seller is never notified twice.
 */
export async function takedownServiceOffering({
  moderatorId,
  input: { id, reason, details },
}: {
  moderatorId: number;
  input: TakedownServiceOfferingInput;
}) {
  const notTakenDown = { id, removedReason: null };
  const offering = await dbWrite.serviceOffering.findFirst({
    where: notTakenDown,
    select: { title: true, sellerId: true, seller: { select: { username: true } } },
  });
  if (!offering) throw throwNotFoundError('Service not found, or already taken down');

  // Re-scoped so two moderators acting at once record one takedown and send one notification.
  const { count } = await dbWrite.serviceOffering.updateMany({
    where: notTakenDown,
    data: {
      status: ServiceOfferingStatus.Removed,
      removedReason: reason,
      removedDetails: details ?? null,
      removedAt: new Date(),
      removedById: moderatorId,
    },
  });
  if (count === 0) throw throwNotFoundError('Service not found, or already taken down');

  await createNotification({
    userId: offering.sellerId,
    type: SERVICE_OFFERING_TAKEN_DOWN,
    category: NotificationCategory.System,
    key: serviceOfferingTakenDownKey(id),
    details: {
      offeringId: id,
      offeringTitle: offering.title,
      sellerUsername: offering.seller.username,
      reason,
      details: sellerFacingTakedownDetails(reason, details),
    },
  });
}
