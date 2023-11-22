import { eventEngine } from '~/server/events';
import { createJob } from '~/server/jobs/job';

export const eventEngineDailyReset = createJob(
  'event-engine-daily-reset',
  '0 0 * * *',
  async () => {
    await eventEngine.dailyReset();
  }
);
