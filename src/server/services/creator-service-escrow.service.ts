import { Prisma } from '@prisma/client';
import { isSafeToRetry } from '@civitai/buzz';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  serviceDealExhaustedLegsGauge,
  serviceDealUnconfirmedHoldsGauge,
} from '~/server/prom/client';
import {
  createMultiAccountBuzzTransaction,
  getMultiAccountTransactionsByPrefix,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { getPrefixRefundState } from '~/server/services/buzz-prefix-refund';
import {
  BUZZ_CALL_TIMEOUT_MS,
  LEG_RETRY_BACKOFF_MINUTES,
  MAX_LEG_ATTEMPTS,
} from '~/server/services/placement-escrow.service';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  SERVICE_DEAL_HOLD_RECONCILE_AFTER_MS,
  SERVICE_DEAL_HOLD_RECONCILE_LOOKBACK_MS,
  serviceDealTransactionId,
} from '~/shared/constants/creator-services.constants';
import type { ServiceBuzzType, ServiceDealLeg } from '~/shared/utils/prisma/enums';

/**
 * Creator Services escrow: buyer -> account 0 on hold, account 0 -> buyer on refund (and, in P3,
 * account 0 -> seller on release). The only module that moves Buzz for a deal.
 *
 * Modelled on `placement-escrow.service.ts`, with one structural difference: a leg is CLAIMED in
 * the same transaction as the deal's status change, by a single SQL statement whose WHERE clause
 * is the deal state the leg needs. So the claim cannot exist unless the deal was in that state,
 * and the Buzz call, made after commit, pays only what the ledger already records.
 *
 * Every statement is raw SQL so the behaviour tests run it against the real migration.
 */

const ESCROW_ACCOUNT_ID = 0;

/** An interval from milliseconds, bound as int4 (a bare JS number binds as int8). */
const ms = (value: number) => Prisma.sql`(${value}::int * interval '1 millisecond')`;

const BUZZ_CALL_OPTIONS = { timeoutMs: BUZZ_CALL_TIMEOUT_MS, shouldRetry: isSafeToRetry };
/** Reads made while holding a leg's auto-renewing lock must end, or the lock never does. */
const BUZZ_READ_OPTIONS = { timeoutMs: BUZZ_CALL_TIMEOUT_MS };

/** Marks a hold the Buzz service refused outright, so reconcile never looks it up. */
const REFUSED_PREFIX = 'refused:';

type Db = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

type LegRow = {
  id: number;
  dealId: number;
  leg: ServiceDealLeg;
  externalTransactionId: string;
  transactionId: string | null;
  amount: number;
  buzzType: ServiceBuzzType;
  attempts: number;
};

export const holdPrefix = (dealId: number) => serviceDealTransactionId(dealId, 'hold');

const ledgerEntry = (dealId: number, description: string) => ({
  description,
  details: { entityType: 'ServiceDeal', entityId: dealId },
});

/**
 * Claims the Hold leg for a deal created in the same transaction. Its amount is the deal's own
 * price, read in the statement, never passed in.
 */
export async function claimHold(tx: Db, dealId: number) {
  const claimed = await tx.$executeRaw`
    INSERT INTO "ServiceDealTransaction" ("dealId", "leg", "externalTransactionId", "amount", "buzzType")
    SELECT d."id", 'Hold'::"ServiceDealLeg", ${holdPrefix(dealId)}::text, d."price", d."buzzType"
    FROM "ServiceDeal" d
    WHERE d."id" = ${dealId}::int AND d."status" = 'Requested'::"ServiceDealStatus"
    ON CONFLICT ("dealId", "leg") DO NOTHING`;
  return claimed > 0;
}

/**
 * Claims the Refund leg, only for a closed-with-refund deal whose hold is CONFIRMED: `heldAt` set
 * and a receipted Hold row, whose amount is what is refunded. A deal still confirming payment
 * claims nothing; reconcile claims it once the hold is found.
 *
 * `ON CONFLICT` names only (dealId, leg): a repeat claim of the same leg is absorbed, while a
 * Release already holding the deal's payout slot raises a unique violation on
 * `ServiceDealTransaction_dealId_payout_key` instead of being mistaken for "already claimed".
 */
export async function claimRefund(tx: Db, dealId: number) {
  const claimed = await tx.$executeRaw`
    INSERT INTO "ServiceDealTransaction" ("dealId", "leg", "externalTransactionId", "amount", "buzzType")
    SELECT d."id", 'Refund'::"ServiceDealLeg", ${serviceDealTransactionId(
      dealId,
      'refund'
    )}::text, h."amount", d."buzzType"
    FROM "ServiceDeal" d
    JOIN "ServiceDealTransaction" h
      ON h."dealId" = d."id" AND h."leg" = 'Hold'::"ServiceDealLeg" AND h."transactionId" IS NOT NULL
    WHERE d."id" = ${dealId}::int
      AND d."heldAt" IS NOT NULL
      AND d."status" IN ('Declined'::"ServiceDealStatus", 'Expired'::"ServiceDealStatus", 'Cancelled'::"ServiceDealStatus")
    ON CONFLICT ("dealId", "leg") DO NOTHING`;
  return claimed > 0;
}

async function readLeg(db: Db, dealId: number, leg: ServiceDealLeg) {
  const [row] = await db.$queryRaw<LegRow[]>`
    SELECT "id", "dealId", "leg", "externalTransactionId", "transactionId", "amount", "buzzType",
           "attempts"
    FROM "ServiceDealTransaction"
    WHERE "dealId" = ${dealId}::int AND "leg" = ${leg}::"ServiceDealLeg"`;
  return row;
}

/**
 * Pays one claimed leg exactly once, across retries, races and crashes: a per-leg lock serialises
 * the payment, the claimed row decides the amount, the receipt is written after the money moves,
 * and `onPaid` runs in the same transaction as the receipt.
 *
 * Returns null when nothing was paid this call: no claim, the lock not acquired, the retry
 * ceiling reached, or still inside the backoff. Throws when the Buzz call failed.
 */
export async function runDealLeg(
  dealId: number,
  leg: ServiceDealLeg,
  pay: (row: LegRow) => Promise<string>,
  onPaid: (tx: Db) => Promise<unknown>
) {
  const before = await readLeg(dbWrite, dealId, leg);
  if (!before) return null;
  if (before.transactionId) return before.transactionId;

  return withDistributedLock(
    { key: `creator-service-deal:${dealId}:${leg}`, autoRenew: true },
    async () => {
      const claimed = await readLeg(dbWrite, dealId, leg);
      if (!claimed) return null;
      if (claimed.transactionId) return claimed.transactionId;

      // The ceiling and the backoff are the UPDATE's own preconditions, compared against the
      // database clock, so a JS clock or a session time zone cannot let a retry through early.
      const [attempt] = await dbWrite.$queryRaw<{ attempts: number }[]>`
        UPDATE "ServiceDealTransaction"
        SET "attempts" = "attempts" + 1, "lastAttemptAt" = now()
        WHERE "id" = ${claimed.id}::int AND "transactionId" IS NULL
          AND "attempts" < ${MAX_LEG_ATTEMPTS}::int
          AND ("lastAttemptAt" IS NULL
            OR "lastAttemptAt" <= now() - (${LEG_RETRY_BACKOFF_MINUTES}::int * interval '1 minute'))
        RETURNING "attempts"`;
      if (!attempt) return null;
      const { attempts } = attempt;

      if (attempts >= MAX_LEG_ATTEMPTS)
        logToAxiom({
          name: 'creator-service-escrow',
          type: 'error',
          message: 'deal leg exhausted its retries and needs a human',
          dealId,
          leg,
          amount: claimed.amount,
        }).catch(() => null);

      let transactionId: string;
      try {
        transactionId = await pay(claimed);
      } catch (error) {
        const status = getBuzzApiStatus(error);
        const message = String((error as Error)?.message ?? error).slice(0, 450);
        const lastError = isDecline(status) ? `${REFUSED_PREFIX}${status} ${message}` : message;
        await dbWrite.$executeRaw`
          UPDATE "ServiceDealTransaction" SET "lastError" = ${lastError}::text
          WHERE "id" = ${claimed.id}::int`;
        throw error;
      }

      await dbWrite.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "ServiceDealTransaction"
          SET "transactionId" = ${transactionId}::text, "lastError" = NULL
          WHERE "id" = ${claimed.id}::int AND "transactionId" IS NULL`;
        await onPaid(tx);
      });

      return transactionId;
    }
  );
}

/**
 * A ledger 4xx that created nothing. 408 may have landed and 409 means the id is taken, so both
 * are outcome-unknown, as `shop-purchase-charge.ts` treats them.
 */
export const isDecline = (status: number | undefined) =>
  status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409;

async function markHeld(tx: Db, dealId: number) {
  const marked = await tx.$executeRaw`
    UPDATE "ServiceDeal" SET "heldAt" = now(), "updatedAt" = now()
    WHERE "id" = ${dealId}::int AND "heldAt" IS NULL`;
  if (marked > 0)
    await tx.$executeRaw`
      INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type")
      VALUES (${dealId}::int, -1, 'Held'::"ServiceDealEventType")`;
}

async function markSettled(tx: Db, dealId: number, event: 'Refunded' | 'Released') {
  const marked = await tx.$executeRaw`
    UPDATE "ServiceDeal" SET "settledAt" = now(), "updatedAt" = now()
    WHERE "id" = ${dealId}::int AND "settledAt" IS NULL`;
  if (marked > 0)
    await tx.$executeRaw`
      INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type")
      VALUES (${dealId}::int, -1, ${event}::"ServiceDealEventType")`;
}

export type HoldOutcome = 'held' | 'refused' | 'unknown';

class HoldOutcomeUnknown extends Error {}

/**
 * Takes the buyer's Buzz into escrow, once, synchronously, at request time. Never retried later:
 * charging a buyer after they were told the request failed is a charge they did not agree to.
 * An unknown outcome is settled by `reconcileUnconfirmedHolds` looking the charge up instead.
 */
export async function holdDeal({
  dealId,
  buyerId,
  buzzType,
}: {
  dealId: number;
  buyerId: number;
  buzzType: ServiceBuzzType;
}): Promise<HoldOutcome> {
  try {
    const paid = await runDealLeg(
      dealId,
      'Hold',
      async (row) => {
        const result = await createMultiAccountBuzzTransaction(
          {
            amount: row.amount,
            fromAccountId: buyerId,
            fromAccountTypes: [buzzType],
            toAccountId: ESCROW_ACCOUNT_ID,
            toAccountType: buzzType,
            type: TransactionType.ServiceEscrow,
            externalTransactionIdPrefix: row.externalTransactionId,
            ...ledgerEntry(dealId, 'Creator service: held in escrow'),
          },
          BUZZ_CALL_OPTIONS
        );
        // A duplicate leg is an earlier charge under this id, which this request did not make and
        // cannot vouch for; nothing here should mark the deal paid on its strength.
        if (
          result.transactionCount === 0 ||
          result.transactionIds.some((leg) => leg.duplicate === true)
        )
          throw new HoldOutcomeUnknown(`hold for deal ${dealId} did not report a fresh charge`);
        return row.externalTransactionId;
      },
      (tx) => markHeld(tx, dealId)
    );
    return paid ? 'held' : 'unknown';
  } catch (error) {
    if (isDecline(getBuzzApiStatus(error))) return 'refused';
    logToAxiom({
      name: 'creator-service-escrow',
      type: 'warning',
      message: 'hold outcome unknown; reconcile will settle it',
      dealId,
      error: (error as Error)?.message,
    }).catch(() => null);
    return 'unknown';
  }
}

/**
 * Why the hold is not fully refunded, or null when it is. The reversed legs must also add up to
 * what was held, so a listing that came back short cannot settle the deal.
 */
async function holdRefundShortfall(dealId: number, heldAmount: number) {
  const { reversed, missing } = await getPrefixRefundState(holdPrefix(dealId), BUZZ_READ_OPTIONS);
  if (missing.length)
    return `unrefunded legs ${missing.map((leg) => leg.transactionId).join(', ')}`;
  const listed = reversed.reduce((sum, leg) => sum + leg.amount, 0);
  if (listed !== heldAmount) return `ledger lists ${listed} of ${heldAmount}`;
  return null;
}

/**
 * Claims (if needed) and pays the refund. Returns false while the hold is unconfirmed or the leg
 * is backing off; `sweepServiceDealRefunds` drives it again.
 */
export async function refundDeal(dealId: number) {
  await claimRefund(dbWrite, dealId);
  const paid = await runDealLeg(
    dealId,
    'Refund',
    async (row) => {
      let result;
      try {
        result = await refundMultiAccountTransaction(
          {
            externalTransactionIdPrefix: holdPrefix(dealId),
            ...ledgerEntry(dealId, 'Creator service: refunded from escrow'),
          },
          BUZZ_CALL_OPTIONS
        );
      } catch (error) {
        // A 409 means at least one leg under the prefix already has a refund, not all of them,
        // and reverses none of the rest. Its body is not a contract, so the ledger decides. 404
        // stays a failure: this hold is confirmed, so "nothing to refund" is for a human.
        if (getBuzzApiStatus(error) === 409) {
          const shortfall = await holdRefundShortfall(dealId, row.amount);
          if (!shortfall) return `${holdPrefix(dealId)}:already-refunded`;
          // Paying the missing legs one by one waits on the Buzz owners confirming that a
          // single-leg refund is safe to repeat. Until then the deal stays refund-pending and
          // exhausts onto the gauge for a human.
          logToAxiom({
            name: 'creator-service-escrow',
            type: 'error',
            message: 'refund answered 409 with the hold not fully refunded',
            dealId,
            shortfall,
          }).catch(() => null);
          throw new Error(
            `creator service escrow: deal ${dealId} is not fully refunded: ${shortfall}`
          );
        }
        throw error;
      }
      // A refund that moved nothing must not be receipted, or both recovery queries skip it and
      // the buyer's Buzz sits in escrow with nothing able to find it.
      if (!result.refundedTransactions.length)
        throw new Error(`creator service escrow: refund moved nothing for deal ${dealId}`);
      return result.externalTransactionIdPrefix ?? serviceDealTransactionId(dealId, 'refund');
    },
    (tx) => markSettled(tx, dealId, 'Refunded')
  );
  return paid !== null;
}

type UnconfirmedHold = {
  dealId: number;
  buyerId: number;
  amount: number;
  status: string;
  externalTransactionId: string;
};

/**
 * Holds whose outcome is unknown, looked up by their external id once any in-flight write has
 * finished. Found: receipt it and mark the deal held, which also lets a deal that already closed
 * be refunded. Not found and the deal still waiting: cancel it. Not found and the deal closed:
 * keep watching for the lookback window, so a charge that lands late is still returned.
 */
export async function reconcileUnconfirmedHolds({ limit = 100 }: { limit?: number } = {}) {
  const due = await dbWrite.$queryRaw<UnconfirmedHold[]>`
    SELECT t."dealId", d."buyerId", t."amount", d."status"::text AS "status", t."externalTransactionId"
    FROM "ServiceDealTransaction" t
    JOIN "ServiceDeal" d ON d."id" = t."dealId"
    WHERE t."leg" = 'Hold'::"ServiceDealLeg"
      AND t."transactionId" IS NULL
      AND (t."lastError" IS NULL OR t."lastError" NOT LIKE ${`${REFUSED_PREFIX}%`}::text)
      AND t."createdAt" <= now() - ${ms(SERVICE_DEAL_HOLD_RECONCILE_AFTER_MS)}
      AND t."createdAt" >= now() - ${ms(SERVICE_DEAL_HOLD_RECONCILE_LOOKBACK_MS)}
    -- Least recently checked first, so holds that keep finding nothing for their 7 days cannot
    -- hold every slot of the batch while one whose charge has landed waits behind them.
    ORDER BY t."lastAttemptAt" ASC NULLS FIRST, t."createdAt"
    LIMIT ${limit}::int`;

  let held = 0;
  let cancelled = 0;
  for (const hold of due) {
    try {
      await dbWrite.$executeRaw`
        UPDATE "ServiceDealTransaction" SET "lastAttemptAt" = now()
        WHERE "dealId" = ${hold.dealId}::int AND "leg" = 'Hold'::"ServiceDealLeg"`;
      const legs = await getMultiAccountTransactionsByPrefix(hold.externalTransactionId);
      const charged = legs
        .filter((leg) => leg.accountId === hold.buyerId)
        .reduce((sum, leg) => sum + leg.amount, 0);

      if (charged >= hold.amount) {
        await dbWrite.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE "ServiceDealTransaction"
            SET "transactionId" = ${hold.externalTransactionId}::text, "lastError" = NULL
            WHERE "dealId" = ${hold.dealId}::int AND "leg" = 'Hold'::"ServiceDealLeg"
              AND "transactionId" IS NULL`;
          await markHeld(tx, hold.dealId);
        });
        held++;
        if (hold.status !== 'Requested') await refundDeal(hold.dealId);
      } else if (charged === 0) {
        if (hold.status === 'Requested') {
          const closed = await dbWrite.$transaction(async (tx) => {
            const updated = await tx.$executeRaw`
              UPDATE "ServiceDeal"
              SET "status" = 'Cancelled'::"ServiceDealStatus", "closedAt" = now(),
                  "closeReason" = 'payment_failed', "updatedAt" = now()
              WHERE "id" = ${hold.dealId}::int AND "status" = 'Requested'::"ServiceDealStatus"
                AND "heldAt" IS NULL`;
            if (updated > 0)
              await tx.$executeRaw`
                INSERT INTO "ServiceDealEvent" ("dealId", "actorId", "type", "comment")
                VALUES (${hold.dealId}::int, -1, 'Cancelled'::"ServiceDealEventType", 'payment_failed')`;
            return updated;
          });
          cancelled += closed;
        }
      } else {
        // Part of the price moved. Neither marking it held nor cancelling is safe.
        logToAxiom({
          name: 'creator-service-escrow',
          type: 'error',
          message: 'hold partially charged; needs a human',
          dealId: hold.dealId,
          charged,
          amount: hold.amount,
        }).catch(() => null);
      }
    } catch (error) {
      logToAxiom({
        name: 'creator-service-escrow',
        type: 'error',
        message: 'hold reconcile failed',
        dealId: hold.dealId,
        error: (error as Error)?.message,
      }).catch(() => null);
    }
  }

  const [{ count }] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS "count" FROM "ServiceDeal"
    WHERE "status" = 'Requested'::"ServiceDealStatus" AND "heldAt" IS NULL
      AND "requestedAt" <= now() - ${ms(SERVICE_DEAL_HOLD_RECONCILE_AFTER_MS)}`;
  serviceDealUnconfirmedHoldsGauge.set(count);

  return { considered: due.length, held, cancelled };
}

/**
 * Closed deals whose confirmed hold has not been returned yet: never claimed (a crash after the
 * status change), or claimed and unpaid. Exhausted legs are left out so they cannot crowd the
 * batch; the gauge reports them instead.
 */
export async function sweepServiceDealRefunds({ limit = 100 }: { limit?: number } = {}) {
  const due = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT d."id" FROM "ServiceDeal" d
    WHERE d."status" IN ('Declined'::"ServiceDealStatus", 'Expired'::"ServiceDealStatus", 'Cancelled'::"ServiceDealStatus")
      AND d."heldAt" IS NOT NULL AND d."settledAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "ServiceDealTransaction" t
        WHERE t."dealId" = d."id" AND t."leg" = 'Refund'::"ServiceDealLeg"
          AND t."transactionId" IS NULL AND t."attempts" >= ${MAX_LEG_ATTEMPTS}::int
      )
    ORDER BY d."closedAt"
    LIMIT ${limit}::int`;

  let refunded = 0;
  for (const { id } of due) {
    try {
      if (await refundDeal(id)) refunded++;
    } catch (error) {
      logToAxiom({
        name: 'creator-service-escrow',
        type: 'error',
        message: 'refund could not be completed',
        dealId: id,
        error: (error as Error)?.message,
      }).catch(() => null);
    }
  }

  const [{ count }] = await dbWrite.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS "count" FROM "ServiceDealTransaction"
    WHERE "leg" <> 'Hold'::"ServiceDealLeg" AND "transactionId" IS NULL
      AND "attempts" >= ${MAX_LEG_ATTEMPTS}::int`;
  serviceDealExhaustedLegsGauge.set(count);

  return { considered: due.length, refunded, exhausted: count };
}
