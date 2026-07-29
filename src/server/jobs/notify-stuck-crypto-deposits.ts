import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { stuckCryptoDepositUserEmail } from '~/server/email/templates/stuckCryptoDepositUser.email';
import {
  stuckCryptoDepositDigestEmail,
  type StuckCryptoDepositDigestItem,
} from '~/server/email/templates/stuckCryptoDepositDigest.email';
import { logToAxiom } from '~/server/logging/client';
import { env } from '~/env/server';
import dayjs from '~/shared/utils/dayjs';

const DIGEST_TO = 'hello@civitai.com';

type NpPayment = Awaited<ReturnType<typeof nowpaymentsCaller.getPaymentStatus>>;

// A paid deposit that ended `failed` splits by outcome_amount — whether NP was
// able to produce a USDC conversion. It is NOT compared to the order value: this
// is a wallet-style deposit, so the amount sent is arbitrary.
//   - null/0  => Category 3: unsupported/wrapped coin (cbBTC). NP can't convert,
//               only refunds, and requires the account holder to request it. We
//               auto-email the USER a self-service packet.
//   - present => Category 2: convertible wrong-network (USDT-BSC -> USDC-Base).
//               NP produced a conversion but didn't settle. The signal is fuzzier,
//               so we collect these into one digest to the support team to review
//               and forward to NP, rather than emailing NP directly.
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
      return { candidates: 0, stuck: 0, emailedUser: 0, digestSent: 0 };

    let stuck = 0;
    let emailedUser = 0;
    let skippedNoConfig = 0;
    let skippedNoEmail = 0;
    // Cat 2, collected for the support digest and stamped only once it sends.
    const digestItems: StuckCryptoDepositDigestItem[] = [];
    const digestPaymentIds: bigint[] = [];

    for (const deposit of candidates) {
      const paymentId = deposit.paymentId.toString();
      const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);
      if (!payment || !isFailedPaid(payment)) continue;
      stuck++;

      // supportEmail gates the feature and is the NP address referenced in both
      // the user email and the support digest.
      if (!supportEmail) {
        skippedNoConfig++;
        continue;
      }

      const payAmount = payment.actually_paid != null ? Number(payment.actually_paid) : null;

      if (route(payment) === 'nowpayments') {
        digestItems.push({
          paymentId,
          username: deposit.user?.username ?? 'unknown',
          userId: deposit.userId,
          payCurrency: payment.pay_currency,
          payAmount,
          payAddress: payment.pay_address,
          payinHash: payment.payin_hash,
          network: payment.network,
          outcomeAmount: payment.outcome_amount ?? null,
        });
        digestPaymentIds.push(deposit.paymentId);
        continue;
      }

      // Cat 3 — auto-email the user their self-service refund packet.
      const userEmail = deposit.user?.email;
      if (!userEmail) {
        skippedNoEmail++;
        continue; // leave stuckNotifiedAt null so it retries once we have an email
      }

      try {
        await stuckCryptoDepositUserEmail.send({
          userEmail,
          npSupportEmail: supportEmail,
          username: deposit.user?.username ?? 'there',
          paymentId,
          payCurrency: payment.pay_currency,
          payAmount,
          payAddress: payment.pay_address,
          payinHash: payment.payin_hash,
          network: payment.network,
        });
        await dbWrite.cryptoDeposit.update({
          where: { paymentId: deposit.paymentId },
          data: { stuckNotifiedAt: new Date() },
        });
        emailedUser++;
      } catch (e) {
        await logToAxiom({
          name: 'notify-stuck-crypto-deposits-job',
          type: 'error',
          message: 'Failed to email user about stuck deposit',
          paymentId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Cat 2 — one digest to the support team to validate + forward to NP. Stamp
    // only after it sends, so a send failure re-lists them next run.
    let digestSent = 0;
    if (digestItems.length && supportEmail) {
      try {
        await stuckCryptoDepositDigestEmail.send({
          to: DIGEST_TO,
          npSupportEmail: supportEmail,
          items: digestItems,
        });
        await dbWrite.cryptoDeposit.updateMany({
          where: { paymentId: { in: digestPaymentIds } },
          data: { stuckNotifiedAt: new Date() },
        });
        digestSent = digestItems.length;
      } catch (e) {
        await logToAxiom({
          name: 'notify-stuck-crypto-deposits-job',
          type: 'error',
          message: 'Failed to send Cat 2 support digest',
          count: digestItems.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logToAxiom({
      name: 'notify-stuck-crypto-deposits-job',
      type: 'info',
      message: `Stuck-deposit notifier: ${emailedUser} user emails, ${digestSent} in support digest, ${stuck} stuck, ${candidates.length} scanned`,
      candidates: candidates.length,
      stuck,
      emailedUser,
      digestSent,
      skippedNoEmail,
      skippedNoConfig,
      supportEmailConfigured: !!supportEmail,
    });

    return { candidates: candidates.length, stuck, emailedUser, digestSent, skippedNoEmail, skippedNoConfig };
  },
  {
    lockExpiration: 10 * 60,
  }
);
