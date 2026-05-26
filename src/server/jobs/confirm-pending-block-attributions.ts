import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REFUND_WINDOWS_DAYS } from '~/server/services/blocks/buzz-attribution.service';
import { createJob } from './job';

/**
 * Promote pending block_buzz_attribution rows to confirmed once they're
 * past the provider's refund window. confirmed rows are eligible for
 * the bulk payout job; until they're confirmed, no payout can fire.
 *
 * Runs daily at 03:15 UTC — well clear of the buzz/referral midnight
 * batch jobs. Each provider has its own window; we filter per provider
 * in a single SQL statement so the whole sweep is one DB round-trip.
 *
 * Idempotent: rows already past confirmed/voided/paid_out are ignored
 * by the WHERE clause.
 */
export const confirmPendingBlockAttributions = createJob(
  'confirm-pending-block-attributions',
  '15 3 * * *',
  async () => {
    let totalConfirmed = 0;
    for (const provider of Object.keys(REFUND_WINDOWS_DAYS) as Array<
      keyof typeof REFUND_WINDOWS_DAYS
    >) {
      const days = REFUND_WINDOWS_DAYS[provider];
      const result = await dbWrite.blockBuzzAttribution.updateMany({
        where: {
          status: 'pending',
          paymentProvider: provider,
          attributedAt: { lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
        },
        data: {
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });
      totalConfirmed += result.count;
      if (result.count > 0) {
        logToAxiom(
          {
            name: 'block-buzz-attribution',
            type: 'info',
            stage: 'confirm-pending',
            provider,
            windowDays: days,
            count: result.count,
            message: `confirmed ${result.count} pending ${provider} attribution(s)`,
          },
          'webhooks'
        ).catch(() => null);
      }
    }

    return { totalConfirmed };
  }
);
