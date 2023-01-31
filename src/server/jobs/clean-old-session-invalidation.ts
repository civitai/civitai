import { createJob } from './job';
import { prisma } from '~/server/db/client';

export const cleanOldSessionInvalidation = createJob(
  'clean-old-session-invalidation',
  '3 1 * * *',
  async () => {
    await prisma.$transaction(async (tx) => {
      // Delete old
      await tx.$executeRawUnsafe(`
        DELETE
        FROM "SessionInvalidation"
        WHERE "invalidatedAt" < CURRENT_DATE-INTERVAL '31 day';
      `);
    });
  },
  {
    shouldWait: false,
  }
);
