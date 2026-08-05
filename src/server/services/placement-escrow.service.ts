import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { PLACEMENT_SPEND_TYPES } from '~/shared/constants/placement.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type {
  PlacementRemovedBy,
  PlacementSurface,
  PlacementTransactionKind,
} from '~/shared/utils/placement';
import {
  declineFeeAmount,
  placementOutcomeFromStatus,
  placementTransactionId,
  splitPlacementPayment,
} from '~/shared/utils/placement';

/** Where held Buzz sits between placement and settlement. */
const ESCROW_ACCOUNT_ID = 0;

type SettleAction = 'approve' | 'decline' | 'expire' | 'removeByOwner' | 'removeByModerator';

const STATUS_FOR_ACTION: Record<SettleAction, 'approved' | 'declined' | 'expired' | 'removed'> = {
  approve: 'approved',
  decline: 'declined',
  expire: 'expired',
  removeByOwner: 'removed',
  removeByModerator: 'removed',
};

const REMOVED_BY_FOR_ACTION: Partial<Record<SettleAction, PlacementRemovedBy>> = {
  removeByOwner: 'owner',
  removeByModerator: 'moderator',
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Runs one movement of money exactly once, across retries and crashes.
 *
 * The ledger row is written **before** the money moves, with a null
 * `transactionId`, and filled in after. That ordering is deliberate: a crash
 * between the two leaves a claimed-but-unpaid leg, which `sweepUnpaidLegs` can
 * see and finish. The reverse ordering leaves money moved with no receipt, which
 * is indistinguishable from money never moved.
 *
 * The unique constraint on `(placementId, kind)` is what makes the claim a lock —
 * a second caller's insert raises rather than paying. A unique index on a column
 * of `Placement` could not do this: "no two rows share an id" is a different
 * proposition from "this row's money moved once".
 */
async function runLeg(
  placementId: number,
  kind: PlacementTransactionKind,
  amount: number,
  pay: (externalTransactionId: string) => Promise<string | null>
) {
  if (amount <= 0) return null;

  try {
    await dbWrite.placementTransaction.create({ data: { placementId, kind, amount } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await dbWrite.placementTransaction.findUnique({
      where: { placementId_kind: { placementId, kind } },
    });
    // Already paid. Anything else is a claim whose payment never landed, so it
    // falls through and is retried — the external id is derived from the row, so
    // the Buzz service dedupes a payment that did land after all.
    if (existing?.transactionId) return existing.transactionId;
  }

  const transactionId = await pay(placementTransactionId(placementId, kind));

  await dbWrite.placementTransaction.update({
    where: { placementId_kind: { placementId, kind } },
    data: { transactionId },
  });

  return transactionId;
}

/**
 * Takes the escrow as two holds — the decline fee and the principal — so every
 * later release is a whole-hold operation and the placer's money can always
 * return through a real refund, in the currency mix it was drawn from.
 *
 * Paid Buzz only. This refuses on the mutation rather than relying on a listing
 * or a picker to filter: a listing that filters is not a mutation that refuses.
 */
export async function holdPlacementEscrow({
  placementId,
  placerId,
  surface,
  amount,
}: {
  placementId: number;
  placerId: number;
  surface: PlacementSurface;
  amount: number;
}) {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new Error(`placement escrow: amount must be a non-negative integer, got ${amount}`);
  if (amount === 0) return { fee: 0, principal: 0 };

  const config = await getPlacementConfig();
  const fee = declineFeeAmount(amount, config.declineFeeRate(surface));
  const principal = amount - fee;

  const hold = (kind: PlacementTransactionKind, holdAmount: number) =>
    runLeg(placementId, kind, holdAmount, async (externalTransactionIdPrefix) => {
      const result = await createMultiAccountBuzzTransaction({
        amount: holdAmount,
        fromAccountId: placerId,
        toAccountId: ESCROW_ACCOUNT_ID,
        type: TransactionType.Fee,
        // Yellow and Green only. Blue is non-transferable by design, and a
        // placement that took it and paid it out would be a laundering channel.
        fromAccountTypes: PLACEMENT_SPEND_TYPES,
        description: `Placement escrow (${kind}) for placement ${placementId}`,
        externalTransactionIdPrefix,
      });

      if (result.transactionCount === 0)
        throw new Error(
          `placement escrow: ${kind} hold moved nothing for placement ${placementId}`
        );

      return externalTransactionIdPrefix;
    });

  await hold('holdFee', fee);
  await hold('holdPrincipal', principal);

  return { fee, principal };
}

/**
 * Flips a pending placement to its settled status and pays out, once.
 *
 * The claim is the status transition itself — `WHERE status = 'pending'` on the
 * primary — so two callers racing (a block landing during an approval, the
 * expiry sweep firing during a decline) cannot both settle: the loser matches no
 * rows and moves no money. The winner's per-leg receipts then make the payout
 * itself resumable, which the claim alone cannot do.
 */
export async function settlePlacement({
  placementId,
  action,
  actorId,
  sellerId,
}: {
  placementId: number;
  action: SettleAction;
  actorId?: number;
  sellerId?: number;
}) {
  const status = STATUS_FOR_ACTION[action];
  const removedBy = REMOVED_BY_FOR_ACTION[action] ?? null;

  const { count } = await dbWrite.placement.updateMany({
    where: { id: placementId, status: 'pending' },
    data: { status, removedBy, resolvedAt: new Date(), resolvedById: actorId ?? null },
  });

  const placement = await dbWrite.placement.findUnique({ where: { id: placementId } });
  if (!placement) throw new Error(`placement escrow: placement ${placementId} not found`);

  // Someone else settled it. Not an error — a double-submitted approve and a
  // retried webhook both land here — but this call moves no money.
  if (count === 0 && placement.status !== status) return { settled: false, placement };

  await payOutPlacement({ placement, sellerId });

  return { settled: count > 0, placement };
}

type PlacementRow = Awaited<ReturnType<typeof dbWrite.placement.findUnique>>;

/**
 * Idempotent by construction, so it is safe to call on a placement that was
 * already settled but whose payout did not finish.
 */
async function payOutPlacement({
  placement,
  sellerId,
}: {
  placement: NonNullable<PlacementRow>;
  sellerId?: number;
}) {
  const surface = placement.surface as PlacementSurface;
  const config = await getPlacementConfig();
  const outcome = placementOutcomeFromStatus(
    placement.status as never,
    placement.removedBy as PlacementRemovedBy | null
  );
  const shares = config.approvalShares(surface);
  const split = splitPlacementPayment({
    amount: placement.amount,
    outcome,
    declineFeeRate: config.declineFeeRate(surface),
    sellerShare: shares.seller,
    platformShare: shares.platform,
  });

  const payFromEscrow = (kind: PlacementTransactionKind, toAccountId: number, amount: number) =>
    runLeg(placement.id, kind, amount, async (externalTransactionId) => {
      const { transactionId } = await createBuzzTransaction({
        amount,
        fromAccountId: ESCROW_ACCOUNT_ID,
        toAccountId,
        type: TransactionType.Fee,
        description: `Placement ${placement.id} (${kind})`,
        externalTransactionId,
      });

      return transactionId;
    });

  const heldAmounts = await heldAmountsFor(placement.id);

  // A whole hold returning to the placer. This is the reason the escrow is taken
  // as two holds: the Buzz service restores the exact account-type mix it drew
  // from, so nothing here has to reconstruct it.
  const refundHold = (kind: PlacementTransactionKind, holdKind: PlacementTransactionKind) =>
    runLeg(placement.id, kind, heldAmounts.get(holdKind) ?? 0, async () => {
      const result = await refundMultiAccountTransaction({
        externalTransactionIdPrefix: placementTransactionId(placement.id, holdKind),
        description: `Placement ${placement.id} refund (${holdKind})`,
      });

      return result.externalTransactionIdPrefix;
    });

  switch (outcome) {
    case 'approved':
      await payFromEscrow('toOwner', placement.ownerId, split.toOwner);
      if (sellerId) await payFromEscrow('toSeller', sellerId, split.toSeller);
      await recordPlatformKeep(placement.id, split.toPlatform + (sellerId ? 0 : split.toSeller));
      return;
    case 'declined':
      await payFromEscrow('feeToOwner', placement.ownerId, split.toOwner);
      await refundHold('principalToPlacer', 'holdPrincipal');
      return;
    case 'expired':
    case 'removedByOwner':
      await refundHold('principalToPlacer', 'holdPrincipal');
      await refundHold('feeToPlacer', 'holdFee');
      return;
    // Nothing moves: the funds stay in the escrow account. The ledger row is the
    // receipt that this was decided rather than dropped.
    case 'removedByModerator':
      await recordPlatformKeep(placement.id, placement.amount);
      return;
  }
}

const heldAmountsFor = async (placementId: number) => {
  const rows = await dbWrite.placementTransaction.findMany({
    where: { placementId, kind: { in: ['holdFee', 'holdPrincipal'] } },
    select: { kind: true, amount: true },
  });

  return new Map(rows.map((row) => [row.kind, row.amount]));
};

/** Buzz that stays with the platform still gets a receipt, so the ledger balances. */
const recordPlatformKeep = (placementId: number, amount: number) =>
  runLeg(placementId, 'forfeit', amount, async () => null);

/**
 * Pending placements the owner never answered. An owner who did not respond has
 * not done the work the decline fee pays for, so both holds return in full.
 *
 * Claims before it pays, and in a bounded batch: a backlog must not turn one run
 * into an unbounded one.
 */
export async function expirePlacements({ limit = 100 }: { limit?: number } = {}) {
  const due = await dbWrite.placement.findMany({
    where: { status: 'pending', expiresAt: { lte: new Date() } },
    select: { id: true },
    take: limit,
  });

  let expired = 0;
  for (const { id } of due) {
    try {
      const result = await settlePlacement({ placementId: id, action: 'expire' });
      if (result.settled) expired++;
    } catch (error) {
      logToAxiom({
        name: 'placement-escrow',
        type: 'error',
        message: 'expiry failed',
        placementId: id,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { considered: due.length, expired };
}

/**
 * Legs that were claimed but whose payment never landed — a crash between the
 * ledger write and the Buzz call, or a Buzz call that failed after the status
 * had already moved.
 *
 * This is the half a status column cannot express: the placement reads settled
 * and somebody is still owed. Without this sweep the only evidence is a null
 * column nothing looks at.
 */
export async function sweepUnpaidLegs({
  limit = 100,
  olderThanMinutes = 10,
}: { limit?: number; olderThanMinutes?: number } = {}) {
  const before = new Date(Date.now() - olderThanMinutes * 60_000);
  const stranded = await dbWrite.placementTransaction.findMany({
    where: { transactionId: null, createdAt: { lt: before }, kind: { not: 'forfeit' } },
    select: { placementId: true },
    distinct: ['placementId'],
    take: limit,
  });

  let resumed = 0;
  for (const { placementId } of stranded) {
    const placement = await dbWrite.placement.findUnique({ where: { id: placementId } });
    if (!placement || placement.status === 'pending') continue;

    try {
      await payOutPlacement({ placement });
      resumed++;
    } catch (error) {
      logToAxiom({
        name: 'placement-escrow',
        type: 'error',
        message: 'unpaid leg could not be resumed',
        placementId,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { stranded: stranded.length, resumed };
}
