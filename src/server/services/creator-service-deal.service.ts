import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { assertCreatorShopVisible } from '~/server/services/creator-shop.service';
import { createMessage, upsertDealChat } from '~/server/services/chat.service';
import {
  getDealPartiesWithTitle,
  notifyServiceDeal,
  notifyServiceDealTransition,
} from '~/server/services/creator-service-deal-notify';
import {
  claimHold,
  claimRefund,
  dealFinalsClear,
  holdDeal,
  lockDeal,
  refundDeal,
  releaseDeal,
} from '~/server/services/creator-service-escrow.service';
import {
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import {
  SERVICE_DEAL_ACCEPT_WINDOW_MS,
  SERVICE_DEAL_AUTO_COMPLETE_MS,
  SERVICE_DEAL_CANCELLATION_RESPONSE_MS,
  SERVICE_DEAL_DISPUTE_WINDOW_MS,
  SERVICE_DEAL_LATE_CANCEL_AFTER_MS,
  SERVICE_DEAL_OPEN_STATUSES,
  SERVICE_SFW_MAX_NSFW_LEVEL,
  isMatureServiceLevel,
  serviceRequestAllowed,
  type ServiceDealCancellationReasonCode,
  type ServiceDealDeclineReasonCode,
  type ServiceDealDisputeReasonCode,
  type ServiceDealReasonCode,
} from '~/shared/constants/creator-services.constants';
import { Flags } from '~/shared/utils/flags';
import type { ServiceDealEventType, ServiceDealStatus } from '~/shared/utils/prisma/enums';
import {
  dealActions,
  dealActorRole,
  dealEventActorId,
  dealVisibleReason,
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
  /** Take the deal row's lock first, so the preconditions in `where` read what other writers left. */
  lock?: boolean;
  /** The acting party's own reason, stored as the event's comment and code instead of `comment`. */
  reason?: PreparedReason;
  /** The deal column that also keeps the reason's text. */
  reasonColumn?: 'cancellationReason' | 'disputeReason';
};

/** A party's reason, after `prepareReason`. */
type PreparedReason = {
  text: string | null;
  code: ServiceDealReasonCode | null;
  /** A muted party gets `other` when they gave no code. */
  defaultOther: boolean;
  /** The party was already muted when the text was looked at, so it was neither scanned nor kept. */
  mutedBefore: boolean;
};

/**
 * A party's reason for leaving a deal, as it may be stored. Text is scanned, unless the party is
 * muted, in which case it is dropped unscanned: a muted party is never refused, only silenced. The
 * transition reads the mute again from the User row, so a mute that lands in between still wins.
 */
async function prepareReason(
  userId: number,
  {
    text,
    code,
    coded = false,
    required = false,
  }: {
    text?: string | null;
    code?: ServiceDealReasonCode | null;
    /** The action has a list of codes. */
    coded?: boolean;
    required?: boolean;
  }
): Promise<PreparedReason> {
  if (required && !text && !code) throw throwBadRequestError('Give a reason');
  let muted = false;
  if (text) {
    const [actor] = await dbWrite.$queryRaw<{ muted: boolean }[]>`
      SELECT "muted" FROM "User" WHERE "id" = ${userId}::int`;
    muted = !!actor?.muted;
    if (!muted) await assertDealText(text);
  }
  return {
    text: muted ? null : text || null,
    code: code ?? null,
    // A required reason with no text came with a code, or was refused above.
    defaultOther: coded && !!text,
    mutedBefore: muted,
  };
}

/** Read once, inside the transition, so the event and the deal column store the same thing. */
async function storedReason(tx: Prisma.TransactionClient, actorId: number, reason: PreparedReason) {
  const [actor] = await tx.$queryRaw<{ muted: boolean }[]>`
    SELECT "muted" FROM "User" WHERE "id" = ${actorId}::int`;
  const muted = reason.mutedBefore || !!actor?.muted;
  return {
    text: muted ? null : reason.text,
    code: reason.code ?? (muted && reason.defaultOther ? 'other' : null),
  };
}

/** Returns whether this call moved the deal. */
export async function transitionDeal(t: Transition) {
  const eventId = await dbWrite.$transaction(async (tx) => {
    if (t.lock)
      await tx.$queryRaw`SELECT 1 FROM "ServiceDeal" WHERE "id" = ${t.dealId}::int FOR UPDATE`;
    const reason = t.reason ? await storedReason(tx, t.actorId, t.reason) : null;
    const updated = await tx.$executeRaw`
      UPDATE "ServiceDeal"
      SET "status" = ${t.to}::"ServiceDealStatus", "updatedAt" = now()
        ${t.refund ? Prisma.sql`, "closedAt" = now()` : Prisma.empty}
        ${t.set ?? Prisma.empty}
        ${
          reason && t.reasonColumn
            ? Prisma.sql`, ${Prisma.raw(`"${t.reasonColumn}"`)} = ${reason.text}::text`
            : Prisma.empty
        }
      WHERE "id" = ${t.dealId}::int AND "status" IN (${statusList(t.from)})
        ${t.where ? Prisma.sql`AND ${t.where}` : Prisma.empty}`;
    if (updated === 0) return null;

    const [event] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type", "round", "comment", "reasonCode")
      SELECT ${t.dealId}::int, ${t.actorId}::int, ${t.event}::"ServiceDealEventType",
             "revisionsUsed", ${reason ? reason.text : t.comment ?? null}::text,
             ${reason?.code ?? null}::text
      FROM "ServiceDeal" WHERE "id" = ${t.dealId}::int
      RETURNING "id"`;

    // A deal still confirming payment claims nothing here; reconcile claims it if the hold lands.
    if (t.refund) await claimRefund(tx, t.dealId);
    return event.id;
  });
  const moved = eventId !== null;

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

  if (moved)
    await notifyServiceDealTransition({
      dealId: t.dealId,
      event: t.event,
      eventId,
      actorId: t.actorId,
    });

  return moved;
}

/** CONFLICT, so the client refetches on the code rather than on copy. */
const movedOn = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'This deal has moved on. Refresh to see where it is.',
  });

/** CONFLICT, as `movedOn`; the request modal adds "Nothing was charged." to any conflict. */
const requestAlreadyWaiting = () =>
  new TRPCError({
    code: 'CONFLICT',
    message:
      'You already have a request waiting on this service. You can send another once the seller answers it.',
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
  revisionsIncluded: number;
  deliveryDays: number;
  blocked: boolean;
  sellerOk: boolean;
  maxNsfwLevel: number;
};

const termsChanged = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'The price or terms of this service have changed. Review them and try again.',
  });

/**
 * Creates the deal from the offering's CURRENT terms, copied in one statement, and takes the hold.
 * The buyer supplies only the offering, their brief and (from the request's domain, never the
 * input) the Buzz type.
 */
export async function requestServiceDeal({
  offeringId,
  expectedPrice,
  expectedRevisionsIncluded,
  expectedDeliveryDays,
  buyerId,
  requestText,
  disclosureVersion,
  buzzType,
  servableLevels,
  consentLevels,
}: {
  offeringId: number;
  /** The terms the buyer was shown. The deal never takes different ones. */
  expectedPrice: number;
  expectedRevisionsIncluded: number;
  expectedDeliveryDays: number;
  buyerId: number;
  requestText: string;
  /** The buyer-disclosure version shown before the hold. */
  disclosureVersion: string;
  buzzType: string;
  /** What the request's domain may be served (`domainServableLevels`). */
  servableLevels: number;
  /** The buyer's own browsing level (`getRequestBrowsingLevel`): their consent to mature levels. */
  consentLevels: number;
}) {
  if (!isServiceDealBuzzType(buzzType))
    throw throwBadRequestError(`Services cannot be paid in ${buzzType} Buzz`);
  if (disclosureVersion !== SERVICES_TERMS_VERSION)
    throw throwBadRequestError('Review the request terms before sending. Nothing was charged.');

  await throwOnBlockedUserContent(requestText, { surface: 'creator-service-request' });

  const [offering] = await dbWrite.$queryRaw<OfferingRow[]>`
    SELECT o."id", o."sellerId", o."status"::text AS "status", o."maxOpenDeals", o."price",
      o."revisionsIncluded", o."deliveryDays",
      (SELECT count(*)::int FROM "ServiceDeal" d
        WHERE d."offeringId" = o."id" AND d."status" IN (${OPEN})) AS "open",
      NOT ${notBlockedBetween(Prisma.sql`${buyerId}::int`, Prisma.sql`o."sellerId"`)} AS "blocked",
      ${sellerInGoodStanding(Prisma.sql`o."sellerId"`)} AS "sellerOk", o."maxNsfwLevel"
    FROM "ServiceOffering" o WHERE o."id" = ${offeringId}::int`;
  // A mature service on a domain that does not serve it is hidden there, so it is not found.
  if (
    !offering ||
    offering.status !== 'Active' ||
    !offering.sellerOk ||
    !(offering.maxNsfwLevel & servableLevels)
  )
    throw throwNotFoundError('Service not found');
  // The same visibility the storefront applies: an off or private shop takes no requests.
  await assertCreatorShopVisible({ userId: offering.sellerId, viewerId: buyerId });
  if (offering.sellerId === buyerId) throw throwBadRequestError('You cannot buy your own service');
  if (offering.blocked) throw throwBadRequestError('You cannot request this service');
  // After the visibility and block checks, which answer as if the service did not exist: a hidden
  // service must not be revealed as mature.
  if (!serviceRequestAllowed({ ...offering, servableLevels, consentLevels }))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This service delivers mature content. Turn it on in your browsing settings first.',
    });
  if (offering.maxOpenDeals !== null && offering.open >= offering.maxOpenDeals)
    throw throwBadRequestError('This service is not taking new requests right now');
  if (
    offering.price !== expectedPrice ||
    offering.revisionsIncluded !== expectedRevisionsIncluded ||
    offering.deliveryDays !== expectedDeliveryDays
  )
    throw termsChanged();
  const [waiting] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "ServiceDeal"
    WHERE "offeringId" = ${offeringId}::int AND "buyerId" = ${buyerId}::int
      AND "status" = 'Requested'::"ServiceDealStatus"
    LIMIT 1`;
  if (waiting) throw requestAlreadyWaiting();

  // The checks above are for the message; this statement repeats them as its own preconditions.
  const dealId = await dbWrite.$transaction(async (tx) => {
    // Serialises requests per offering, so two at the cap cannot both count the same open deals.
    await tx.$queryRaw`SELECT 1 FROM "ServiceOffering" WHERE "id" = ${offeringId}::int FOR UPDATE`;
    const [created] = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceDeal" ("offeringId", "buyerId", "sellerId", "price", "buzzType",
        "feeAmount", "revisionsIncluded", "deliveryDays", "previewKind", "status", "requestText",
        "updatedAt", "maxNsfwLevel")
      SELECT o."id", ${buyerId}::int, o."sellerId", o."price", ${buzzType}::"ServiceBuzzType",
        0, o."revisionsIncluded", o."deliveryDays", o."previewKind", 'Requested'::"ServiceDealStatus",
        ${requestText}::text, now(), o."maxNsfwLevel"
      FROM "ServiceOffering" o
      WHERE o."id" = ${offeringId}::int
        AND o."status" = 'Active'::"ServiceOfferingStatus"
        AND o."price" = ${expectedPrice}::int
        AND o."revisionsIncluded" = ${expectedRevisionsIncluded}::int
        AND o."deliveryDays" = ${expectedDeliveryDays}::int
        AND o."sellerId" <> ${buyerId}::int
        -- serviceRequestAllowed: SFW always; mature only where served, to a buyer who opted in.
        AND (o."maxNsfwLevel" <= ${SERVICE_SFW_MAX_NSFW_LEVEL}::int OR (
          (o."maxNsfwLevel" & ${servableLevels}::int) <> 0
          AND (o."maxNsfwLevel" & ${consentLevels}::int) <> 0
        ))
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
  // An unconfirmed hold is announced by reconcile once it lands; the seller cannot accept before.
  if (outcome === 'held') await notifyServiceDeal({ dealId, notice: 'requested', to: 'seller' });

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

export const declineServiceDeal = async ({
  dealId,
  userId,
  reason,
  reasonCode,
}: {
  dealId: number;
  userId: number;
  reason?: string | null;
  reasonCode?: ServiceDealDeclineReasonCode | null;
}) =>
  requireTransition({
    dealId,
    from: ['Requested'],
    to: 'Declined',
    actorId: userId,
    event: 'Declined',
    reason: await prepareReason(userId, { text: reason, code: reasonCode, coded: true }),
    where: Prisma.sql`"sellerId" = ${userId}::int`,
    set: Prisma.sql`, "closeReason" = 'declined'`,
    refund: true,
  });

/**
 * Only a CONFIRMED hold can be accepted (the migration's `ServiceDeal_held_before_work` refuses
 * the rest too), and not across a block made since the request, and not once a moderator has taken
 * the offering down: a pending request then leaves only by decline, withdraw or expiry, each refunded.
 */
export async function acceptServiceDeal({ dealId, userId }: { dealId: number; userId: number }) {
  await requireTransition({
    dealId,
    from: ['Requested'],
    to: 'Accepted',
    actorId: userId,
    event: 'Accepted',
    where: Prisma.sql`"sellerId" = ${userId}::int AND "heldAt" IS NOT NULL
      AND ${notBlockedBetween(Prisma.sql`"buyerId"`, Prisma.sql`"sellerId"`)}
      AND NOT EXISTS (SELECT 1 FROM "ServiceOffering" o
        WHERE o."id" = "ServiceDeal"."offeringId" AND o."removedReason" IS NOT NULL)`,
    set: Prisma.sql`, "acceptedAt" = now(), "dueAt" = now() + make_interval(days => "deliveryDays")`,
  }).catch(async (error) => {
    // The claim above is what refuses it; this only says why, instead of "moved on", which would
    // send the seller back to the same Accept button. Scoped to the seller's own pending request,
    // so it reveals nothing to anyone else and a deal that has moved on still gets "moved on".
    const [takenDown] = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT o."id" FROM "ServiceDeal" d JOIN "ServiceOffering" o ON o."id" = d."offeringId"
      WHERE d."id" = ${dealId}::int AND d."sellerId" = ${userId}::int
        AND d."status" = 'Requested'::"ServiceDealStatus" AND o."removedReason" IS NOT NULL`;
    if (takenDown)
      throw throwBadRequestError(
        'A moderator removed this service, so this request can only be declined.'
      );
    throw error;
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
  const deal = await getDealPartiesWithTitle(dealId);
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

const finalsPending = () =>
  new TRPCError({
    code: 'CONFLICT',
    message: 'The final files are still being checked. You can accept once they are ready.',
  });

/**
 * Completes only once the round's finals have all passed scanning: the buyer downloads them at
 * completion, and the dispute window that follows must start with the files in hand.
 */
export async function acceptServiceDealDelivery({
  dealId,
  userId,
}: {
  dealId: number;
  userId: number;
}) {
  const moved = await transitionDeal({
    dealId,
    from: ['Delivered'],
    to: 'Completed',
    actorId: userId,
    event: 'Completed',
    where: Prisma.sql`"buyerId" = ${userId}::int AND ${dealFinalsClear()}`,
    set: complete,
  });
  if (moved) return;
  const [deal] = await dbWrite.$queryRaw<{ waiting: boolean }[]>`
    SELECT "status" = 'Delivered'::"ServiceDealStatus" AND "buyerId" = ${userId}::int AS "waiting"
    FROM "ServiceDeal" WHERE "id" = ${dealId}::int`;
  throw deal?.waiting ? finalsPending() : movedOn();
}

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

export const requestServiceDealCancellation = async ({
  dealId,
  userId,
  reason,
  reasonCode,
}: {
  dealId: number;
  userId: number;
  reason?: string | null;
  reasonCode?: ServiceDealCancellationReasonCode | null;
}) =>
  requireTransition({
    dealId,
    from: ['Accepted', 'Delivered', 'InRevision'],
    to: 'CancellationRequested',
    actorId: userId,
    event: 'CancellationRequested',
    reason: await prepareReason(userId, {
      text: reason,
      code: reasonCode,
      coded: true,
      required: true,
    }),
    reasonColumn: 'cancellationReason',
    where: Prisma.sql`(${userId}::int IN ("buyerId", "sellerId"))`,
    set: Prisma.sql`, "cancellationRequestedAt" = now(), "cancellationRequestedById" = ${userId}::int`,
  });

/** Only the OTHER party answers. Agreeing refunds; declining sends the deal to moderators. */
export const respondServiceDealCancellation = async ({
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
  const reason = await prepareReason(userId, { text: comment });
  return agree
    ? requireTransition({
        dealId,
        from: ['CancellationRequested'],
        to: 'Cancelled',
        actorId: userId,
        event: 'CancellationAccepted',
        reason,
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
        reason,
        where: otherParty,
        set: Prisma.sql`, "disputeOpenedAt" = now(), "disputeReason" = 'cancellation_declined'`,
      });
};

/** The buyer reports final files missing, broken or not as previewed, before the payout. */
export const openServiceDealDispute = async ({
  dealId,
  userId,
  reason,
  reasonCode,
}: {
  dealId: number;
  userId: number;
  reason?: string | null;
  reasonCode?: ServiceDealDisputeReasonCode | null;
}) =>
  requireTransition({
    dealId,
    from: ['Completed'],
    to: 'Disputed',
    actorId: userId,
    event: 'Disputed',
    reason: await prepareReason(userId, {
      text: reason,
      code: reasonCode,
      coded: true,
      required: true,
    }),
    reasonColumn: 'disputeReason',
    // clock_timestamp(), not now(): blocked behind a release claim's row lock, this UPDATE is
    // re-checked against the row once the claim commits, and now() would still be this
    // transaction's start, inside the window. A guard re-checked that way must test the row's own
    // columns; a NOT EXISTS on the legs would read the old snapshot and miss the claim.
    where: Prisma.sql`"buyerId" = ${userId}::int AND "releaseAt" > clock_timestamp() AND "settledAt" IS NULL`,
    set: Prisma.sql`, "disputeOpenedAt" = now()`,
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
    where: Prisma.sql`"deliveredAt" + ${ms(SERVICE_DEAL_AUTO_COMPLETE_MS)} <= now()
      AND ${dealFinalsClear()}`,
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
  servicesEnabled,
}: {
  dealId: number;
  userId: number;
  isModerator?: boolean;
  /** `creatorServices`: with it off, the actions it gates are not offered. */
  servicesEnabled: boolean;
}) {
  const deal = await dbWrite.serviceDeal.findUnique({
    where: { id: dealId },
    include: {
      offering: { select: { id: true, title: true, coverImageId: true, removedReason: true } },
      buyer: { select: dealUserSelect },
      seller: { select: dealUserSelect },
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!deal || (!isModerator && deal.buyerId !== userId && deal.sellerId !== userId))
    throw throwNotFoundError('Deal not found');

  // From the row, not the session, so a fresh mute shows before the next sign-in.
  const [viewer] = await dbWrite.$queryRaw<{ muted: boolean }[]>`
    SELECT "muted" FROM "User" WHERE "id" = ${userId}::int`;
  const { removedReason, ...offering } = deal.offering;
  const offeringTakenDown = removedReason != null;
  const { actions, primaryAction } = dealActions(deal, userId, new Date(), {
    gatedAllowed: servicesEnabled && !viewer?.muted,
    offeringTakenDown,
  });
  // Decision (briony, 2026-10-15): the seller's moderation status is not the buyer's to see.
  const seesTakedown = isModerator || deal.sellerId === userId;
  return {
    id: deal.id,
    status: deal.status,
    viewerRole: dealViewerRole(deal, userId),
    /** The client gates the page on this, as it does any mature content (`<Gated>`). */
    maxNsfwLevel: deal.maxNsfwLevel,
    mature: isMatureServiceLevel(deal.maxNsfwLevel),
    /** A muted viewer can leave the deal with a reason code, but their free text is dropped. */
    viewerMuted: !!viewer?.muted,
    offering,
    /** Seller and moderators only, and never the reason, which reaches the seller by notification. */
    offeringTakenDown: seesTakedown && offeringTakenDown,
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
      ? {
          openedAt: deal.disputeOpenedAt,
          reason: dealVisibleReason(deal.disputeReason, isModerator),
        }
      : null,
    held: !!deal.heldAt,
    settled: !!deal.settledAt,
    deadlines: dealDeadlines(deal),
    actions,
    primaryAction,
    events: deal.events.map((event) => ({
      id: event.id,
      type: event.type,
      actorId: dealEventActorId(deal, event.actorId),
      actorRole: dealActorRole(deal, event.actorId),
      round: event.round,
      comment: dealVisibleReason(event.comment, isModerator),
      reasonCode: event.reasonCode,
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
  servicesEnabled,
  servableLevels,
}: {
  userId: number;
  role: 'buyer' | 'seller';
  status?: 'open' | 'closed';
  cursor?: number;
  limit: number;
  servicesEnabled: boolean;
  /** What the request's domain may be served: a mature deal is left out where it is not. */
  servableLevels: number;
}) {
  const open = [...SERVICE_DEAL_OPEN_STATUSES] as ServiceDealStatus[];
  const mine = {
    ...(role === 'buyer' ? { buyerId: userId } : { sellerId: userId }),
    ...(status === 'open' ? { status: { in: open } } : {}),
    ...(status === 'closed' ? { status: { notIn: open } } : {}),
  };
  const servable = Flags.instanceToArray(servableLevels);
  const deals = await dbWrite.serviceDeal.findMany({
    where: {
      ...mine,
      maxNsfwLevel: { in: servable },
      ...(cursor ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    include: {
      offering: { select: { id: true, title: true, coverImageId: true, removedReason: true } },
      buyer: { select: dealUserSelect },
      seller: { select: dealUserSelect },
    },
  });

  const page = deals.slice(0, limit);
  const [viewer] = await dbWrite.$queryRaw<{ muted: boolean }[]>`
    SELECT "muted" FROM "User" WHERE "id" = ${userId}::int`;
  const gatedAllowed = servicesEnabled && !viewer?.muted;
  // So the list can say the rest are on the domain that serves them, rather than look empty.
  const hiddenOffDomain = await dbWrite.serviceDeal.count({
    where: { ...mine, maxNsfwLevel: { notIn: servable } },
  });
  return {
    hiddenOffDomain,
    items: page.map(({ offering: { removedReason, ...offering }, ...deal }) => ({
      id: deal.id,
      status: deal.status,
      maxNsfwLevel: deal.maxNsfwLevel,
      offering,
      offeringTakenDown: role === 'seller' && removedReason != null,
      counterparty: role === 'buyer' ? deal.seller : deal.buyer,
      price: deal.price,
      buzzType: deal.buzzType,
      revisionsUsed: deal.revisionsUsed,
      revisionsIncluded: deal.revisionsIncluded,
      requestedAt: deal.requestedAt,
      dueAt: deal.dueAt,
      nextDeadline: nextDealDeadline(deal),
      ...dealActions(deal, userId, new Date(), {
        gatedAllowed,
        offeringTakenDown: removedReason != null,
      }),
    })),
    nextCursor: deals.length > limit ? page[page.length - 1].id : undefined,
  };
}

export type ServiceDisputeResolutionInput = 'Refund' | 'Release';

export type ResolveServiceDealDisputeResult =
  | { status: 'resolved' | 'already-resolved'; resolution: ServiceDisputeResolutionInput }
  | { status: 'held-for-review'; reason: string | null }
  | { status: 'refused'; reason: 'finals_not_passed'; message: string };

const FINALS_NOT_PASSED =
  'Not every final file has finished uploading and passed scanning. Refund, or clear a failed scan in moderation first.';

/**
 * A moderator settles a Disputed deal, whatever sent it there: the buyer, a declined
 * cancellation, a failed final, or a seller unavailable at payout.
 *
 * - Refund: Cancelled, and the hold goes back to the buyer through `claimRefund`.
 * - Release: Completed with the window closed now, and the seller is paid through `claimRelease`,
 *   the only writer of a Release leg. Refused while the round's finals have not all passed
 *   scanning: nobody is paid for files that failed, and the buyer could not download them.
 *
 * Idempotent: a deal already resolved answers with its resolution and moves no money. The deal row
 * is locked before it is read, so two moderators cannot both resolve it.
 */
export async function resolveServiceDealDispute({
  dealId,
  moderatorId,
  resolution,
  note,
}: {
  dealId: number;
  moderatorId: number;
  resolution: ServiceDisputeResolutionInput;
  note?: string | null;
}): Promise<ResolveServiceDealDisputeResult> {
  const outcome = await dbWrite.$transaction(async (tx) => {
    await lockDeal(tx, dealId);
    const [deal] = await tx.$queryRaw<
      {
        status: ServiceDealStatus;
        resolution: ServiceDisputeResolutionInput | null;
        clear: boolean;
      }[]
    >`
      SELECT "status"::text AS "status", "disputeResolution"::text AS "resolution",
        ${dealFinalsClear()} AS "clear"
      FROM "ServiceDeal" WHERE "id" = ${dealId}::int`;
    if (!deal) return 'not-found' as const;
    if (deal.status !== 'Disputed')
      return deal.resolution ? { already: deal.resolution } : ('not-disputed' as const);
    if (resolution === 'Release' && !deal.clear) return 'finals' as const;

    const resolved = Prisma.sql`"disputeResolution" = ${resolution}::"ServiceDisputeResolution",
      "disputeResolvedAt" = now(), "disputeResolvedById" = ${moderatorId}::int, "updatedAt" = now()`;
    if (resolution === 'Release')
      await tx.$executeRaw`
        UPDATE "ServiceDeal"
        SET "status" = 'Completed'::"ServiceDealStatus",
            "completedAt" = COALESCE("completedAt", now()), "releaseAt" = now(), ${resolved}
        WHERE "id" = ${dealId}::int AND "status" = 'Disputed'::"ServiceDealStatus"`;
    else
      await tx.$executeRaw`
        UPDATE "ServiceDeal"
        SET "status" = 'Cancelled'::"ServiceDealStatus", "closedAt" = now(),
            "closeReason" = 'dispute_refund', ${resolved}
        WHERE "id" = ${dealId}::int AND "status" = 'Disputed'::"ServiceDealStatus"`;
    await tx.$executeRaw`
      INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type", "comment")
      VALUES (${dealId}::int, ${moderatorId}::int, 'DisputeResolved'::"ServiceDealEventType",
        ${note ?? resolution}::text)`;
    if (resolution === 'Refund') await claimRefund(tx, dealId);
    return 'resolved' as const;
  });

  if (outcome === 'not-found') throw throwNotFoundError('Deal not found');
  if (outcome === 'not-disputed') throw movedOn();
  if (outcome === 'finals')
    return { status: 'refused', reason: 'finals_not_passed', message: FINALS_NOT_PASSED };
  if (typeof outcome === 'object')
    return { status: 'already-resolved', resolution: outcome.already };

  // Committed; the sweeps finish either payment if this one fails.
  await (resolution === 'Release' ? releaseDeal(dealId) : refundDeal(dealId)).catch((error) =>
    logToAxiom({
      name: 'creator-service-deal',
      type: 'error',
      message: 'payment after dispute resolution failed; the sweep will retry',
      dealId,
      resolution,
      error: (error as Error)?.message,
    }).catch(() => null)
  );
  // The payout claim re-checks the finals and the seller; if it held the deal again, it is back in
  // the queue and the moderator must not be told it was released.
  const [after] = await dbWrite.$queryRaw<{ status: ServiceDealStatus; reason: string | null }[]>`
    SELECT "status"::text AS "status", "disputeReason" AS "reason"
    FROM "ServiceDeal" WHERE "id" = ${dealId}::int`;
  if (after?.status === 'Disputed') return { status: 'held-for-review', reason: after.reason };
  return { status: 'resolved', resolution };
}

type DisputedDealRow = {
  id: number;
  offeringId: number;
  offeringTitle: string;
  buyerId: number;
  buyerUsername: string | null;
  sellerId: number;
  sellerUsername: string | null;
  sellerUnavailable: boolean;
  price: number;
  buzzType: string;
  revisionsUsed: number;
  disputeOpenedAt: Date | null;
  disputeReason: string | null;
  cancellationReason: string | null;
  completedAt: Date | null;
  deliveredAt: Date | null;
  finalsClear: boolean;
  cursor: string;
};

type DisputedDealEventRow = {
  id: number;
  dealId: number;
  type: ServiceDealEventType;
  actorId: number;
  round: number | null;
  comment: string | null;
  reasonCode: string | null;
  createdAt: Date;
};

/**
 * Opaque to callers: the last row's dispute time, as the database wrote it, and its id, so the
 * order is stable across ties. The time never passes through a JS Date, whose time zone handling
 * could shift it against a `timestamp without time zone` column.
 */
const DISPUTE_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})_(\d+)$/;

function parseDisputeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const match = DISPUTE_CURSOR.exec(cursor);
  if (!match) throw throwBadRequestError('Invalid cursor');
  return { openedAt: match[1], id: Number(match[2]) };
}

/**
 * The moderators' queue: Disputed deals, longest-waiting dispute first, with what a decision
 * needs. `finalsClear` false means a Release will be refused.
 */
export async function listDisputedServiceDeals({
  cursor,
  limit = 20,
}: {
  cursor?: string;
  limit?: number;
}) {
  const after = parseDisputeCursor(cursor);
  const page_ = after
    ? Prisma.sql`AND (d."disputeOpenedAt", d."id") > (${after.openedAt}::timestamp, ${after.id}::int)`
    : Prisma.empty;
  const rows = await dbWrite.$queryRaw<DisputedDealRow[]>`
    SELECT d."id", o."id" AS "offeringId", o."title" AS "offeringTitle",
      d."buyerId", b."username" AS "buyerUsername", d."sellerId", s."username" AS "sellerUsername",
      (s."bannedAt" IS NOT NULL OR s."deletedAt" IS NOT NULL) AS "sellerUnavailable",
      d."price", d."buzzType"::text AS "buzzType", d."revisionsUsed", d."disputeOpenedAt",
      d."disputeReason", d."cancellationReason", d."completedAt", d."deliveredAt",
      ${dealFinalsClear(Prisma.sql`d`)} AS "finalsClear",
      to_char(d."disputeOpenedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') || '_' || d."id" AS "cursor"
    FROM "ServiceDeal" d
    JOIN "ServiceOffering" o ON o."id" = d."offeringId"
    JOIN "User" b ON b."id" = d."buyerId"
    JOIN "User" s ON s."id" = d."sellerId"
    WHERE d."status" = 'Disputed'::"ServiceDealStatus" ${page_}
    ORDER BY d."disputeOpenedAt", d."id"
    LIMIT ${limit + 1}::int`;
  const page = rows.slice(0, limit);
  const events = page.length
    ? await dbWrite.$queryRaw<DisputedDealEventRow[]>`
        SELECT "id", "dealId", "type"::text AS "type", "actorId", "round", "comment", "reasonCode",
          "createdAt"
        FROM "ServiceDealEvent"
        WHERE "dealId" IN (${Prisma.join(page.map((row) => Prisma.sql`${row.id}::int`))})
        ORDER BY "createdAt", "id"`
    : [];

  return {
    items: page.map((row) => ({
      id: row.id,
      offering: { id: row.offeringId, title: row.offeringTitle },
      buyer: { id: row.buyerId, username: row.buyerUsername },
      seller: {
        id: row.sellerId,
        username: row.sellerUsername,
        unavailable: row.sellerUnavailable,
      },
      price: row.price,
      buzzType: row.buzzType,
      revisionsUsed: row.revisionsUsed,
      disputeOpenedAt: row.disputeOpenedAt,
      disputeReason: row.disputeReason,
      cancellationReason: row.cancellationReason,
      completedAt: row.completedAt,
      deliveredAt: row.deliveredAt,
      finalsClear: row.finalsClear,
      events: events
        .filter((event) => event.dealId === row.id)
        .map(({ dealId: _, ...event }) => event),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].cursor : undefined,
  };
}
