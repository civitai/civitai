import { moderatorWithheldSql } from '@civitai/shared/retracted-media-tier';
import { TRPCError } from '@trpc/server';
import type { DB } from '@civitai/db-schema/kysely';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { kyselyWrite } from '~/server/db/kyselyDb';

export const WITHHELD_LOOSENING_REFUSED = 'Not ruled on here. Ask a lead.';

/**
 * The ids among `imageIds` that `moderatorWithheldSql` withholds from a moderator without the
 * `csamReports` grant (`csamReview`). Primary: a flag or report the replica has not seen yet would
 * otherwise be missed. A failed read throws, so a caller refuses rather than writes.
 */
export async function withheldImageIds(
  imageIds: number[],
  { csamReview }: { csamReview: boolean },
  db: Kysely<DB> = kyselyWrite
): Promise<Set<number>> {
  if (csamReview || !imageIds.length) return new Set();
  const { rows } = await sql<{ id: number }>`
    SELECT i.id FROM "Image" i
    WHERE i.id = ANY(${imageIds}::int[]) AND ${sql.raw(moderatorWithheldSql('i', { csamReview }))}
  `.execute(db);
  return new Set(rows.map((r) => r.id));
}

/**
 * Refuses a moderator's loosening write (lower a level, clear a flag, accept, rescan, send to a
 * judge) on any image withheld from them, all or nothing. Tightening writes never call this.
 */
export async function assertMayLoosenImages(
  imageIds: number[],
  { csamReview }: { csamReview: boolean },
  db?: Kysely<DB>
) {
  const withheld = await withheldImageIds(imageIds, { csamReview }, db);
  if (!withheld.size) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `${WITHHELD_LOOSENING_REFUSED} Nothing was changed: ${[...withheld].join(', ')}.`,
  });
}
