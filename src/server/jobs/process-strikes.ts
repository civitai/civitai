import { createJob } from './job';
import { expireStrikes, processTimedUnmutes } from '~/server/services/strike.service';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('process-strikes', 'yellow');

/**
 * Expire old strikes that have passed their expiration date.
 * Runs daily at 2 AM.
 */
export const expireStrikesJob = createJob('expire-strikes', '0 2 * * *', async () => {
  try {
    const { expiredCount } = await expireStrikes();

    if (expiredCount > 0) {
      log(`Expired ${expiredCount} strike(s)`);
    }

    return { expiredCount };
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'expire-strikes-job',
      message: error.message,
      stack: error.stack,
    });

    throw e;
  }
});

/**
 * Process timed mutes that have expired and unmute users.
 * Runs hourly at the top of each hour.
 */
export const processTimedUnmutesJob = createJob('process-timed-unmutes', '0 * * * *', async () => {
  try {
    const { unmutedCount } = await processTimedUnmutes();

    if (unmutedCount > 0) {
      log(`Unmuted ${unmutedCount} user(s) whose timed mutes expired`);
    }

    return { unmutedCount };
  } catch (e) {
    const error = e as Error;

    logToAxiom({
      type: 'error',
      name: 'process-timed-unmutes-job',
      message: error.message,
      stack: error.stack,
    });

    throw e;
  }
});
