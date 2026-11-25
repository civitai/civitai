import { blockMarkerText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import type { DB } from '@civitai/db-schema/kysely';
import { heldImageKnownSql } from '@civitai/shared/held-media';
import { csamRestrictedSql } from '@civitai/shared/retracted-media-tier';
import { sql, type Kysely } from 'kysely';
import { isPgInt4 } from '~/server/db/prisma-sql-kysely';

export const NO_SONG_COVER_MESSAGE = 'This song has no cover to remove.';
export const HELD_SONG_COVER_MESSAGE =
  'This cover is held for CSAM review, so it cannot be removed here. Ask a lead.';

/**
 * The song's own cover (`songsOwnCoverText`), while there is one to remove, and whether it is held:
 * under CSAM review or blocked as CSAM, its owner held (`heldImageKnownSql`), or its bytes carrying a
 * CSAM signal (`csamRestrictedSql`). The main app has no CSAM-review grant, so it refuses every held
 * cover. Null when the image is not a song, or the song has no own cover that is not already removed.
 */
export async function getSongCoverForRemoval(
  db: Kysely<DB>,
  songId: number
): Promise<{ coverId: number; held: boolean } | null> {
  if (!isPgInt4(songId)) return null;
  const { rows } = await sql<{ coverId: number; held: boolean }>`
    SELECT cov.id AS "coverId",
      (${sql.raw(heldImageKnownSql('cov'))} OR ${sql.raw(csamRestrictedSql('cov'))}) AS held
    FROM "Track" t
    JOIN "Image" s ON s.id = t."imageId"
    JOIN "Image" cov ON cov.id = t."coverImageId"
    WHERE t."imageId" = ${songId}
      AND s.type::text = 'audio'
      AND cov.type::text = 'image'
      AND ${sql.raw(songsOwnCoverText('cov', 's'))}
      AND NOT ${sql.raw(blockMarkerText('cov'))}
  `.execute(db);
  return rows[0] ?? null;
}
