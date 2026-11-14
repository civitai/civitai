import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { dbRead } from './db';

/** Ends an abandoned scan server-side; the caller stops waiting after seconds, the query must not outlive it by minutes. */
export const IMAGE_TAGS_COUNT_TIMEOUT_MS = 120_000;

/**
 * Images with a tag awaiting review, the Image tags badge.
 *
 * The bit-9 test matches TagsOnImageNew_needsReview_idx, but the backlog it selects is large, so the scan is
 * slow even with the index. That is why the caller waits seconds, caps the scan and runs one at a time.
 * The nsfwLevel bound must match the QUEUE's (image-tags.service.ts): without it, blocked images
 * inflate a badge whose page can never show them, so the count never reaches zero.
 *
 * In a transaction so the timeout applies to this query only.
 */
export async function countImageTagsNeedingReview(): Promise<number> {
  const row = await dbRead
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      await sql.raw(`SET LOCAL statement_timeout = ${IMAGE_TAGS_COUNT_TIMEOUT_MS}`).execute(trx);
      return trx
        .selectFrom('TagsOnImageNew as toi')
        .innerJoin('Image as i', 'i.id', 'toi.imageId')
        .select((eb) => eb.fn.count('toi.imageId').distinct().as('count'))
        .where(sql<boolean>`((toi.attributes >> 9)::integer & 1) = 1`)
        .where(sql<boolean>`((toi.attributes >> 10)::integer & 1) <> 1`)
        .where('i.nsfwLevel', '<', NsfwLevel.Blocked)
        .executeTakeFirst();
    });
  return Number(row?.count ?? 0);
}
