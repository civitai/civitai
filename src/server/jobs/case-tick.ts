import { logToAxiom } from '~/server/logging/client';
import {
  runCaseTick,
  takedownRequestsConfigured,
} from '~/server/services/takedown-requests.service';
import { createJob } from './job';

/**
 * Takedown case clocks. The moderator app evaluates them, records each threshold once, alerts the
 * moderation inbox and writes its own heartbeat; this only puts it on a schedule.
 */
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
    return result;
  },
  { lockExpiration: 5 * 60 }
);
