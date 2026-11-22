import type { Prisma } from '@prisma/client';
import { logToAxiom } from '~/server/logging/client';

/**
 * Puts images in the CSAM review queue: flags them `needsReview = 'csam'` and takes them off its
 * set-aside list, inside the caller's transaction. Files no CsamReport and no external report.
 */
export async function flagImagesForCsamReview(
  tx: Pick<Prisma.TransactionClient, 'image' | '$queryRaw' | '$executeRaw'>,
  imageIds: number[]
) {
  await tx.image.updateMany({
    where: { id: { in: imageIds } },
    data: { needsReview: 'csam' },
  });
  // Reporting an image already flagged leaves its flag unchanged, so the set-aside trigger does not
  // fire and this delete is what puts the image back in the queue. It must follow the flag write:
  // that write's row lock is what a concurrent dismiss waits on, and its new row version is what
  // makes that dismiss refuse. The table and its grants are applied by hand; a role that may not
  // delete skips it rather than fail the report.
  const [setAside] = await tx.$queryRaw<{ deletable: boolean | null }[]>`
    SELECT has_table_privilege(to_regclass('"CsamQueueSetAside"'), 'DELETE') AS deletable`;
  if (setAside?.deletable)
    await tx.$executeRaw`DELETE FROM "CsamQueueSetAside" WHERE "imageId" = ANY(${imageIds}::int[])`;
  else if (setAside?.deletable === false)
    logToAxiom({
      type: 'warning',
      name: 'csam-queue-set-aside-not-deletable',
      message: 'the table exists but this role may not delete from it; grant DELETE',
    });
}
