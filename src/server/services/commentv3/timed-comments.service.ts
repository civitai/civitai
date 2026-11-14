import { sql } from 'kysely';
import type { CommentV3Db } from '~/server/services/commentv3/read.service';
import { MediaType } from '~/shared/utils/prisma/enums';

/** What a timed comment stores in `CommentV3.metadata`; built here, never taken from the client. */
export type TimedCommentMetadata = { timestampSec: number };

/** The image as a song, with its stored length; null when it is missing or not a song. */
export async function getCommentSong(db: CommentV3Db, imageId: number) {
  const { rows } = await sql<{ type: MediaType; duration: unknown }>`
    SELECT i.type, i.metadata->'duration' AS duration FROM "Image" i WHERE i.id = ${imageId}`.execute(
    db
  );
  const song = rows[0];
  if (!song || song.type !== MediaType.audio) return null;
  const { duration } = song;
  return {
    durationSec:
      typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}
