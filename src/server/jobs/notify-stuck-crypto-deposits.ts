import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { stuckCryptoDepositEmail } from '~/server/email/templates/stuckCryptoDeposit.email';
import { logToAxiom } from '~/server/logging/client';
import { env } from '~/env/server';
import dayjs from '~/shared/utils/dayjs';

// A deposit is "stuck" when the user paid but NowPayments never converted the
// funds to our payout currency (outcome_amount is null) and the payment failed.
// That means the money is on NP's side in an unsupported/wrapped coin and we
// cannot credit Buzz. We can only email NP support (CC the user) to get it
// processed or refunded. See docs: outcome_amount is the discriminator.
const isStuckAtNp = (payment: { payment_status: string; actually_paid?: unknown; outcome_amount?: unknown }) => {
  const paid = Number(payment.actually_paid) > 0;
  const outcome = Number(payment.outcome_amount) || 0;
  return payment.payment_status === 'failed' && paid && outcome <= 0;
};

export const notifyStuckCryptoDepositsJob = createJob(
  'notify-stuck-crypto-deposits',
  '0 14 * * *', // Daily
  async () => {
    const supportEmail = env.NOWPAYMENTS_SUPPORT_EMAIL;

    // Unresolved local rows we haven't notified about yet. The migration stamped
    // the existing backlog, so this is go-forward only. Bounded to 14d because a
    // deposit that hasn't settled by then won't.
    const candidates = await dbRead.cryptoDeposit.findMany({
      where: {
        status: { not: 'finished' },
        stuckNotifiedAt: null,
        createdAt: { gte: dayjs.utc().subtract(14, 'day').toDate() },
      },
      select: {
        paymentId: true,
        userId: true,
        user: { select: { email: true, username: true } },
      },
    });

    if (candidates.length === 0) return { candidates: 0, stuck: 0, notified: 0 };

    let stuck = 0;
    let notified = 0;
    let skippedNoEmail = 0;

    for (const deposit of candidates) {
      const paymentId = deposit.paymentId.toString();
      const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);
      if (!payment || !isStuckAtNp(payment)) continue;
      stuck++;

      const userEmail = deposit.user?.email;
      if (!supportEmail || !userEmail) {
        skippedNoEmail++;
        continue; // leave stuckNotifiedAt null so it retries once config/email exists
      }

      try {
        await stuckCryptoDepositEmail.send({
          supportEmail,
          userEmail,
          username: deposit.user?.username ?? 'there',
          paymentId,
          payCurrency: payment.pay_currency,
          payAmount: payment.actually_paid != null ? Number(payment.actually_paid) : null,
          payAddress: payment.pay_address,
          payinHash: payment.payin_hash,
          network: payment.network,
        });

        await dbWrite.cryptoDeposit.update({
          where: { paymentId: deposit.paymentId },
          data: { stuckNotifiedAt: new Date() },
        });
        notified++;
      } catch (e) {
        await logToAxiom({
          name: 'notify-stuck-crypto-deposits-job',
          type: 'error',
          message: 'Failed to email stuck deposit',
          paymentId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logToAxiom({
      name: 'notify-stuck-crypto-deposits-job',
      type: 'info',
      message: `Stuck-deposit notifier: ${notified} emailed, ${stuck} stuck, ${candidates.length} scanned`,
      candidates: candidates.length,
      stuck,
      notified,
      skippedNoEmail,
      supportEmailConfigured: !!supportEmail,
    });

    return { candidates: candidates.length, stuck, notified, skippedNoEmail };
  },
  {
    lockExpiration: 10 * 60,
  }
);
