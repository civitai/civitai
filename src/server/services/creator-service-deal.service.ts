import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { assertCreatorShopVisible } from '~/server/services/creator-shop.service';
import { createMessage, upsertDealChat } from '~/server/services/chat.service';
import {
  claimHold,
  claimRefund,
  holdDeal,
  refundDeal,
} from '~/server/services/creator-service-escrow.service';
import {
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  SERVICE_DEAL_ACCEPT_WINDOW_MS,
  SERVICE_DEAL_AUTO_COMPLETE_MS,
  SERVICE_DEAL_CANCELLATION_RESPONSE_MS,
  SERVICE_DEAL_DISPUTE_WINDOW_MS,
  SERVICE_DEAL_LATE_CANCEL_AFTER_MS,
  SERVICE_DEAL_OPEN_STATUSES,
} from '~/shared/constants/creator-services.constants';
import type { ServiceDealEventType, ServiceDealStatus } from '~/shared/utils/prisma/enums';
import {
  dealActions,
  dealActorRole,
  dealDeadlines,
  dealViewerRole,
  nextDealDeadline,
} from '~/shared/utils/creator-service-deal-view';

/**
 * The Creator Services deal state machine. Every transition is ONE conditional UPDATE whose WHERE
 * clause is the whole precondition (status, which party may act, deadlines), run in the same
 * transaction as its event row and, where the deal closes with money going back, the Refund
 * claim. Two callers racing cannot both win, and a transition that needs money claims it
 * atomically. Buzz moves only after commit, through `creator-service-escrow.service`.
 */

/** Deals the buyer may pay for. Blue is not transferable, so a deal never takes it (Justin, v1). */
export const SERVICE_DEAL_BUZZ_TYPES = ['yellow', 'green'] as const;
export type ServiceDealBuzzType = (typeof SERVICE_DEAL_BUZZ_TYPES)[number];
export const isServiceDealBuzzType = (type: string): type is ServiceDealBuzzType =>
  (SERVICE_DEAL_BUZZ_TYPES as readonly string[]).includes(type);

const statusList = (statuses: readonly ServiceDealStatus[]) =>
  Prisma.join(statuses.map((status) => Prisma.sql`${status}::"ServiceDealStatus"`));

const ms = (value: number) => Prisma.sql`(${value}::int * interval '1 millisecond')`;

const OPEN = statusList(SERVICE_DEAL_OPEN_STATUSES);

type Transition = {
  dealId: number;
  from: readonly ServiceDealStatus[];
  to: ServiceDealStatus;
  /** -1 for the system. */
  actorId: number;
  event: ServiceDealEventType;
  comment?: string | null;
  /** Further preconditions, ANDed into the WHERE. Reference columns unqualified. */
  where?: Prisma.Sql;
  /** Further assignments, each prefixed with a comma. */
  set?: Prisma.Sql;
  /** The deal closes with the buyer's Buzz going back. */
  refund?: boolean;
};

/** Returns whether this call moved the deal. */
export async function transitionDeal(t: Transition) {
  const moved = await dbWrite.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "ServiceDeal"
      SET "status" = ${t.to}::"ServiceDealStatus", "updatedAt" = now()
        ${t.refund ? Prisma.sql`, "closedAt" = now()` : Prisma.empty}
        ${t.set ?? Prisma.empty}
      WHERE "id" = ${t.dealId}::int AND "status" IN (${statusList(t.from)})
        ${t.where ? Prisma.sql`AND ${t.where}` : Prisma.empty}`;
    if (updated === 0) return false;

    await tx.$executeRaw`
      INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type", "round", "comment")
      SELECT ${t.dealId}::int, ${t.actorId}::int, ${t.event}::"ServiceDealEventType",
             "revisionsUsed", ${t.comment ?? null}::text
      FROM "ServiceDeal" WHERE "id" = ${t.dealId}::int`;

    // A deal still confirming payment claims nothing here; reconcile claims it if the hold lands.
    if (t.refund) await claimRefund(tx, t.dealId);
    return true;
  });

  if (moved && t.refund)
    await refundDeal(t.dealId).catch((error) =>
      // The refund is claimed and the sweep finishes it; the transition itself succeeded.
      logToAxiom({
        name: 'creator-service-deal',
        type: 'error',
        message: 'refund after close failed; the sweep will retry',
        dealId: t.dealId,
        error: (error as Error)?.message,
      }).catch(() => null)
    );

  return moved;
}

/** CONFLICT, so the client refetches on the code rather than on copy. */
const movedOn = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'This deal has moved on. Refresh to see where it is.',
  });

async function requireTransition(t: Transition) {
  if (!(await transitionDeal(t))) throw movedOn();
}

type PartyRow = { buyerId: number; sellerId: number };

/** 404 for anyone who is not a party (or a moderator), so a deal id reveals nothing. */
export async function getDealParties(dealId: number, userId: number, isModerator = false) {
  const [deal] = await dbWrite.$queryRaw<PartyRow[]>`
    SELECT "buyerId", "sellerId" FROM "ServiceDeal" WHERE "id" = ${dealId}::int`;
  if (!deal || (!isModerator && deal.buyerId !== userId && deal.sellerId !== userId))
    throw throwNotFoundError('Deal not found');
  return deal;
}

/** The storefront's rule for who may sell (P1): a banned, deleted or muted seller sells nothing. */
const sellerInGoodStanding = (seller: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "User" u
  WHERE u."id" = ${seller} AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND u."muted" = false
)`;

const notBlockedBetween = (buyer: Prisma.Sql, seller: Prisma.Sql) => Prisma.sql`NOT EXISTS (
  SELECT 1 FROM "UserEngagement" ue
  WHERE ue."type" = 'Block'::"UserEngagementType"
    AND ((ue."userId" = ${buyer} AND ue."targetUserId" = ${seller})
      OR (ue."userId" = ${seller} AND ue."targetUserId" = ${buyer}))
)`;

type OfferingRow = {
  id: number;
  sellerId: number;
  status: string;
  open: number;
  maxOpenDeals: number | null;
  price: number;
  blocked: boolean;
  sellerOk: boolean;
};

const priceChanged = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'The price of this service has changed. Review it and try again.',
  });

/**
 * Creates the deal from the offering's CURRENT terms, copied in one statement, and takes the hold.
 * The buyer supplies only the offering, their brief and (from the request's domain, never the
 * input) the Buzz type.
 */
export async function requestServiceDeal({
  offeringId,
  expectedPrice,
  buyerId,
  requestText,
  buzzType,
}: {
  offeringId: number;
  /** The price the buyer was shown. The hold never takes a different one. */
  expectedPrice: number;
  buyerId: number;
  requestText: string;
  buzzType: string;
}) {
  if (!isServiceDealBuzzType(buzzType))
    throw throwBadRequestError(`Services cannot be paid in ${buzzType} Buzz`);

  await throwOnBlockedUserContent(requestText, { surface: 'creator-service-request' });

  const [offering] = await dbWrite.$queryRaw<OfferingRow[]>`
    SELECT o."id", o."sellerId", o."status"::text AS "status", o."maxOpenDeals", o."price",
      (SELECT count(*)::int FROM "ServiceDeal" d
        WHERE d."offeringId" = o."id" AND d."status" IN (${OPEN})) AS "open",
      NOT ${notBlockedBetween(Prisma.sql`${buyerId}::int`, Prisma.sql`o."sellerId"`)} AS "blocked",
      ${sellerInGoodStanding(Prisma.sql`o."sellerId"`)} AS "sellerOk"
    FROM "ServiceOffering" o WHERE o."id" = ${offeringId}::int`;
  if (!offering || offering.status !== 'Active' || !offering.sellerOk)
    throw throwNotFoundError('Service not found');
  // The same visibility the storefront applies: an off or private shop takes no requests.
  await assertCreatorShopVisible({ userId: offering.sellerId, viewerId: buyerId });
  if (offering.sellerId === buyerId) throw throwBadRequestError('You cannot buy your own service');
  if (offering.blocked) throw throwBadRequestError('You cannot request this service');
  if (offering.maxOpenDeals !== null && offering.open >= offering.maxOpenDeals)
    throw throwBadRequestError('This service is not taking new requests right now');
  if (offering.price !== expectedPrice) throw priceChanged();

  // The checks above are for the message; this statement repeats them as its own preconditions.
  const dealId = await dbWrite.$transaction(async (tx) => {
    // Serialises requests per offering, so two at the cap cannot both count the same open deals.
    await tx.$queryRaw`SELECT 1 FROM "ServiceOffering" WHERE "id" = ${offeringId}::int FOR UPDATE`;
    const [created] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceDeal" ("offeringId", "buyerId", "sellerId", "price", "buzzType",
        "feeAmount", "revisionsIncluded", "deliveryDays", "previewKind", "status", "requestText",
        "updatedAt")
      SELECT o."id", ${buyerId}::int, o."sellerId", o."price", ${buzzType}::"ServiceBuzzType",
        0, o."revisionsIncluded", o."deliveryDays", o."previewKind", 'Requested'::"ServiceDealStatus",
        ${requestText}::text, now()
      FROM "ServiceOffering" o
      WHERE o."id" = ${offeringId}::int
        AND o."status" = 'Active'::"ServiceOfferingStatus"
        AND o."price" = ${expectedPrice}::int
        AND o."sellerId" <> ${buyerId}::int
        -- One unanswered request per buyer per offering: a retried or doubled submit must not
        -- become a second deal and a second hold. Race-free under the offering lock above.
        AND NOT EXISTS (
          SELECT 1 FROM "ServiceDeal" p
          WHERE p."offeringId" = o."id" AND p."buyerId" = ${buyerId}::int
            AND p."status" = 'Requested'::"ServiceDealStatus"
        )
        AND ${sellerInGoodStanding(Prisma.sql`o."sellerId"`)}
        AND (o."maxOpenDeals" IS NULL OR o."maxOpenDeals" > (
          SELECT count(*) FROM "ServiceDeal" d WHERE d."offeringId" = o."id" AND d."status" IN (${OPEN})
        ))
        AND ${notBlockedBetween(Prisma.sql`${buyerId}::int`, Prisma.sql`o."sellerId"`)}
      RETURNING "id"`;
    if (!created) return null;

    await tx.$executeRaw`
      INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type")
      VALUES (${created.id}::int, ${buyerId}::int, 'Requested'::"ServiceDealEventType")`;
    await claimHold(tx, created.id);
    return created.id;
  });
  if (!dealId) throw movedOn();

  const outcome = await holdDeal({ dealId, buyerId, buzzType });
  if (outcome === 'refused') {
    await transitionDeal({
      dealId,
      from: ['Requested'],
      to: 'Cancelled',
      actorId: -1,
      event: 'Cancelled',
      comment: 'payment_refused',
      where: Prisma.sql`"heldAt" IS NULL`,
      set: Prisma.sql`, "closedAt" = now(), "closeReason" = 'payment_refused'`,
    });
    throw throwInsufficientFundsError();
  }

  return { id: dealId, status: 'Requested' as const, held: outcome === 'held' };
}

/** The buyer takes the request back before the seller answers. Refunds once the hold is confirmed. */
export const withdrawServiceDeal = ({ dealId, userId }: { dealId: number; userId: number }) =>
  requireTransition({
    dealId,
    from: ['Requested'],
    to: 'Cancelled',
    actorId: userId,
    event: 'Cancelled',
    comment: 'withdrawn',
    where: Prisma.sql`"buyerId" = ${userId}::int`,
    set: Prisma.sql`, "closeReason" = 'withdrawn'`,
    refund: true,
  });

export const declineServiceDeal = ({
  dealId,
  userId,
  reason,
}: {
  dealId: number;
  userId: number;
  reason?: string | null;
}) =>
  requireTransition({
    dealId,
    from: ['Requested'],
    to: 'Declined',
    actorId: userId,
    event: 'Declined',
    comment: reason,
    where: Prisma.sql`"sellerId" = ${userId}::int`,
    set: Prisma.sql`, "closeReason" = 'declined'`,
    refund: true,
  });

/**
 * Only a CONFIRMED hold can be accepted (the migration's `ServiceDeal_held_before_work` refuses
 * the rest too), and not across a block made since the request.
 */
export async function acceptServiceDeal({ dealId, userId }: { dealId: number; userId: number }) {
  await requireTransition({
    dealId,
    from: ['Requested'],
    to: 'Accepted',
    actorId: userId,
    event: 'Accepted',
    where: Prisma.sql`"sellerId" = ${userId}::int AND "heldAt" IS NOT NULL
      AND ${notBlockedBetween(Prisma.sql`"buyerId"`, Prisma.sql`"sellerId"`)}`,
    set: Prisma.sql`, "acceptedAt" = now(), "dueAt" = now() + make_interval(days => "deliveryDays")`,
  });

  await openDealChat(dealId).catch((error) =>
    // The deal is accepted either way; a missing chat is recoverable, a rolled-back accept is not.
    logToAxiom({
      name: 'creator-service-deal',
      type: 'error',
      message: 'deal chat could not be opened',
      dealId,
      error: (error as Error)?.message,
    }).catch(() => null)
  );
}

async function openDealChat(dealId: number) {
  const [deal] = await dbWrite.$queryRaw<{ buyerId: number; sellerId: number; title: string }[]>`
    SELECT d."buyerId", d."sellerId", o."title"
    FROM "ServiceDeal" d JOIN "ServiceOffering" o ON o."id" = d."offeringId"
    WHERE d."id" = ${dealId}::int`;
  if (!deal) return;

  const chat = await upsertDealChat({ sellerId: deal.sellerId, buyerId: deal.buyerId });
  await dbWrite.$executeRaw`
    UPDATE "ServiceDeal" SET "chatId" = ${chat.id}::int WHERE "id" = ${dealId}::int`;
  await createMessage({
    userId: -1,
    chatId: chat.id,
    contentType: 'Markdown',
    content: `Deal accepted: **${deal.title.replace(
      /[\\*_[\]`]/g,
      ''
    )}**. [Open the deal](/services/deals/${dealId})`,
  });
}

/** Called by the delivery upload (P3). */
export const markServiceDealDelivered = ({ dealId, userId }: { dealId: number; userId: number }) =>
  requireTransition({
    dealId,
    from: ['Accepted', 'InRevision'],
    to: 'Delivered',
    actorId: userId,
    event: 'Delivered',
    where: Prisma.sql`"sellerId" = ${userId}::int`,
    set: Prisma.sql`, "deliveredAt" = now()`,
  });

export const requestServiceDealRevision = ({
  dealId,
  userId,
  comment,
}: {
  dealId: number;
  userId: number;
  comment: string;
}) =>
  requireTransition({
    dealId,
    from: ['Delivered'],
    to: 'InRevision',
    actorId: userId,
    event: 'RevisionRequested',
    comment,
    where: Prisma.sql`"buyerId" = ${userId}::int AND "revisionsUsed" < "revisionsIncluded"`,
    set: Prisma.sql`, "revisionsUsed" = "revisionsUsed" + 1`,
  });

const complete = Prisma.sql`, "completedAt" = now(), "releaseAt" = now() + ${ms(
  SERVICE_DEAL_DISPUTE_WINDOW_MS
)}`;

export const acceptServiceDealDelivery = ({ dealId, userId }: { dealId: number; userId: number }) =>
  requireTransition({
    dealId,
    from: ['Delivered'],
    to: 'Completed',
    actorId: userId,
    event: 'Completed',
    where: Prisma.sql`"buyerId" = ${userId}::int`,
    set: complete,
  });

/**
 * The buyer leaves once the seller is a day past due, without the seller's agreement. Accepted
 * only: once anything was delivered the due date is history, and a revision must not turn an
 * on-time delivery into an instant refund. A late revision goes through a cancellation request.
 */
export const cancelLateServiceDeal = ({ dealId, userId }: { dealId: number; userId: number }) =>
  requireTransition({
    dealId,
    from: ['Accepted'],
    to: 'Cancelled',
    actorId: userId,
    event: 'Cancelled',
    comment: 'late',
    where: Prisma.sql`"buyerId" = ${userId}::int AND "dueAt" + ${ms(
      SERVICE_DEAL_LATE_CANCEL_AFTER_MS
    )} <= now()`,
    set: Prisma.sql`, "closeReason" = 'late'`,
    refund: true,
  });

export const requestServiceDealCancellation = ({
  dealId,
  userId,
  reason,
}: {
  dealId: number;
  userId: number;
  reason: string;
}) =>
  requireTransition({
    dealId,
    from: ['Accepted', 'Delivered', 'InRevision'],
    to: 'CancellationRequested',
    actorId: userId,
    event: 'CancellationRequested',
    comment: reason,
    where: Prisma.sql`(${userId}::int IN ("buyerId", "sellerId"))`,
    set: Prisma.sql`, "cancellationRequestedAt" = now(), "cancellationRequestedById" = ${userId}::int,
      "cancellationReason" = ${reason}::text`,
  });

/** Only the OTHER party answers. Agreeing refunds; declining sends the deal to moderators. */
export const respondServiceDealCancellation = ({
  dealId,
  userId,
  agree,
  comment,
}: {
  dealId: number;
  userId: number;
  agree: boolean;
  comment?: string | null;
}) => {
  const otherParty = Prisma.sql`(${userId}::int IN ("buyerId", "sellerId"))
    AND "cancellationRequestedById" <> ${userId}::int`;
  return agree
    ? requireTransition({
        dealId,
        from: ['CancellationRequested'],
        to: 'Cancelled',
        actorId: userId,
        event: 'CancellationAccepted',
        comment,
        where: otherParty,
        set: Prisma.sql`, "closeReason" = 'cancellation_agreed'`,
        refund: true,
      })
    : requireTransition({
        dealId,
        from: ['CancellationRequested'],
        to: 'Disputed',
        actorId: userId,
        event: 'CancellationDeclined',
        comment,
        where: otherParty,
        set: Prisma.sql`, "disputeOpenedAt" = now(), "disputeReason" = 'cancellation_declined'`,
      });
};

/** The buyer reports final files missing, broken or not as previewed, before the payout. */
export const openServiceDealDispute = ({
  dealId,
  userId,
  reason,
}: {
  dealId: number;
  userId: number;
  reason: string;
}) =>
  requireTransition({
    dealId,
    from: ['Completed'],
    to: 'Disputed',
    actorId: userId,
    event: 'Disputed',
    comment: reason,
    // clock_timestamp(), not now(): blocked behind a release claim's row lock, this UPDATE is
    // re-checked against the row once the claim commits, and now() would still be this
    // transaction's start, inside the window. A guard re-checked that way must test the row's own
    // columns; a NOT EXISTS on the legs would read the old snapshot and miss the claim.
    where: Prisma.sql`"buyerId" = ${userId}::int AND "releaseAt" > clock_timestamp() AND "settledAt" IS NULL`,
    set: Prisma.sql`, "disputeOpenedAt" = now(), "disputeReason" = ${reason}::text`,
  });

/** Reasons are user text shown to the other party and to moderators. */
export const assertDealText = (text: string | null | undefined) =>
  throwOnBlockedUserContent(text, { surface: 'creator-service-deal' });

type Timed = { status: ServiceDealStatus; column: string; after: number };

async function sweep(
  { status, column, after }: Timed,
  limit: number,
  move: (dealId: number) => Promise<boolean>
) {
  const due = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "ServiceDeal"
    WHERE "status" = ${status}::"ServiceDealStatus"
      AND ${Prisma.raw(`"${column}"`)} + ${ms(after)} <= now()
    ORDER BY ${Prisma.raw(`"${column}"`)}
    LIMIT ${limit}::int`;

  let moved = 0;
  for (const { id } of due) {
    try {
      if (await move(id)) moved++;
    } catch (error) {
      logToAxiom({
        name: 'creator-service-deal',
        type: 'error',
        message: `${status} sweep failed`,
        dealId: id,
        error: (error as Error)?.message,
      }).catch(() => null);
    }
  }
  return { considered: due.length, moved };
}

/**
 * The timed transitions, one deal at a time. Each repeats its deadline in its own WHERE, so a deal
 * whose clock restarted between the sweep's SELECT and the UPDATE (a re-delivery after a
 * revision) is not moved on the strength of the old one.
 */
export const expireServiceDeal = (dealId: number) =>
  transitionDeal({
    dealId,
    from: ['Requested'],
    to: 'Expired',
    actorId: -1,
    event: 'Expired',
    where: Prisma.sql`"requestedAt" + ${ms(SERVICE_DEAL_ACCEPT_WINDOW_MS)} <= now()`,
    set: Prisma.sql`, "closeReason" = 'expired'`,
    refund: true,
  });

export const autoCompleteServiceDeal = (dealId: number) =>
  transitionDeal({
    dealId,
    from: ['Delivered'],
    to: 'Completed',
    actorId: -1,
    event: 'Completed',
    comment: 'auto',
    where: Prisma.sql`"deliveredAt" + ${ms(SERVICE_DEAL_AUTO_COMPLETE_MS)} <= now()`,
    set: complete,
  });

export const autoCancelServiceDeal = (dealId: number) =>
  transitionDeal({
    dealId,
    from: ['CancellationRequested'],
    to: 'Cancelled',
    actorId: -1,
    event: 'Cancelled',
    comment: 'cancellation_unanswered',
    where: Prisma.sql`"cancellationRequestedAt" + ${ms(
      SERVICE_DEAL_CANCELLATION_RESPONSE_MS
    )} <= now()`,
    set: Prisma.sql`, "closeReason" = 'cancellation_unanswered'`,
    refund: true,
  });

export const expireServiceDeals = ({ limit = 100 } = {}) =>
  sweep(
    { status: 'Requested', column: 'requestedAt', after: SERVICE_DEAL_ACCEPT_WINDOW_MS },
    limit,
    expireServiceDeal
  );

export const autoCompleteServiceDeals = ({ limit = 100 } = {}) =>
  sweep(
    { status: 'Delivered', column: 'deliveredAt', after: SERVICE_DEAL_AUTO_COMPLETE_MS },
    limit,
    autoCompleteServiceDeal
  );

export const autoCancelServiceDeals = ({ limit = 100 } = {}) =>
  sweep(
    {
      status: 'CancellationRequested',
      column: 'cancellationRequestedAt',
      after: SERVICE_DEAL_CANCELLATION_RESPONSE_MS,
    },
    limit,
    autoCancelServiceDeal
  );

const dealUserSelect = { id: true, username: true, image: true } as const;

/** Open deals per offering, by the same definition `requestServiceDeal` enforces the cap with. */
export async function countOpenDealsByOffering(offeringIds: number[]) {
  if (!offeringIds.length) return new Map<number, number>();
  // The replica: this feeds a public storefront count. `requestServiceDeal` enforces the cap on
  // the primary.
  const rows = await dbRead.$queryRaw<{ offeringId: number; open: number }[]>`
    SELECT "offeringId", count(*)::int AS "open" FROM "ServiceDeal"
    WHERE "offeringId" IN (${Prisma.join(offeringIds.map((id) => Prisma.sql`${id}::int`))})
      AND "status" IN (${OPEN})
    GROUP BY "offeringId"`;
  return new Map(rows.map((row) => [row.offeringId, row.open]));
}

export async function getServiceDealView({
  dealId,
  userId,
  isModerator = false,
}: {
  dealId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const deal = await dbWrite.serviceDeal.findUnique({
    where: { id: dealId },
    include: {
      offering: { select: { id: true, title: true, coverImageId: true } },
      buyer: { select: dealUserSelect },
      seller: { select: dealUserSelect },
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!deal || (!isModerator && deal.buyerId !== userId && deal.sellerId !== userId))
    throw throwNotFoundError('Deal not found');

  const { actions, primaryAction } = dealActions(deal, userId);
  return {
    id: deal.id,
    status: deal.status,
    viewerRole: dealViewerRole(deal, userId),
    offering: deal.offering,
    buyer: deal.buyer,
    seller: deal.seller,
    price: deal.price,
    buzzType: deal.buzzType,
    revisionsIncluded: deal.revisionsIncluded,
    revisionsUsed: deal.revisionsUsed,
    deliveryDays: deal.deliveryDays,
    previewKind: deal.previewKind,
    requestText: deal.requestText,
    chatId: deal.chatId,
    requestedAt: deal.requestedAt,
    acceptedAt: deal.acceptedAt,
    dueAt: deal.dueAt,
    deliveredAt: deal.deliveredAt,
    completedAt: deal.completedAt,
    releaseAt: deal.releaseAt,
    closedAt: deal.closedAt,
    closeReason: deal.closeReason,
    cancellation: deal.cancellationRequestedAt
      ? {
          requestedAt: deal.cancellationRequestedAt,
          requestedById: deal.cancellationRequestedById,
          reason: deal.cancellationReason,
        }
      : null,
    dispute: deal.disputeOpenedAt
      ? { openedAt: deal.disputeOpenedAt, reason: deal.disputeReason }
      : null,
    held: !!deal.heldAt,
    settled: !!deal.settledAt,
    deadlines: dealDeadlines(deal),
    actions,
    primaryAction,
    events: deal.events.map((event) => ({
      id: event.id,
      type: event.type,
      actorId: event.actorId,
      actorRole: dealActorRole(deal, event.actorId),
      round: event.round,
      comment: event.comment,
      createdAt: event.createdAt,
    })),
  };
}

export async function listMyServiceDeals({
  userId,
  role,
  status,
  cursor,
  limit,
}: {
  userId: number;
  role: 'buyer' | 'seller';
  status?: 'open' | 'closed';
  cursor?: number;
  limit: number;
}) {
  const open = [...SERVICE_DEAL_OPEN_STATUSES] as ServiceDealStatus[];
  const deals = await dbWrite.serviceDeal.findMany({
    where: {
      ...(role === 'buyer' ? { buyerId: userId } : { sellerId: userId }),
      ...(status === 'open' ? { status: { in: open } } : {}),
      ...(status === 'closed' ? { status: { notIn: open } } : {}),
      ...(cursor ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    include: {
      offering: { select: { id: true, title: true, coverImageId: true } },
      buyer: { select: dealUserSelect },
      seller: { select: dealUserSelect },
    },
  });

  const page = deals.slice(0, limit);
  return {
    items: page.map((deal) => ({
      id: deal.id,
      status: deal.status,
      offering: deal.offering,
      counterparty: role === 'buyer' ? deal.seller : deal.buyer,
      price: deal.price,
      buzzType: deal.buzzType,
      revisionsUsed: deal.revisionsUsed,
      revisionsIncluded: deal.revisionsIncluded,
      requestedAt: deal.requestedAt,
      dueAt: deal.dueAt,
      nextDeadline: nextDealDeadline(deal),
      ...dealActions(deal, userId),
    })),
    nextCursor: deals.length > limit ? page[page.length - 1].id : undefined,
  };
}
