import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { stuckCryptoDepositEmail } from '~/server/email/templates/stuckCryptoDeposit.email';
import { stuckCryptoDepositUserEmail } from '~/server/email/templates/stuckCryptoDepositUser.email';
import { logToAxiom } from '~/server/logging/client';
import { env } from '~/env/server';
import dayjs from '~/shared/utils/dayjs';

type NpPayment = Awaited<ReturnType<typeof nowpaymentsCaller.getPaymentStatus>>;

// A paid deposit that ended `failed` splits by outcome_amount — whether NP was
// able to produce a USDC conversion. It is NOT compared to the order value: this
// is a wallet-style deposit, so the amount sent is arbitrary.
//   - null/0  => Category 3: unsupported/wrapped coin (cbBTC). NP can't convert,
//               only refunds, and requires the account holder to request it.
//               We email the USER a self-service packet.
//   - present => Category 2: convertible wrong-network (USDT-BSC -> USDC-Base).
//               NP can convert but didn't settle. We email NP to convert-or-return.
//               (The email quotes actually_paid, never outcome_amount, so a garbage
//               outcome value does no harm here.)
const isFailedPaid = (p: NonNullable<NpPayment>) =>
  p.payment_status === 'failed' && Number(p.actually_paid) > 0;

const route = (p: NonNullable<NpPayment>): 'user' | 'nowpayments' =>
  (Number(p.outcome_amount) || 0) <= 0 ? 'user' : 'nowpayments';

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

    if (candidates.length === 0)
      return { candidates: 0, stuck: 0, emailedUser: 0, emailedNp: 0 };

    let stuck = 0;
    let emailedUser = 0;
    let emailedNp = 0;
    let skippedNoEmail = 0;

    for (const deposit of candidates) {
      const paymentId = deposit.paymentId.toString();
      const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);
      if (!payment || !isFailedPaid(payment)) continue;
      stuck++;

      const target = route(payment);
      const userEmail = deposit.user?.email;
      // supportEmail gates the whole feature and is the NP contact address shown
      // to users; userEmail is the recipient (Cat 3) or CC (Cat 2).
      if (!supportEmail || !userEmail) {
        skippedNoEmail++;
        continue; // leave stuckNotifiedAt null so it retries once config/email exists
      }

      const shared = {
        username: deposit.user?.username ?? 'there',
        paymentId,
        payCurrency: payment.pay_currency,
        payAmount: payment.actually_paid != null ? Number(payment.actually_paid) : null,
        payAddress: payment.pay_address,
        payinHash: payment.payin_hash,
        network: payment.network,
      };

      try {
        if (target === 'user') {
          await stuckCryptoDepositUserEmail.send({ userEmail, npSupportEmail: supportEmail, ...shared });
          emailedUser++;
        } else {
          await stuckCryptoDepositEmail.send({ supportEmail, userEmail, ...shared });
          emailedNp++;
        }

        await dbWrite.cryptoDeposit.update({
          where: { paymentId: deposit.paymentId },
          data: { stuckNotifiedAt: new Date() },
        });
      } catch (e) {
        await logToAxiom({
          name: 'notify-stuck-crypto-deposits-job',
          type: 'error',
          message: 'Failed to email stuck deposit',
          paymentId,
          target,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logToAxiom({
      name: 'notify-stuck-crypto-deposits-job',
      type: 'info',
      message: `Stuck-deposit notifier: ${emailedUser} user + ${emailedNp} NP emailed, ${stuck} stuck, ${candidates.length} scanned`,
      candidates: candidates.length,
      stuck,
      emailedUser,
      emailedNp,
      skippedNoEmail,
      supportEmailConfigured: !!supportEmail,
    });

    return { candidates: candidates.length, stuck, emailedUser, emailedNp, skippedNoEmail };
  },
  {
    lockExpiration: 10 * 60,
  }
);
