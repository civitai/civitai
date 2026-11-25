import { Prisma } from '@prisma/client';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isPgInt4, queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import { MediaType } from '~/shared/utils/prisma/enums';
import { storedSongDurationSec } from '~/shared/utils/song-play';

/**
 * Who the song read answers for. `unchecked`: any song, for a caller that has already decided who
 * may act on it. `{ conditions }`: only a song meeting them, over `"Image" i` with `"Post" p` LEFT
 * JOINed (`imageVisibilityConditions`). The caller passes them: importing the visibility service
 * here would pull this module into the image.service import cycle through report.service.
 */
export type SongReadVisibility = 'unchecked' | { conditions: Prisma.Sql[] };

/** The image as a song, with its stored length; null when it is missing, not a song, or not visible. */
export async function readSong(
  imageId: number,
  { visibility }: { visibility: SongReadVisibility }
): Promise<{ durationSec: number | null } | null> {
  if (!isPgInt4(imageId)) return null;
  const checked = visibility !== 'unchecked';
  const [song] = await queryPrismaSql<{ type: MediaType; duration: unknown }>(
    kyselyRead,
    Prisma.sql`
      SELECT i.type, i.metadata->'duration' AS duration
      FROM "Image" i
      ${checked ? Prisma.sql`LEFT JOIN "Post" p ON p.id = i."postId"` : Prisma.empty}
      WHERE ${Prisma.join(
        [Prisma.sql`i.id = ${imageId}`, ...(checked ? visibility.conditions : [])],
        ' AND '
      )}
    `
  );
  if (!song || song.type !== MediaType.audio) return null;
  return { durationSec: storedSongDurationSec(song.duration) };
}
