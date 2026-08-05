import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
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

/**
 * Receipt for a leg where nothing leaves the escrow account. Without it the row
 * is created null and updated null, so "claimed" and "paid" stay
 * indistinguishable for exactly the kinds that can never be audited by their
 * transaction id.
 */
const PLATFORM_KEEP_RECEIPT = 'platform-keep';

/**
 * After this many failed attempts a leg stops being retried and starts being
 * reported.
 *
 * The recurring defect in this feature has been a row the recovery sweep can
 * find and can never finish: it consumes a slot in every bounded batch, and
 * enough of them starve the mechanism that recovers from an outage — while the
 * sweep reports healthy numbers, because the counter measures work attempted
 * rather than work landed. Three separate instances were fixed by narrowing a
 * query; this is the general answer, so the fourth is a page rather than a
 * silence.
 *
 * The cost, stated plainly: a leg that exhausts its attempts is **not paid**,
 * and its share stays in the escrow account until a human acts. That is the
 * deliberate trade — money parked and reported beats money parked and silent —
 * but it means the ceiling must not be reachable by an outage that would have
 * cleared on its own, which is what the backoff below is for.
 */
export const MAX_LEG_ATTEMPTS = 5;

/**
 * Minimum gap between attempts on the same leg.
 *
 * Without it the ceiling is a function of how often the sweep runs rather than
 * of how long the failure lasted: a ten-minute cron would burn all five attempts
 * inside an hour, so a transient Buzz outage would permanently strand a leg that
 * only needed waiting out.
 */
export const LEG_RETRY_BACKOFF_MINUTES = 30;

const HOLD_KINDS = ['holdFee', 'holdPrincipal'] as const;
const PAYOUT_KINDS = [
  'toOwner',
  'toSeller',
  'toPlatform',
  'feeToOwner',
  'principalToPlacer',
  'feeToPlacer',
  'forfeit',
] as const;

type SettleAction =
  | 'approve'
  | 'decline'
  /**
   * A block declines every pending placement from that user at once. The fee is
   * the price of the owner's *attention* to a submission, and a block is the
   * owner refusing to give attention to anyone — so no fee is taken.
   *
   * It also closes a farming vector the spec's toll-booth reasoning missed:
   * accepting submissions at a high price and then blocking everyone is one
   * action that collects N fees, and the "declined users will say so publicly"
   * mitigation inverts when the blocked can no longer see or contact the blocker.
   *
   * ⚠️ Provisional pending Justin. Waiving is the reversible direction: adding a
   * fee later is additive, refunding one taken wrongly is not.
   */
  | 'declineByBlock'
  | 'expire'
  | 'removeByOwner'
  | 'removeByModerator';

const STATUS_FOR_ACTION: Record<SettleAction, 'approved' | 'declined' | 'expired' | 'removed'> = {
  approve: 'approved',
  decline: 'declined',
  declineByBlock: 'declined',
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
 * Runs one movement of money exactly once, across retries, races and crashes.
 *
 * Three things cooperate, and each covers a window the others don't:
 *
 * 1. The **lock** serialises the payment. The unique constraint below only
 *    serialises the *claim* — two concurrent callers can both find a claimed
 *    row with no receipt yet and both reach the Buzz call, which would leave the
 *    remote's deduplication as the only thing preventing a double payment.
 * 2. The **unique constraint** on `(placementId, kind)` makes the claim itself
 *    atomic, so a leg cannot be planned twice.
 * 3. The **receipt ordering** — claim first with a null `transactionId`, fill it
 *    in after the money moves — means a crash between the two leaves a
 *    claimed-but-unpaid leg that `sweepUnpaidLegs` can finish. The reverse
 *    ordering leaves money moved with no receipt, indistinguishable from money
 *    never moved.
 *
 * The external id is derived from the row, so the Buzz service's own dedupe
 * backs all of this rather than being asked to carry it.
 */
async function runLeg(
  placementId: number,
  kind: PlacementTransactionKind,
  amount: number,
  pay: (externalTransactionId: string, amount: number) => Promise<string | null>
) {
  if (amount <= 0) return null;

  // The claim is taken OUTSIDE the lock, deliberately. `withDistributedLock`
  // returns null without running when Redis is unavailable or the key is
  // contended — so a claim inside it would leave no row at all, the placement
  // would read settled with nobody paid, and `sweepUnpaidLegs` would have
  // nothing to find. Claiming first means the worst case is always a
  // receipt-less row, which is exactly what the sweeper is for.
  try {
    await dbWrite.placementTransaction.create({ data: { placementId, kind, amount } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const existing = await dbWrite.placementTransaction.findUnique({
    where: { placementId_kind: { placementId, kind } },
  });
  if (existing?.transactionId) return existing.transactionId;

  return withDistributedLock(
    { key: `placement:${placementId}:${kind}`, autoRenew: true },
    async () => {
      // Re-read inside the lock: a holder that finished between the check above
      // and the acquisition has already paid this leg.
      const claimed = await dbWrite.placementTransaction.findUnique({
        where: { placementId_kind: { placementId, kind } },
      });
      if (claimed?.transactionId) return claimed.transactionId;

      // The winning claim decides the amount, not this caller's copy of it. Two
      // callers can compute different numbers — they read live config at
      // slightly different moments — and whoever lost the insert would otherwise
      // move an amount the ledger does not record.
      // The ceiling is enforced here, not only in the sweep query. The sweep
      // selects placements and then re-runs the whole payout, so filtering there
      // would skip *choosing* an exhausted leg and still retry it — a list
      // operation where a refusal is needed.
      if ((claimed?.attempts ?? 0) >= MAX_LEG_ATTEMPTS) return null;

      // Backoff belongs here for the same reason as the ceiling: the sweep picks
      // *placements* and `payOutPlacement` then re-runs every leg, so a leg that
      // failed moments ago would be retried immediately on the back of some other
      // eligible leg on the same placement.
      if (
        claimed?.lastAttemptAt &&
        claimed.lastAttemptAt > new Date(Date.now() - LEG_RETRY_BACKOFF_MINUTES * 60_000)
      )
        return null;

      await dbWrite.placementTransaction.update({
        where: { placementId_kind: { placementId, kind } },
        data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
      });

      let transactionId: string | null;
      try {
        transactionId = await pay(
          placementTransactionId(placementId, kind),
          claimed?.amount ?? amount
        );
      } catch (error) {
        // Recorded before rethrowing, so a leg that keeps failing says why on the
        // row rather than only in a log nobody correlates.
        await dbWrite.placementTransaction.update({
          where: { placementId_kind: { placementId, kind } },
          data: { lastError: String((error as Error).message ?? error).slice(0, 500) },
        });
        throw error;
      }

      await dbWrite.placementTransaction.update({
        where: { placementId_kind: { placementId, kind } },
        data: { transactionId, lastError: null },
      });

      return transactionId;
    }
  );
  // A null result means the lock was not acquired — another caller is mid-payment,
  // or Redis is down. Either way the claim row is on disk with no receipt, so the
  // sweeper finishes it rather than the money being silently skipped.
}

/**
 * Takes the escrow as two holds — the decline fee and the principal — so every
 * later release is a whole-hold operation and the placer's money can always
 * return through a real refund, in the currency mix it was drawn from.
 *
 * Paid Buzz only. This refuses on the mutation rather than relying on a listing
 * or a picker to filter: a listing that filters is not a mutation that refuses.
 *
 * **Callers must create the placement row and call this in one transaction.**
 * The row must exist first — its id is a parameter here — so a caller that
 * commits it separately and then fails to take the escrow leaves a pending
 * placement backed by nothing. Nothing downstream will pay out against it (the
 * hold amounts are read receipted-only), but it is a live placement nobody paid
 * for, and only the caller can prevent it.
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

  const config = await getPlacementConfig();

  // Escrow with no deadline is money frozen indefinitely, and a null `expiresAt`
  // is never `<= now()`, so the sweep would step over it forever.
  await dbWrite.placement.updateMany({
    where: { id: placementId, expiresAt: null },
    data: { expiresAt: new Date(Date.now() + config.expiryHours(surface) * 3_600_000) },
  });

  if (amount === 0) return { fee: 0, principal: 0 };

  const fee = declineFeeAmount(amount, config.declineFeeRate(surface));
  const principal = amount - fee;

  const hold = (kind: PlacementTransactionKind, holdAmount: number) =>
    runLeg(placementId, kind, holdAmount, async (externalTransactionIdPrefix, payAmount) => {
      const result = await createMultiAccountBuzzTransaction({
        amount: payAmount,
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

  // A leg returns null when the lock was not acquired — Redis down, or contended
  // past its retries — which means nothing was charged. Reporting the amounts
  // anyway would let the caller create a placement whose escrow does not exist,
  // and approving it later would pay out of an account that never received it.
  // The hold legs cannot be swept, either: the sweeper skips pending placements,
  // and a hold only exists while a placement is pending. So it has to fail here.
  const held = {
    holdFee: await hold('holdFee', fee),
    holdPrincipal: await hold('holdPrincipal', principal),
  };

  for (const [kind, amount] of [
    ['holdFee', fee],
    ['holdPrincipal', principal],
  ] as const)
    if (amount > 0 && !held[kind])
      throw new Error(
        `placement escrow: ${kind} could not be taken for placement ${placementId} — nothing was charged`
      );

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
}: {
  placementId: number;
  action: SettleAction;
  actorId?: number;
}) {
  const status = STATUS_FOR_ACTION[action];
  const removedBy = REMOVED_BY_FOR_ACTION[action] ?? null;

  const before = await dbWrite.placement.findUnique({ where: { id: placementId } });
  if (!before) throw new Error(`placement escrow: placement ${placementId} not found`);

  const feeWaived = action === 'declineByBlock' ? true : before.feeWaived;
  const held = await heldAmountsFor(placementId);
  // Computed against the status this settle is *about to* write, since the row
  // still says `pending` and a pending placement has no settled outcome.
  const legs = await computePayoutLegs({ ...before, status, removedBy, feeWaived }, held);

  // The status flip and the payout plan go in one transaction. Two statements
  // would let a crash between them leave a placement settled — approved and live
  // — with no plan at all. Nothing recovers that state: it is not pending so
  // expiry skips it, and it has no claimed-but-unpaid leg so the sweeper skips
  // it too. Worse, a later moderator takedown would then flip it to `removed`
  // and the first thing to compute a plan would forfeit money the owner had
  // earned and never been paid.
  const { count } = await dbWrite.$transaction(async (tx) => {
    const updated = await tx.placement.updateMany({
      where: { id: placementId, status: 'pending' },
      data: {
        status,
        removedBy,
        resolvedAt: new Date(),
        resolvedById: actorId ?? null,
        ...(action === 'declineByBlock' ? { feeWaived: true } : {}),
      },
    });

    if (updated.count > 0)
      await tx.placementTransaction.createMany({
        data: legs.map((leg) => ({ placementId, ...leg })),
        skipDuplicates: true,
      });

    return updated;
  });

  const placement = await dbWrite.placement.findUnique({ where: { id: placementId } });
  if (!placement) throw new Error(`placement escrow: placement ${placementId} not found`);

  // Someone else settled it. Not an error — a double-submitted approve and a
  // retried webhook both land here — but this call moves no money of its own:
  // the payout below reads the winner's outcome off the row, not this action.
  if (count === 0 && placement.status !== status) return { settled: false, placement };

  await payOutPlacement(placement);

  return { settled: count > 0, placement };
}

type PlacementRow = NonNullable<Awaited<ReturnType<typeof dbWrite.placement.findUnique>>>;
type PlannedLeg = { kind: PlacementTransactionKind; amount: number };

/**
 * The payout plan, written to the ledger once and thereafter read back.
 *
 * **Nothing recomputes an amount at settle time.** The holds were sized by the
 * config as it stood when the placement was made, and an operator retuning the
 * decline rate or the approval shares while placements are pending would
 * otherwise produce a release that does not match what is actually held — paying
 * out more than was taken, or stranding the difference in the escrow account
 * with no ledger row to find it by. Refunds come from the hold amounts; the
 * approve split is computed once and persisted.
 */
async function planPayout(placement: PlacementRow, held: Map<string, number>) {
  const existing = await dbWrite.placementTransaction.findMany({
    where: { placementId: placement.id, kind: { in: [...PAYOUT_KINDS] } },
    select: { kind: true, amount: true },
  });
  if (existing.length) return existing as PlannedLeg[];

  // Zero-amount legs are not movements of money and must not be persisted: they
  // could never acquire a receipt (a leg with nothing to pay returns before
  // writing one), so they would sit in the sweeper's result set forever, and
  // past its batch limit they would crowd out genuinely stranded legs — starving
  // the one mechanism that recovers from an outage, while reporting success.
  const legs = await computePayoutLegs(placement, held);

  await dbWrite.placementTransaction.createMany({
    data: legs.map((leg) => ({ placementId: placement.id, ...leg })),
    skipDuplicates: true,
  });

  // Re-read rather than returning what we just computed: `skipDuplicates` means
  // a concurrent caller may have written the plan first, and its numbers are the
  // ones on disk. Trusting the local copy would pay amounts the ledger disagrees
  // with.
  return (await dbWrite.placementTransaction.findMany({
    where: { placementId: placement.id, kind: { in: [...PAYOUT_KINDS] } },
    select: { kind: true, amount: true },
  })) as PlannedLeg[];
}

async function computePayoutLegs(
  placement: PlacementRow,
  held: Map<string, number>
): Promise<PlannedLeg[]> {
  return (await payoutLegsFor(placement, held)).filter((leg) => leg.amount > 0);
}

/**
 * Zero-amount legs are filtered by the caller above, not here: a leg with
 * nothing to pay can never acquire a receipt, so persisting one leaves a row the
 * sweeper can never clear, and past its batch limit those crowd out genuinely
 * stranded legs.
 *
 * **Every field this reads must be either immutable or overridden by the
 * synthesised row in `settlePlacement`.** It runs twice against the same
 * placement — once inside the settle transaction against a row that does not
 * exist yet, and once from `planPayout` on resume — and a plan-affecting field
 * that only one of them sees would make those two disagree silently.
 */
async function payoutLegsFor(
  placement: PlacementRow,
  held: Map<string, number>
): Promise<PlannedLeg[]> {
  const fee = held.get('holdFee') ?? 0;
  const principal = held.get('holdPrincipal') ?? 0;
  const outcome = placementOutcomeFromStatus(
    placement.status as never,
    placement.removedBy as PlacementRemovedBy | null
  );

  switch (outcome) {
    case 'approved': {
      const config = await getPlacementConfig();
      const shares = config.approvalShares(placement.surface as PlacementSurface);
      const split = splitPlacementPayment({
        amount: fee + principal,
        outcome,
        declineFeeRate: config.declineFeeRate(placement.surface as PlacementSurface),
        sellerShare: shares.seller,
        platformShare: shares.platform,
      });
      // With no seller on the row there is nobody to pay, so their share stays
      // with the platform rather than being invented a recipient.
      const seller = placement.sellerId ? split.toSeller : 0;

      return [
        { kind: 'toOwner', amount: split.toOwner },
        { kind: 'toSeller', amount: seller },
        { kind: 'toPlatform', amount: split.toPlatform + (split.toSeller - seller) },
      ];
    }
    // The fee that was held is the fee that is paid. Recomputing it here is what
    // let a rate change mint the difference.
    case 'declined':
      // A waived fee returns the whole escrow, both holds, to the placer.
      return placement.feeWaived
        ? [
            { kind: 'principalToPlacer', amount: principal },
            { kind: 'feeToPlacer', amount: fee },
          ]
        : [
            { kind: 'feeToOwner', amount: fee },
            { kind: 'principalToPlacer', amount: principal },
          ];
    case 'expired':
    case 'removedByOwner':
      return [
        { kind: 'principalToPlacer', amount: principal },
        { kind: 'feeToPlacer', amount: fee },
      ];
    case 'removedByModerator':
      return [{ kind: 'forfeit', amount: fee + principal }];
  }
}

/** Idempotent by construction, so a partly-finished payout can be re-driven. */
async function payOutPlacement(placement: PlacementRow) {
  const held = await heldAmountsFor(placement.id);
  const plan = await planPayout(placement, held);

  const payFromEscrow = (kind: PlacementTransactionKind, toAccountId: number, amount: number) =>
    runLeg(placement.id, kind, amount, async (externalTransactionId, payAmount) => {
      const { transactionId } = await createBuzzTransaction({
        amount: payAmount,
        fromAccountId: ESCROW_ACCOUNT_ID,
        toAccountId,
        type: TransactionType.Fee,
        description: `Placement ${placement.id} (${kind})`,
        externalTransactionId,
      });

      return transactionId;
    });

  // A whole hold returning to the placer. This is the reason the escrow is taken
  // as two holds: the Buzz service restores the exact account-type mix it drew
  // from, so nothing here has to reconstruct it.
  const refundHold = (kind: PlacementTransactionKind, holdKind: string, amount: number) =>
    runLeg(placement.id, kind, amount, async () => {
      const result = await refundMultiAccountTransaction({
        externalTransactionIdPrefix: placementTransactionId(
          placement.id,
          holdKind as PlacementTransactionKind
        ),
        description: `Placement ${placement.id} refund (${holdKind})`,
      });

      return result.externalTransactionIdPrefix;
    });

  for (const { kind, amount } of plan) {
    switch (kind) {
      case 'toOwner':
      case 'feeToOwner':
        await payFromEscrow(kind, placement.ownerId, amount);
        break;
      case 'toSeller':
        if (placement.sellerId) await payFromEscrow(kind, placement.sellerId, amount);
        break;
      case 'principalToPlacer':
        await refundHold(kind, 'holdPrincipal', amount);
        break;
      case 'feeToPlacer':
        await refundHold(kind, 'holdFee', amount);
        break;
      // Nothing leaves the escrow account; the receipt records that it was
      // decided rather than dropped.
      case 'toPlatform':
      case 'forfeit':
        await runLeg(placement.id, kind, amount, async () => PLATFORM_KEEP_RECEIPT);
        break;
    }
  }
}

/**
 * What is actually sitting in the escrow account for this placement.
 *
 * **Receipted holds only.** A claimed-but-unpaid hold is a leg that was planned
 * and never charged — Redis down, or the process died mid-hold — and counting it
 * would size payouts against Buzz that was never taken, paying real money out of
 * an account that never received it. An unfunded placement must plan nothing.
 */
const heldAmountsFor = async (placementId: number) => {
  const rows = await dbWrite.placementTransaction.findMany({
    where: {
      placementId,
      kind: { in: [...HOLD_KINDS] },
      transactionId: { not: null },
    },
    select: { kind: true, amount: true },
  });

  return new Map(rows.map((row) => [row.kind, row.amount]));
};

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
    // Payout kinds only. Hold legs also match "claimed but unpaid", and this
    // sweep can never finish one — it skips pending placements, and after a
    // settle nothing writes a hold's receipt either. They would be permanent
    // residents, and past `take` they crowd out legs that can actually be
    // finished: the recovery path starves while reporting a healthy count.
    where: {
      kind: { in: [...PAYOUT_KINDS] },
      transactionId: null,
      amount: { gt: 0 },
      attempts: { lt: MAX_LEG_ATTEMPTS },
      createdAt: { lt: before },
      // Spread the attempts out, so the budget measures how long the failure has
      // persisted rather than how often the sweep happens to run.
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: new Date(Date.now() - LEG_RETRY_BACKOFF_MINUTES * 60_000) } },
      ],
    },
    select: { placementId: true },
    distinct: ['placementId'],
    take: limit,
  });

  // Legs past the ceiling are no longer retried, so they must be reported —
  // otherwise "stopped starving the batch" would just mean "stopped mentioning
  // it". This is the signal that something needs a human.
  const exhausted = await dbWrite.placementTransaction.count({
    where: {
      kind: { in: [...PAYOUT_KINDS] },
      transactionId: null,
      amount: { gt: 0 },
      attempts: { gte: MAX_LEG_ATTEMPTS },
    },
  });

  if (exhausted > 0)
    logToAxiom({
      name: 'placement-escrow',
      type: 'error',
      message: 'placement legs have exhausted their retries and need a human',
      exhausted,
    }).catch(() => null);

  let resumed = 0;
  for (const { placementId } of stranded) {
    const placement = await dbWrite.placement.findUnique({ where: { id: placementId } });
    if (!placement || placement.status === 'pending') continue;

    try {
      await payOutPlacement(placement);
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

  return { stranded: stranded.length, resumed, exhausted };
}

/**
 * Placements that settled but never got a payout plan.
 *
 * `sweepUnpaidLegs` finds legs that were claimed and not paid. It cannot see a
 * settlement that produced no legs at all, and nothing else can either: the row
 * is not pending, so expiry skips it. Writing the plan inside the settle
 * transaction makes this state unreachable going forward; this sweep exists for
 * rows that predate that, and as the check that it stays unreachable.
 */
export async function sweepUnplannedSettlements({
  limit = 100,
  olderThanMinutes = 10,
}: { limit?: number; olderThanMinutes?: number } = {}) {
  const before = new Date(Date.now() - olderThanMinutes * 60_000);
  const rows = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT p.id FROM "Placement" p
    WHERE p.status <> 'pending'
      AND p."resolvedAt" < ${before}
      AND NOT EXISTS (
        SELECT 1 FROM "PlacementTransaction" t
        WHERE t."placementId" = p.id AND t.kind = ANY(${[...PAYOUT_KINDS]}::text[])
      )
    LIMIT ${limit}
  `;

  let planned = 0;
  let unfunded = 0;
  for (const { id } of rows) {
    const placement = await dbWrite.placement.findUnique({ where: { id } });
    if (!placement) continue;

    try {
      await payOutPlacement(placement);

      // A settlement whose holds never landed plans nothing, so this loop would
      // otherwise count it as resumed on every run forever — the same
      // false-healthy signal as a sweep reporting the work it attempted rather
      // than the work that landed. It is terminal, not resumable.
      const planExists = await dbWrite.placementTransaction.count({
        where: { placementId: id, kind: { in: [...PAYOUT_KINDS] } },
      });

      if (planExists > 0) planned++;
      else {
        unfunded++;
        logToAxiom({
          name: 'placement-escrow',
          type: 'error',
          message: 'settled placement has no funded escrow behind it',
          placementId: id,
        }).catch(() => null);
      }
    } catch (error) {
      logToAxiom({
        name: 'placement-escrow',
        type: 'error',
        message: 'unplanned settlement could not be resolved',
        placementId: id,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { unplanned: rows.length, planned, unfunded };
}
