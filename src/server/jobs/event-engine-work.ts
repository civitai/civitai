import { eventEngine } from '~/server/events';
import { createJob } from '~/server/jobs/job';

export const eventEngineCleanUp = createJob('event-engine-clean-up', '0 0 * * *', async () => {
  await eventEngine.cleanUp();
});
