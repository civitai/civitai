import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { dealFileImageSql } from '@civitai/db-queries/content-deletion';
import { dbWrite } from '~/server/db/client';
import { kyselyOver } from '~/server/db/prisma-kysely';

/**
 * Refuses images a deal file points at (`DEAL_FILE_IMAGE_USES`): a deal file's scan copy is what
 * its file is checked against, never user content, so a user neither attaches one anywhere nor
 * deletes it. `act` names what was refused.
 */
export async function assertNotDealFileImages(ids: number[], act: 'deleted' | 'used here') {
  if (!ids.length) return;
  // primary: a copy recorded moments ago must already refuse.
  const { rows } = await sql<{ dealFileImage: boolean }>`
    SELECT true AS "dealFileImage" FROM unnest(${ids}::int[]) AS t(id)
    WHERE ${dealFileImageSql(sql.ref('t.id'))} LIMIT 1
  `.execute(kyselyOver(dbWrite));
  if (rows?.some((row) => row.dealFileImage === true))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This image is part of a delivery file and cannot be ${act}.`,
    });
}
