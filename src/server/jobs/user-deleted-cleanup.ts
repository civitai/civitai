import { dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from './job';

export const userDeletedCleanup = createJob('user-deleted-cleanup', '55 * * * *', async () => {
  const [lastRun, setLastRun] = await getJobDate('user-deleted-cleanup');

  // Remove follows
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Remove follows from deleted users
    DELETE FROM "UserEngagement" ue
    WHERE type = 'Follow'
      AND "userId" IN (SELECT id FROM "User" WHERE "deletedAt" >= ${lastRun})
  `;

  await setLastRun();
});
