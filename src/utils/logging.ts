import { prisma } from '~/server/db/client';

export async function logToDb(event: string, details: object) {
  if (process.env.NODE_ENV == 'development') return; // Don't log in dev
  try {
    await prisma.log.createMany({
      data: {
        event,
        details,
      },
    });
  } catch (e) {
    console.error('Failed to log', e);
  }
}
