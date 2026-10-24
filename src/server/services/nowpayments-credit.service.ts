import { dbRead } from '~/server/db/client';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { logToAxiom } from '~/server/logging/client';
import { getUserBuzzTransactionsResponse } from '~/server/schema/buzz.schema';
import {
  buzzService,
  getMultipliersForUser,
  getTransactionByExternalId,
} from '~/server/services/buzz.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  eventFromPayment,
  manualPayinCreditExternalId,
  processDeposit,
  userIdFromOrderId,
} from '~/server/services/nowpayments.service';
import { isDepositComplete, outcomeAmountToBuzz } from '~/server/common/chain-config';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { throwConflictError } from '~/server/utils/errorHandling';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';

// Paid on NowPayments' side but not yet settled to us: nothing to credit until it finishes.
const WAITING_STATUSES = new Set(['waiting', 'confirming', 'confirmed', 'sending']);

// Where a hand grant for a deposit can land, and the types it is made as. Reward and Compensation
// are left out: automated, and numerous enough on a creator's account to exhaust the scan.
const SCANNED_ACCOUNT_TYPES: BuzzAccountType[] = [
  'yellow',
  'blue',
  'green',
  'cashPending',
  'cashSettled',
];
const SCANNED_TRANSACTION_TYPES = [
  TransactionType.Tip,
  TransactionType.Incentive,
  TransactionType.Refund,
];
const SCAN_PAGE_SIZE = 200;
// A scan that cannot finish refuses: an unread page could hold the grant.
const SCAN_MAX_PAGES = 20;

export type ManualCredit = {
  /** What `acknowledge` names: the ledger key, or date|sender|amount when the row has none. */
  ref: string;
  date: string;
  type: string;
  amount: number;
  accountType: string;
  fromAccountId: number;
  description: string | null;
  externalTransactionId: string | null;
};

export type ManualCreditMatch = ManualCredit & { strength: 'hard' | 'soft'; why: string };

export type DepositCreditAssessment = {
  paymentId: number;
  decision: 'credit' | 'waiting' | 'refused';
  reason: string;
  status: string | null;
  user: { id: number; username: string | null } | null;
  actuallyPaid: { amount: number; currency: string } | null;
  outcome: { amount: number; currency: string | null } | null;
  /** base is outcome_amount → Buzz; total and blue include the purchase multiplier and bulk bonus. */
  buzz: { base: number; total: number; blue: number } | null;
  matches: ManualCreditMatch[];
};

const containsPaymentId = (text: string, paymentId: number) =>
  new RegExp(`(?<!\\d)${paymentId}(?!\\d)`).test(text);

/** Support cites a payin hash by its first few characters ("tx 0xbf7255…"), so any 6+ hex prefix counts. */
const containsPayinHashPrefix = (text: string, payinHash: string) => {
  const hash = payinHash.toLowerCase().replace(/^0x/, '');
  for (const [, run] of text.toLowerCase().matchAll(/(?:0x)?([0-9a-f]{6,})/g))
    if (hash.startsWith(run)) return true;
  return false;
};

const DEPOSIT_KEYWORDS = /\b(?:crypto|deposit|nowpayments|payin|usdt)|\b(?:np|btc|eth|tx)\b/i;
const SOFT_AMOUNT_TOLERANCE = 0.5;

/**
 * Whether a credit to the depositing user may already cover this payment. Hard matches cite the
 * payment and cannot be overridden; soft matches look like a hand grant for a deposit and can be,
 * by a moderator naming them in `acknowledge`.
 *
 * The soft tolerance is wide because hand grants are valued at payment time and NowPayments
 * settles later, so a hand grant for this payment rarely matches the settled amount.
 */
export function matchManualCredit(
  credit: ManualCredit,
  ctx: { paymentId: number; payinHash: string | null; expectedBuzz: number; fromStaff: boolean }
): Pick<ManualCreditMatch, 'strength' | 'why'> | null {
  const text = [credit.description, credit.externalTransactionId].filter(Boolean).join(' ');
  if (containsPaymentId(text, ctx.paymentId))
    return { strength: 'hard', why: 'cites the payment id' };
  if (ctx.payinHash && containsPayinHashPrefix(text, ctx.payinHash))
    return { strength: 'hard', why: 'cites the payin hash' };

  const handGrantType = credit.type === 'Tip' || credit.type === 'Incentive';
  if (!handGrantType || !ctx.fromStaff) return null;
  if (credit.description && DEPOSIT_KEYWORDS.test(credit.description))
    return { strength: 'soft', why: 'staff grant mentioning a deposit' };
  if (Math.abs(credit.amount - ctx.expectedBuzz) <= ctx.expectedBuzz * SOFT_AMOUNT_TOLERANCE)
    return { strength: 'soft', why: 'staff grant near the deposit amount' };
  return null;
}

/** Every credit of a scanned type into the user's accounts since `start`, read live from the Buzz service. */
async function getCreditsSince(userId: number, start: Date) {
  const credits: ManualCredit[] = [];
  for (const accountType of SCANNED_ACCOUNT_TYPES) {
    for (const type of SCANNED_TRANSACTION_TYPES) {
      let cursor: Date | undefined;
      for (let page = 0; ; page++) {
        if (page === SCAN_MAX_PAGES)
          throw new Error(`Too many ${TransactionType[type]} transactions to scan`);
        const data = await buzzService.getAccountTransactions(userId, {
          accountType,
          query: { type, start, cursor, limit: SCAN_PAGE_SIZE, descending: true },
        });
        const parsed = getUserBuzzTransactionsResponse.parse(data);
        for (const t of parsed.transactions) {
          if (t.toAccountId !== userId || t.fromAccountId === userId) continue;
          const externalTransactionId = t.externalTransactionId ?? null;
          credits.push({
            ref: externalTransactionId ?? `${t.date.toISOString()}|${t.fromAccountId}|${t.amount}`,
            date: t.date.toISOString(),
            type: TransactionType[t.type],
            amount: t.amount,
            accountType,
            fromAccountId: t.fromAccountId,
            description: t.description ?? null,
            externalTransactionId,
          });
        }
        if (!parsed.cursor || parsed.transactions.length === 0) break;
        cursor = parsed.cursor;
      }
    }
  }
  return credits;
}

async function findManualCredits(
  userId: number,
  ctx: { paymentId: number; payinHash: string | null; expectedBuzz: number; since: Date }
) {
  const credits = await getCreditsSince(userId, ctx.since);
  const senderIds = [...new Set(credits.map((c) => c.fromAccountId).filter((id) => id !== 0))];
  const moderators = senderIds.length
    ? await dbRead.user.findMany({
        where: { id: { in: senderIds }, isModerator: true },
        select: { id: true },
      })
    : [];
  const staff = new Set([0, ...moderators.map((m) => m.id)]);

  const matches: ManualCreditMatch[] = [];
  for (const credit of credits) {
    const match = matchManualCredit(credit, { ...ctx, fromStaff: staff.has(credit.fromAccountId) });
    if (match) matches.push({ ...credit, ...match });
  }
  return matches;
}

/**
 * What crediting a NowPayments payment would do, from NowPayments' live record of it. Refuses
 * anything the ledger shows as already paid, by the webhook or by hand.
 */
export async function assessDepositCredit(
  paymentId: number,
  { acknowledge = [] }: { acknowledge?: string[] } = {}
): Promise<{ assessment: DepositCreditAssessment; event: NOWPayments.WebhookEvent | null }> {
  const assessment: DepositCreditAssessment = {
    paymentId,
    decision: 'refused',
    reason: '',
    status: null,
    user: null,
    actuallyPaid: null,
    outcome: null,
    buzz: null,
    matches: [],
  };
  const refuse = (reason: string) => ({
    assessment: { ...assessment, decision: 'refused' as const, reason },
    event: null,
  });

  const { payment, status: lookupStatus } = await nowpaymentsCaller.lookupPayment(paymentId);
  if (!payment)
    return refuse(
      lookupStatus === 404
        ? 'NowPayments has no payment with this id'
        : `NowPayments lookup failed (HTTP ${lookupStatus})`
    );
  const event = eventFromPayment(payment);
  if (event.payment_id !== paymentId) return refuse('NowPayments returned a different payment');

  assessment.status = payment.payment_status;
  if (payment.actually_paid != null)
    assessment.actuallyPaid = {
      amount: Number(payment.actually_paid),
      currency: payment.pay_currency,
    };
  if (payment.outcome_amount != null)
    assessment.outcome = {
      amount: payment.outcome_amount,
      currency: payment.outcome_currency ?? null,
    };

  const userId = userIdFromOrderId(payment.order_id);
  if (userId) {
    const user = await dbRead.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });
    assessment.user = user;
  }

  if (WAITING_STATUSES.has(payment.payment_status))
    return {
      assessment: {
        ...assessment,
        decision: 'waiting',
        reason: `Waiting on NowPayments (status ${payment.payment_status}); it credits itself when it finishes`,
      },
      event: null,
    };
  if (!isDepositComplete(payment.payment_status))
    return refuse(`NowPayments status ${payment.payment_status} is not creditable`);
  if (!userId) return refuse('Payment is not a Civitai deposit (no user order id)');
  if (!assessment.user) return refuse(`User ${userId} does not exist`);
  if (!payment.outcome_amount || payment.outcome_amount <= 0)
    return refuse('NowPayments has not settled an amount for this payment yet');

  const base = outcomeAmountToBuzz(payment.outcome_amount);
  const { purchasesMultiplier } = await getMultipliersForUser(userId);
  const bulk = getBuzzBulkMultiplier({ buzzAmount: base, purchasesMultiplier });
  assessment.buzz = { base, total: bulk.totalBuzz, blue: bulk.blueBuzzAdded };

  if (await getTransactionByExternalId(`np-deposit-${paymentId}`))
    return refuse('Already credited by the deposit flow');
  const deposit = await dbRead.cryptoDeposit.findUnique({
    where: { paymentId: BigInt(paymentId) },
    select: { status: true, buzzCredited: true },
  });
  if (deposit?.status === 'finished' && deposit.buzzCredited != null)
    return refuse('Already credited by the deposit flow');
  const payinHash = payment.payin_hash ?? null;
  if (payinHash && (await getTransactionByExternalId(manualPayinCreditExternalId(payinHash))))
    return refuse('Already credited by hand against its payin hash');

  try {
    assessment.matches = await findManualCredits(userId, {
      paymentId,
      payinHash,
      expectedBuzz: base,
      since: payment.created_at,
    });
  } catch (e) {
    return refuse(`Could not check this user's credits since the payment: ${(e as Error).message}`);
  }
  if (assessment.matches.some((m) => m.strength === 'hard'))
    return refuse('A credit to this user cites this payment');
  const acknowledged = new Set(acknowledge);
  const open = assessment.matches.filter((m) => !acknowledged.has(m.ref));
  if (open.length)
    return refuse(
      'Credits to this user since the payment may already cover it; check each and name it in acknowledge'
    );

  return {
    assessment: {
      ...assessment,
      decision: 'credit',
      reason: assessment.matches.length
        ? `Would credit; ${assessment.matches.length} possible hand grant(s) acknowledged`
        : 'Would credit',
    },
    event,
  };
}

const audit = (data: MixedObject) =>
  logToAxiom({ name: 'nowpayments-credit', type: 'info', ...data }).catch(() => null);

/** Dry run: what `creditDeposit` would do, changing nothing. */
export async function previewDepositCredit({
  paymentId,
  acknowledge,
  modUserId,
}: {
  paymentId: number;
  acknowledge?: string[];
  modUserId: number;
}) {
  const { assessment } = await assessDepositCredit(paymentId, { acknowledge });
  await audit({ action: 'preview', modUserId, ...summarize(assessment) });
  return assessment;
}

/**
 * Credits a NowPayments payment through the deposit flow the webhook uses, after the same live
 * assessment the preview shows, run again under a per-payment lock.
 */
export async function creditDeposit({
  paymentId,
  acknowledge,
  modUserId,
  ticketId,
}: {
  paymentId: number;
  acknowledge?: string[];
  modUserId: number;
  ticketId?: string;
}) {
  const result = await withDistributedLock(
    { key: `np-deposit:credit:${paymentId}`, ttl: 60, autoRenew: true, maxRetries: 0 },
    async () => {
      const { assessment, event } = await assessDepositCredit(paymentId, { acknowledge });
      if (assessment.decision !== 'credit' || !event || !assessment.status || !assessment.user)
        return { assessment, credited: false, transactionId: null };

      const { transactionId } = await processDeposit(paymentId, assessment.status, event, {
        modUserId,
        ticketId,
      });
      const credited = !!transactionId && transactionId !== 'already_granted';
      return {
        assessment: credited
          ? assessment
          : {
              ...assessment,
              decision: 'refused' as const,
              reason: transactionId
                ? 'Already credited by the deposit flow'
                : 'Buzz grant failed; the deposit retry sweep will pick it up',
            },
        credited,
        transactionId: transactionId ?? null,
      };
    }
  );
  if (!result) throw throwConflictError(`A credit for payment ${paymentId} is already running`);

  const { assessment, credited, transactionId } = result;
  if (credited && assessment.user && assessment.buzz)
    await trackModActivity(modUserId, {
      entityType: 'user',
      entityId: assessment.user.id,
      activity: `creditCryptoDeposit:${paymentId}:${assessment.buzz.base}`,
    });
  await audit({
    action: 'credit',
    modUserId,
    ticketId,
    acknowledge,
    credited,
    transactionId,
    ...summarize(assessment),
  });
  return { ...assessment, credited, transactionId };
}

const summarize = (a: DepositCreditAssessment) => ({
  paymentId: a.paymentId,
  decision: a.decision,
  reason: a.reason,
  status: a.status,
  userId: a.user?.id,
  outcomeAmount: a.outcome?.amount,
  buzz: a.buzz?.base,
  matches: a.matches.map((m) => `${m.strength}:${m.ref}`),
});
