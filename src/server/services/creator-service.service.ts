import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { assertCreatorShopVisible } from '~/server/services/creator-shop.service';
import { countOpenDealsByOffering } from '~/server/services/creator-service-deal.service';
import { SERVICE_DEAL_OPEN_STATUSES } from '~/shared/constants/creator-services.constants';
import type {
  GetShopServiceOfferingsInput,
  SetServiceOfferingStatusInput,
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
  SERVICES_MIN_CREATOR_SCORE,
  visibleMatureServiceRatings,
} from '~/shared/constants/creator-service.constants';
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

async function assertUnderActiveOfferingCap(sellerId: number) {
  const active = await dbWrite.serviceOffering.count({
    where: { sellerId, status: ServiceOfferingStatus.Active },
  });
  if (active >= SERVICE_MAX_ACTIVE_OFFERINGS)
    throw throwBadRequestError(
      `You can have at most ${SERVICE_MAX_ACTIVE_OFFERINGS} active services. Pause one first.`
    );
}

export function getMyServiceOfferings(sellerId: number) {
  return dbRead.serviceOffering.findMany({
    where: { sellerId, status: { not: ServiceOfferingStatus.Removed } },
    select: serviceOfferingSelect,
    orderBy: { createdAt: 'desc' },
  });
}

/** Offerings rated PG/PG-13, plus the mature ratings this viewer may see (see `isMatureServiceRating`). */
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
  const { id, publish, ...fields } = input;
  await assertCanSellServices(sellerId);

  if (!id) {
    if (publish) await assertUnderActiveOfferingCap(sellerId);
    return dbWrite.serviceOffering.create({
      data: {
        ...fields,
        sellerId,
        status: publish ? ServiceOfferingStatus.Active : ServiceOfferingStatus.Draft,
      },
      select: serviceOfferingSelect,
    });
  }

  const owned = { id, sellerId, status: { not: ServiceOfferingStatus.Removed } };
  const existing = await dbWrite.serviceOffering.findFirst({
    where: owned,
    select: { status: true },
  });
  if (!existing) throw throwNotFoundError('Service not found');

  const activating = publish && existing.status !== ServiceOfferingStatus.Active;
  if (activating) await assertUnderActiveOfferingCap(sellerId);

  // Re-scoped so a remove that lands after the read above can't be undone by this write.
  const { count } = await dbWrite.serviceOffering.updateMany({
    where: owned,
    data: { ...fields, ...(activating ? { status: ServiceOfferingStatus.Active } : {}) },
  });
  if (count === 0) throw throwNotFoundError('Service not found');
  return dbWrite.serviceOffering.findUniqueOrThrow({
    where: { id },
    select: serviceOfferingSelect,
  });
}

export async function setServiceOfferingStatus({
  sellerId,
  input: { id, status },
}: {
  sellerId: number;
  input: SetServiceOfferingStatusInput;
}) {
  const from =
    status === ServiceOfferingStatus.Active
      ? [ServiceOfferingStatus.Draft, ServiceOfferingStatus.Paused]
      : [ServiceOfferingStatus.Active];

  if (status === ServiceOfferingStatus.Active) {
    await assertCanSellServices(sellerId);
    await assertUnderActiveOfferingCap(sellerId);
  }

  const { count } = await dbWrite.serviceOffering.updateMany({
    where: { id, sellerId, status: { in: from } },
    data: { status },
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
