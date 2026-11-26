import { moderatorWithheldSql } from '@civitai/shared/retracted-media-tier';
import { TRPCError } from '@trpc/server';
import type { DB } from '@civitai/db-schema/kysely';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { NsfwLevel } from '~/server/common/enums';
import { kyselyWrite } from '~/server/db/kyselyDb';

export const WITHHELD_LOOSENING_REFUSED = 'Not ruled on here. Ask a lead.';

/**
 * Whether rating an image `next` over `current` loosens it: a lower level, or a first rating of an
 * unrated image (0), which locks a level the scan then keeps. Blocked never loosens.
 * `loosensImageLevelSql` is the same rule in SQL; change the two together.
 */
export const loosensImageLevel = (current: number, next: number) =>
  next !== NsfwLevel.Blocked && (current === 0 || next < current);

/** `loosensImageLevel` over a level column, for a guard inside a write. */
export function loosensImageLevelSql(next: number, currentColumn: string) {
  if (!Number.isInteger(next)) throw new Error(`Bad level: ${next}`);
  if (!/^[a-z_][a-z0-9_]*\."[a-zA-Z]+"$/.test(currentColumn))
    throw new Error(`Bad column: ${currentColumn}`);
  return next === NsfwLevel.Blocked
    ? 'false'
    : `(${currentColumn} = 0 OR ${next} < ${currentColumn})`;
}

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
