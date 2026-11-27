import { sql } from '@civitai/db/kysely';
import { moderatorWithheldSql, notWithheldTargetSql } from '@civitai/shared/retracted-media-tier';
import { WITHHELD_REFUSED } from '$lib/held-media';
import { dbWrite } from './db';

/**
 * The write's own check that its "Image" row is not withheld from the moderator, on an unaliased
 * `updateTable('Image')`. The action checks before it writes; this covers an image withheld between
 * that check and the write.
 */
export const notWithheldTarget = (csamReview: boolean) =>
  sql<boolean>`${sql.raw(notWithheldTargetSql({ csamReview }))}`;

/** A write left these images as they were: they are withheld from the moderator. */
export class WithheldImageError extends Error {
  constructor(readonly imageIds: number[]) {
    super(`${WITHHELD_REFUSED} Nothing was changed: ${imageIds.join(', ')}.`);
  }
}

/** Throws `WithheldImageError` for the images among `imageIds` withheld from the moderator now: why a
 *  write that names them changed nothing. Read on the primary. */
export async function assertNotWithheld(imageIds: number[], csamReview: boolean) {
  if (csamReview || !imageIds.length) return;
  const withheld = await dbWrite
    .selectFrom('Image as i')
    .select('i.id')
    .where('i.id', 'in', imageIds)
    .where(sql<boolean>`${sql.raw(moderatorWithheldSql('i', { csamReview }))}`)
    .execute();
  if (withheld.length) throw new WithheldImageError(withheld.map((row) => row.id));
}
