import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const nextauthCleanup = createJob('next-auth-cleanup', '0 0 * * *', async () => {
  // Clean verification tokens
  dbWrite.verificationToken.deleteMany({
    where: {
      expires: {
        lt: new Date(),
      },
    },
  });
});
