import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { assertCreatorShopVisible } from '~/server/services/creator-shop.service';
import { countOpenDealsByOffering } from '~/server/services/creator-service-deal.service';
import { createNotification } from '~/server/services/notification.service';
import {
  SERVICE_OFFERING_TAKEN_DOWN,
  sellerFacingTakedownDetails,
  serviceOfferingTakenDownKey,
} from '@civitai/shared/service-offering-takedown';
import { NotificationCategory } from '~/server/common/enums';
import { SERVICE_DEAL_OPEN_STATUSES } from '~/shared/constants/creator-services.constants';
import type {
  GetShopServiceOfferingsInput,
  SetServiceOfferingStatusInput,
  TakedownServiceOfferingInput,
  UpsertServiceOfferingInput,
} from '~/server/schema/creator-service.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { NsfwLevel } from '~/server/common/enums';
import {
  SERVICE_MAX_ACTIVE_OFFERINGS,
  SERVICE_OFFERING_DEFAULT_RATING,
  SERVICE_OFFERING_RATINGS,
  SERVICES_MIN_CREATOR_SCORE,
  servableServiceRatings,
  visibleMatureServiceRatings,
} from '~/shared/constants/creator-service.constants';
import {
  SELLER_AFFIRMATION_STATEMENT,
  SERVICES_TERMS_VERSION,
} from '~/shared/constants/creator-service-terms.constants';
import { MUTE_POINTS } from '~/shared/constants/strike.constants';
import { creatorAggregateScoreFromMeta } from '~/shared/utils/creator-score';
import { ServiceOfferingStatus, StrikeStatus } from '~/shared/utils/prisma/enums';

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
  const [user, strikes] = await Promise.all([
    dbRead.user.findUnique({
      where: { id: userId },
      select: { meta: true, bannedAt: true, muted: true, deletedAt: true },
    }),
    dbRead.userStrike.aggregate({
      where: { userId, status: StrikeStatus.Active, expiresAt: { gt: new Date() } },
      _sum: { points: true },
    }),
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
    canSell: !standingIssue && current >= SERVICES_MIN_CREATOR_SCORE,
    score: { current, min: SERVICES_MIN_CREATOR_SCORE },
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
      `Selling services unlocks at a Creator Score of ${SERVICES_MIN_CREATOR_SCORE.toLocaleString()}.`
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
  if (affirmedTermsVersion === SERVICES_TERMS_VERSION)
    return sellerAffirmationRecord(sellerId, offeringId);
  if (hasCurrentAffirmation(existing)) return undefined;
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
      select: { ...serviceOfferingSelect, sellerAffirmation: true },
      orderBy: { createdAt: 'desc' },
    }),
    shown.length === SERVICE_OFFERING_RATINGS.length
      ? 0
      : dbRead.serviceOffering.count({ where: { ...where, maxNsfwLevel: { notIn: shown } } }),
  ]);
  const items = rows.map(({ sellerAffirmation, ...offering }) => ({
    ...offering,
    termsAffirmed: hasCurrentAffirmation(sellerAffirmation),
  }));
  return { items, hiddenOffDomain };
}

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
    where: {
      sellerId: userId,
      status: ServiceOfferingStatus.Active,
      seller: { bannedAt: null, deletedAt: null, muted: false },
      ...shopRatingFilter(visibleMatureServiceRatings({ browsingLevel, servable })),
    },
    select: serviceOfferingSelect,
    orderBy: { createdAt: 'asc' },
  });
  // Display only: `requestServiceDeal` enforces the cap against the same count.
  const open = await countOpenDealsByOffering(offerings.map((o) => o.id));
  return offerings.map((offering) => ({
    ...offering,
    slotsOpen:
      offering.maxOpenDeals == null
        ? null
        : Math.max(0, offering.maxOpenDeals - (open.get(offering.id) ?? 0)),
  }));
}

export async function upsertServiceOffering({
  sellerId,
  input,
}: {
  sellerId: number;
  input: UpsertServiceOfferingInput;
}) {
  const { id, publish, affirmedTermsVersion, ...fields } = input;
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
    // The record carries the offering's id, which exists only once it is created.
    return dbWrite.$transaction(async (tx) => {
      const created = await tx.serviceOffering.create({
        data: {
          ...fields,
          maxNsfwLevel: fields.maxNsfwLevel ?? SERVICE_OFFERING_DEFAULT_RATING,
          sellerId,
          status: publish ? ServiceOfferingStatus.Active : ServiceOfferingStatus.Draft,
        },
        select: serviceOfferingSelect,
      });
      if (publish)
        await tx.serviceOffering.update({
          where: { id: created.id },
          data: { sellerAffirmation: sellerAffirmationRecord(sellerId, created.id) },
        });
      return created;
    });
  }

  const owned = { id, sellerId, status: { not: ServiceOfferingStatus.Removed } };
  const existing = await dbWrite.serviceOffering.findFirst({
    where: owned,
    select: { status: true, sellerAffirmation: true },
  });
  if (!existing) throw throwNotFoundError('Service not found');

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
    where: owned,
    data: {
      ...fields,
      ...(activating ? { status: ServiceOfferingStatus.Active } : {}),
      ...(affirmation ? { sellerAffirmation: affirmation } : {}),
    },
  });
  if (count === 0) throw throwNotFoundError('Service not found');
  return dbWrite.serviceOffering.findUniqueOrThrow({
    where: { id },
    select: serviceOfferingSelect,
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
