import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { dealFileImageSql, serverCopyImageSql } from '@civitai/db-queries/content-deletion';
import { dbWrite } from '~/server/db/client';
import { kyselyOver } from '~/server/db/prisma-kysely';
import { logToAxiom } from '~/server/logging/client';

/**
 * Refuses a deal file's copy of its file (`DEAL_FILE_IMAGE_USES`, pointed or named by `scanKey`):
 * what the file is checked against, never user content, so a user neither attaches one anywhere
 * nor deletes it. With `act` 'used here' it also refuses a service review's copy, which serves its
 * review only. 'deleted' lets a review copy go: deleting it takes only that review's image, while
 * deleting a deal file's copy leaves its file with nothing to be checked against.
 */
export async function assertNotDealFileImages(
  ids: number[],
  act: 'deleted' | 'used here',
  /** Only these owners' images: a caller who may not see the rest learns nothing about them. */
  { ownerId }: { ownerId?: number } = {}
) {
  if (!ids.length) return;
  const copySql = act === 'used here' ? serverCopyImageSql : dealFileImageSql;
  // primary: a copy recorded moments ago must already refuse.
  const { rows } = await sql<{ dealFileImage: boolean }>`
    SELECT true AS "dealFileImage" FROM unnest(${ids}::int[]) AS t(id)
    WHERE ${copySql(sql.ref('t.id'))}
      ${
        ownerId === undefined
          ? sql``
          : sql`AND EXISTS (SELECT 1 FROM "Image" i WHERE i.id = t.id AND i."userId" = ${ownerId})`
      }
    LIMIT 1
  `.execute(kyselyOver(dbWrite));
  if (rows?.some((row) => row.dealFileImage === true)) {
    // The tRPC error log never sees a FORBIDDEN, so the refusal count is this line's.
    logToAxiom({
      name: 'deal_copy_refused',
      type: 'info',
      message: 'refused a deal file copy',
      payload: { act, count: ids.length },
    });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `This image is a copy of a delivery file and cannot be ${act}.`,
    });
  }
}
