import { logToAxiom } from '~/server/logging/client';
import {
  runCaseTick,
  takedownRequestsConfigured,
} from '~/server/services/takedown-requests.service';
import { createJob } from './job';

/**
 * Takedown case clocks. The moderator app evaluates them, records each threshold once, alerts the
 * moderation inbox and writes its own heartbeat; this only puts it on a schedule. A run every 15
 * minutes keeps the 48h intimate-image deadline well inside its margin.
 */
export const caseTickJob = createJob(
  'case-tick',
  '*/15 * * * *',
  async () => {
    if (!takedownRequestsConfigured()) return { skipped: 'not configured' };
    const result = await runCaseTick();
    logToAxiom({ name: 'case-tick', payload: result });
    return result;
  },
  { lockExpiration: 5 * 60 }
);
