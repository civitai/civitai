import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import type { LyricLine } from '~/server/schema/media.schema';
import { lyricLineSchema } from '~/server/schema/media.schema';
import { TRACK_LYRICS_ENTITY_TYPE } from '~/server/services/audio-scan/track-lyrics';
import { getVisibleSongIds } from '~/server/services/image-visibility.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { SONGS_UNAVAILABLE_MESSAGE } from '~/shared/form-graph/generation/audio/song-metadata';
import { MediaType } from '~/shared/utils/prisma/enums';

/**
 * A song's stored lyric lines for its detail view, or null: for a song the viewer may not open, and
 * for one not yet reviewed, held or blocked, whoever is asking. The owner exemption that lets the
 * song itself show to its creator does not extend to the lyrics. The lyrics' own verdict is read
 * too: a moderator's rating lock counts the song as reviewed before its lyrics have one.
 */
export async function getSongLyrics({
  id,
  ctx,
}: {
  id: number;
  ctx: { user?: { id: number; isModerator?: boolean | null }; features: { music?: boolean } };
}): Promise<LyricLine[] | null> {
  const visible = await getVisibleSongIds({ ids: [id], viewer: ctx });
  if (!visible) throw throwAuthorizationError(SONGS_UNAVAILABLE_MESSAGE);
  if (!visible.has(id)) return null;

  const [row] = await dbRead.$queryRaw<{ type: MediaType; reviewed: boolean; lines: unknown }[]>`
    SELECT i.type,
      (${imageReviewedSql()} AND i."blockedFor" IS NULL AND i."nsfwLevel" != ${
    NsfwLevel.Blocked
  } AND (i."needsReview" IS NULL OR (i."userId" = ${
    ctx.user?.id ?? null
  }::int AND i."needsReview" <> 'csam'))
        AND EXISTS (
          SELECT 1 FROM "EntityModeration" em
          WHERE em."entityType" = ${TRACK_LYRICS_ENTITY_TYPE} AND em."entityId" = i.id
            AND em.status = 'Succeeded' AND em.blocked IS NOT TRUE
        )) AS reviewed,
      tl.lines
    FROM "Image" i
    LEFT JOIN "TrackLyrics" tl ON tl."imageId" = i.id
    WHERE i.id = ${id}
  `;
  if (!row) return null;
  if (row.type !== MediaType.audio) throw throwBadRequestError('Only songs have lyrics');
  if (!row.reviewed || row.lines == null) return null;
  const parsed = lyricLineSchema.array().safeParse(row.lines);
  return parsed.success && parsed.data.length ? parsed.data : null;
}
