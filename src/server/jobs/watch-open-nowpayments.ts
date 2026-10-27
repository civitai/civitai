import { createJob } from './job';
import { watchOpenDeposits } from '~/server/services/nowpayments.service';
import { openCryptoDepositDigestEmail } from '~/server/email/templates/openCryptoDepositDigest.email';
import { logToAxiom } from '~/server/logging/client';

const DIGEST_TO = 'hello@civitai.com';

export const watchOpenNowpaymentsJob = createJob(
  'watch-open-nowpayments',
  '0 13 * * *', // Daily
  async () => {
    const { digest, ...result } = await watchOpenDeposits();

    let digestSent = 0;
    if (digest.length) {
      try {
        await openCryptoDepositDigestEmail.send({
          to: DIGEST_TO,
          items: digest,
          counts: result.counts,
        });
        digestSent = digest.length;
      } catch (e) {
        await logToAxiom({
          name: 'watch-open-nowpayments-job',
          type: 'error',
          message: 'Failed to send open-deposit digest',
          count: digest.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logToAxiom({
      name: 'watch-open-nowpayments-job',
      type: result.counts.finishedUncredited > 0 ? 'warning' : 'info',
      message: `Open deposits: ${result.counts.open} open (oldest ${result.counts.oldestOpenDays}d), ${result.closed} closed, ${result.counts.held} held, ${result.counts.finishedUncredited} finished but uncredited`,
      ...result.counts,
      checked: result.checked,
      closed: result.closed,
      lookupFailed: result.lookupFailed,
      digestSent,
    });

    return { ...result, digestSent };
  },
  {
    lockExpiration: 30 * 60,
  }
);
