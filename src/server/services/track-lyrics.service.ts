import { NsfwLevel } from '~/server/common/enums';
import { imageReviewedSql } from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import type { LyricLine } from '~/server/schema/media.schema';
import { lyricLineSchema } from '~/server/schema/media.schema';
import { getImageIdsVisibleToViewer } from '~/server/services/image-visibility.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { SONGS_UNAVAILABLE_MESSAGE } from '~/shared/form-graph/generation/audio/song-metadata';
import { MediaType } from '~/shared/utils/prisma/enums';

/**
 * A song's stored lyric lines for its detail view, or null: for a song the viewer may not open, and
 * for one not yet reviewed, held or blocked, whoever is asking. The owner exemption that lets the
 * song itself show to its creator does not extend to the lyrics, whose text verdict is part of that
 * review.
 */
export async function getSongLyrics({
  id,
  ctx,
}: {
  id: number;
  ctx: { user?: { id: number; isModerator?: boolean | null }; features: { music?: boolean } };
}): Promise<LyricLine[] | null> {
  if (!ctx.features.music) throw throwAuthorizationError(SONGS_UNAVAILABLE_MESSAGE);
  const visible = await getImageIdsVisibleToViewer({
    ids: [id],
    userId: ctx.user?.id,
    isModerator: ctx.user?.isModerator ?? undefined,
  });
  if (!visible.has(id)) return null;

  const [row] = await dbRead.$queryRaw<{ type: MediaType; reviewed: boolean; lines: unknown }[]>`
    SELECT i.type,
      (${imageReviewedSql()} AND i."blockedFor" IS NULL AND i."nsfwLevel" != ${
    NsfwLevel.Blocked
  }) AS reviewed,
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
