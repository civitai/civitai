import { dbRead } from '~/server/db/client';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { logToAxiom } from '~/server/logging/client';
import { getMultipliersForUser, getTransactionByExternalId } from '~/server/services/buzz.service';
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
import {
  findManualCredits,
  type ManualCreditMatch,
} from '~/server/services/nowpayments-manual-credit';

export {
  matchManualCredit,
  type ManualCredit,
  type ManualCreditMatch,
} from '~/server/services/nowpayments-manual-credit';

// Paid on NowPayments' side but not yet settled to us: nothing to credit until it finishes.
const WAITING_STATUSES = new Set(['waiting', 'confirming', 'confirmed', 'sending']);

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
