import { logToAxiom } from '~/server/logging/client';
import {
  runCaseTick,
  takedownRequestsConfigured,
} from '~/server/services/takedown-requests.service';
import { createJob } from './job';

/** Schedules the moderator app's case clock evaluation. */
export const caseTickJob = createJob(
  'case-tick',
  '*/15 * * * *',
  async () => {
    // Without the cases credential no clock is evaluated and no heartbeat is written, so say so loudly.
    if (!takedownRequestsConfigured()) {
      logToAxiom({ type: 'error', name: 'case-tick-not-configured' });
      return { skipped: 'not configured' };
    }
    const result = await runCaseTick();
    logToAxiom({ name: 'case-tick', payload: result });
    // The clocks ran but nobody was told; the moderator app retries the alert next run.
    if (result.unsent > 0)
      logToAxiom({ type: 'error', name: 'case-tick-alert-unsent', payload: result });
    return result;
  },
  { lockExpiration: 5 * 60 }
);
