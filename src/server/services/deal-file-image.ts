import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';

/**
 * Refuses images a deal file entry points at: a deal file's scan copy is what its file is checked
 * against, never user content, so a user neither attaches one anywhere nor deletes it. `act` names
 * what was refused.
 */
export async function assertNotDealFileImages(ids: number[], act: 'deleted' | 'used here') {
  if (!ids.length) return;
  // primary: an entry written moments ago must already refuse.
  const pointed = await dbWrite.$queryRaw<unknown[]>`
    SELECT 1 FROM "ServiceDealFileEntry" WHERE "imageId" = ANY(${ids}::int[]) LIMIT 1`;
  if (pointed?.length)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This image is part of a delivery file and cannot be ${act}.`,
    });
}
