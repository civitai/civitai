import { Prisma } from '@prisma/client';
import {
  releaseSongCsamHold as releaseSongCsamHoldWith,
  SONG_CSAM_HOLD_KEY,
  type SongCsamReleaseTarget,
  songIdOfCoverSql,
} from '@civitai/shared/song-csam-hold';
import { logToAxiom } from '~/server/logging/client';

type FlagClient = Pick<Prisma.TransactionClient, 'image' | '$queryRaw' | '$executeRaw'>;

async function flagRows(tx: FlagClient, imageIds: number[]) {
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

/**
 * Puts images in the CSAM review queue: flags them `needsReview = 'csam'` and takes them off its
 * set-aside list, inside the caller's transaction. Files no CsamReport and no external report. A
 * flagged song cover also flags its song (`holdSongForCsam`), and a song flagged here directly is
 * the caller's from then on: its hold marker comes off, so no lyrics or cover decision lifts it.
 */
export async function flagImagesForCsamReview(tx: FlagClient, imageIds: number[]) {
  await flagRows(tx, imageIds);
  await tx.$executeRaw`
    UPDATE "Image" SET "metadata" = "metadata" - 'csamHold'
    WHERE id = ANY(${imageIds}::int[]) AND "metadata" ? 'csamHold'`;
  await holdSongsOfCovers(tx, imageIds);
}

/**
 * Holds the song each of `coverIds` is the cover of (`holdSongForCsam`), with that cover as the
 * source, for a cover that was just flagged or removed for CSAM. A song among `coverIds` itself is
 * left to the caller.
 */
export async function holdSongsOfCovers(tx: FlagClient, coverIds: number[]) {
  const covers = await tx.$queryRaw<{ coverId: number; songId: number | null }[]>`
    SELECT c.id AS "coverId", ${Prisma.raw(songIdOfCoverSql('c'))} AS "songId"
    FROM "Image" c WHERE c.id = ANY(${coverIds}::int[])`;
  for (const { coverId, songId } of covers)
    if (songId && !coverIds.includes(songId)) await holdSongForCsam(tx, songId, { cover: coverId });
}

/**
 * Flags a song for its lyrics hold or its cover's flag, the way `flagImagesForCsamReview` flags any
 * image, and records the source on the song's hold marker: a new marker when this turns the song
 * from unflagged to flagged, an added source while a marker exists. A song already flagged without
 * one was flagged by a moderator and stays theirs. Read under the song's row lock.
 */
export async function holdSongForCsam(
  tx: FlagClient,
  songId: number,
  source: { lyrics: number } | { cover: number }
) {
  const lyrics = 'lyrics' in source ? source.lyrics : null;
  const cover = 'cover' in source ? source.cover : null;
  const [song] = await tx.$queryRaw<{ flagged: boolean; marked: boolean }[]>`
    SELECT "needsReview" IS NOT DISTINCT FROM 'csam' AS flagged,
      COALESCE(jsonb_typeof("metadata" -> ${SONG_CSAM_HOLD_KEY}) = 'object', false) AS marked
    FROM "Image" WHERE id = ${songId} AND type = 'audio' FOR UPDATE`;
  if (!song) return;
  // Before flagRows: it overwrites the needsReview that a new marker records as prior.
  if (!song.flagged || song.marked)
    await tx.$executeRaw`
      UPDATE "Image" SET "metadata" = jsonb_set(
        CASE WHEN jsonb_typeof("metadata") = 'object' THEN "metadata" ELSE '{}'::jsonb END,
        '{csamHold}',
        CASE WHEN "needsReview" = 'csam' THEN "metadata" -> 'csamHold'
          ELSE jsonb_strip_nulls(jsonb_build_object('prior', "needsReview")) END
          || jsonb_strip_nulls(jsonb_build_object('lyrics', ${lyrics}::int, 'cover', ${cover}::int)))
      WHERE id = ${songId}`;
  await flagRows(tx, [songId]);
}

type ReleaseClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Runs in the caller's transaction. Returns the ids it released. */
export function releaseSongCsamHold(tx: ReleaseClient, target: SongCsamReleaseTarget) {
  return releaseSongCsamHoldWith(
    (text) => tx.$queryRaw<{ id: number; released?: boolean }[]>`${Prisma.raw(text)}`,
    target
  );
}
