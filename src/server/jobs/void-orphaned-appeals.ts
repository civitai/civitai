import { voidOrphanedAppeals } from '~/server/services/report.service';
import { createJob } from './job';

export const voidOrphanedAppealsJob = createJob('void-orphaned-appeals', '20 * * * *', async () =>
  voidOrphanedAppeals()
);
