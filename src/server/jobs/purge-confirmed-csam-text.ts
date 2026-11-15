import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { purgeConfirmedCsamText } from '~/server/services/text-scan/csam-text-retention';

/** Daily, after `text-scan-retention` (04:40). Counts only: never the text. */
export const purgeConfirmedCsamTextJob = createJob(
  'purge-confirmed-csam-text',
  '20 5 * * *',
  async () => {
    const result = await purgeConfirmedCsamText();
    await logToAxiom({ name: 'purge-confirmed-csam-text', ...result }, 'webhooks').catch(
      () => undefined
    );
    return result;
  }
);
