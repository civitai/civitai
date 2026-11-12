import { getTransactionByExternalId } from '~/server/services/buzz.service';
import {
  findHandGrantsForDeposit,
  type ManualCreditMatch,
} from '~/server/services/nowpayments-manual-credit';

/**
 * Key for Buzz credited by hand for an on-chain deposit NowPayments never turned into a payment.
 * If NP later backfills that deposit, the backfill gets a fresh payment id, so `np-deposit-<id>`
 * cannot collide with the manual grant; the deposit's tx hash is the only identity both share.
 */
export const manualPayinCreditExternalId = (payinHash: string) =>
  `np-payin-${payinHash.toLowerCase()}`;

export const userIdFromOrderId = (orderId: string | null | undefined) => {
  if (!orderId?.startsWith('user:')) return null;
  const userId = parseInt(orderId.split(':')[1], 10);
  return userId && !isNaN(userId) ? userId : null;
};

export const HELD = 'held';
/** Settled without a grant: Support paid it by hand and left a hand-paid top-up naming it. */
export const HAND_PAID = 'hand_paid';
/**
 * Closed unpaid on our side. NowPayments can still finish such a payment; crediting one then fails
 * closed, and a failed attempt leaves the row here for the late sweep (watchOpenDeposits).
 */
export const LATE_FINISH_STATUSES = ['failed', 'expired'];

export type HeldReason =
  | 'hand_grant_covers'
  | 'soft_hand_grant_match'
  | 'hand_grant_scan_incomplete'
  | 'hand_paid_unreadable';

export type SettleDecision =
  | {
      decision: 'already_granted';
      via: 'payin_hash' | 'np_deposit' | 'hand_paid';
      ledgerAmount?: number;
      matches: ManualCreditMatch[];
    }
  | { decision: 'held'; reason?: HeldReason; matches: ManualCreditMatch[]; unscanned: string[] }
  | { decision: 'grant'; possible: ManualCreditMatch[]; unscanned: string[] };

/**
 * Whether a paid deposit still needs a grant, decided from the ledger and the deposit row. Reads
 * only (buzz ledger GETs and the read replica), so the dry-run script can run it against real data.
 */
export async function decideDepositCredit(input: {
  paymentId: number;
  userId: number;
  payinHash: string | null;
  expectedBuzz: number;
  /** When NowPayments created the payment; the hand-grant scan starts the day before. */
  paymentCreatedAt: Date | null | undefined;
  row: { status: string; createdAt: Date } | null;
  lateStatus: string | undefined;
  /** A moderator crediting by hand has already been through assessDepositCredit. */
  byModerator: boolean;
  /**
   * Dry-run control only: skip the payin-hash and `np-deposit-<id>` ledger checks, so the hand-grant
   * scan runs on a deposit that was credited normally. Never set by the deposit flow.
   */
  ignorePriorGrant?: boolean;
}): Promise<SettleDecision> {
  const { paymentId, payinHash, row, lateStatus, ignorePriorGrant = false } = input;

  const manualCredit =
    payinHash && !ignorePriorGrant
      ? await getTransactionByExternalId(manualPayinCreditExternalId(payinHash))
      : null;
  if (manualCredit)
    return {
      decision: 'already_granted',
      via: 'payin_hash',
      ledgerAmount: manualCredit.amount,
      matches: [],
    };

  if (input.byModerator) return { decision: 'grant', possible: [], unscanned: [] };

  // No rescan: a redelivery must not credit it once the grant drops out of the scan.
  if (row?.status === HELD) return { decision: 'held', matches: [], unscanned: [] };
  if (row?.status === HAND_PAID)
    return { decision: 'already_granted', via: 'hand_paid', matches: [] };

  const priorGrant = ignorePriorGrant
    ? null
    : await getTransactionByExternalId(`np-deposit-${paymentId}`);
  if (priorGrant)
    return {
      decision: 'already_granted',
      via: 'np_deposit',
      ledgerAmount: priorGrant.amount,
      matches: [],
    };

  const { handPaid, covering, unreadable, possible, overflowed } = await findHandGrantsForDeposit(
    input.userId,
    {
      paymentId,
      payinHash,
      expectedBuzz: input.expectedBuzz,
      paymentCreatedAt: input.paymentCreatedAt ?? row?.createdAt,
    }
  );
  if (handPaid.length) return { decision: 'already_granted', via: 'hand_paid', matches: handPaid };
  if (covering.length)
    return { decision: 'held', reason: 'hand_grant_covers', matches: covering, unscanned: [] };
  // Fail closed, late or not: the top-up may be for this deposit.
  if (unreadable.length)
    return { decision: 'held', reason: 'hand_paid_unreadable', matches: unreadable, unscanned: [] };

  // A late finish holds, rather than credits, when the hand-grant scan is unsure.
  const uncertain: HeldReason | undefined = possible.length
    ? 'soft_hand_grant_match'
    : overflowed.length
    ? 'hand_grant_scan_incomplete'
    : undefined;
  if (lateStatus && uncertain)
    return { decision: 'held', reason: uncertain, matches: possible, unscanned: overflowed };

  return { decision: 'grant', possible, unscanned: overflowed };
}
