import {
  songScanLevel,
  TRACK_LYRICS_ENTITY_TYPE,
  TRACK_LYRICS_LANGUAGE_ENTITY_TYPE,
} from '@civitai/db-queries/profile-picture-clear';
import { judgeRatingFloor } from '~/server/common/judge-rating';
import { hasBlockMarker } from '~/server/common/image-block-marker';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

export { TRACK_LYRICS_ENTITY_TYPE, TRACK_LYRICS_LANGUAGE_ENTITY_TYPE };

/** A song's level from its own scans (`songScanLevel`), read from the primary. */
export async function songLevel(song: { id: number; userId: number }) {
  const [verdicts, track] = await Promise.all([
    // primary: re-rated right after one of these verdicts was written
    dbWrite.entityModeration.findMany({
      where: {
        entityId: song.id,
        entityType: { in: [TRACK_LYRICS_ENTITY_TYPE, TRACK_LYRICS_LANGUAGE_ENTITY_TYPE] },
      },
      select: { entityType: true, nsfwLevel: true, result: true },
    }),
    // primary: re-rated right after the cover was scanned, replaced or removed
    dbWrite.track.findUnique({
      where: { imageId: song.id },
      select: {
        coverImage: {
          select: {
            userId: true,
            postId: true,
            ingestion: true,
            nsfwLevel: true,
            blockedFor: true,
          },
        },
      },
    }),
  ]);

  return songScanLevel(song, verdicts ?? [], track?.coverImage);
}

/** Reads before giving up on a level another writer keeps moving: a race, not a loop. */
const RATE_ATTEMPTS = 3;

/**
 * Raises a decided song's level to `songLevel` after one of its inputs changed, never lowering it,
 * and runs `onRated` with the level when it changed. A blocked or undecided song is left to its own
 * scan, and a locked level is a moderator's review; neither is touched. A collection judge's rating
 * stays a floor.
 */
export async function rateSong(songId: number, onRated: (nsfwLevel: number) => Promise<void>) {
  for (let attempt = 0; attempt < RATE_ATTEMPTS; attempt++) {
    const written = await writeSongLevel(songId);
    if (written === 'changed') continue;
    if (written !== null) await onRated(written);
    return written;
  }
  return null;
}

/**
 * Reads, computes and writes the level once. 'changed' when the row moved between the read and the
 * write, so the caller reads again: dropping it would leave the song rated by the stale read.
 */
async function writeSongLevel(songId: number): Promise<number | 'changed' | null> {
  // primary: guards the level write below
  const song = await dbWrite.image.findUnique({
    where: { id: songId },
    select: {
      userId: true,
      type: true,
      ingestion: true,
      nsfwLevel: true,
      nsfwLevelLocked: true,
      blockedFor: true,
      metadata: true,
    },
  });
  if (
    !song ||
    song.type !== MediaType.audio ||
    song.ingestion !== ImageIngestionStatus.Scanned ||
    hasBlockMarker(song) ||
    (song.nsfwLevelLocked && song.nsfwLevel !== 0)
  )
    return null;

  // Only ever raised: a level above the inputs is someone's rating (an owner's own raise is not
  // locked), and a race between two re-rates then ends at the higher one.
  const level = Math.max(
    song.nsfwLevel,
    await songLevel({ id: songId, userId: song.userId }),
    judgeRatingFloor(song.metadata)
  );
  if (level === song.nsfwLevel) return null;
  // Written only over the level read above; a block or a lock since then is seen on the next read.
  const { count } = await dbWrite.image.updateMany({
    where: {
      id: songId,
      type: MediaType.audio,
      ingestion: ImageIngestionStatus.Scanned,
      blockedFor: null,
      nsfwLevel: song.nsfwLevel,
      OR: [{ nsfwLevelLocked: false }, { nsfwLevel: 0 }],
    },
    // A lock on no level is not a rating, so it goes, as the scan's write drops it.
    data: { nsfwLevel: level, nsfwLevelLocked: false },
  });
  return count ? level : 'changed';
}

/** The song whose own cover link names this image, if any. */
export async function songOfCover(coverId: number) {
  // primary: the cover's scan verdict was just written
  const track = await dbWrite.track.findUnique({
    where: { coverImageId: coverId },
    select: { imageId: true },
  });
  return track?.imageId ?? null;
}

type SongReRater = (songId: number) => Promise<void>;

declare global {
  // eslint-disable-next-line no-var
  var __civitaiSongReRater: SongReRater | undefined;
}

/**
 * The moderation registry sets this when it loads (at server start, `instrumentation.ts`) to the
 * scan pipeline's `rerateSong`. A level setter in the image service re-rates through it: importing
 * the pipeline there would put the pipeline in the image service's import cycle. On `globalThis`,
 * as `setTextScanVerdictApplier` is: the build emits this module more than once.
 */
export function setSongReRater(next: SongReRater) {
  globalThis.__civitaiSongReRater = next;
}

/** Re-rates the song whose own cover this image is, after the image's level changed. Never throws. */
export async function rerateSongOfRatedCover(coverId: number) {
  try {
    const songId = await songOfCover(coverId);
    if (songId === null) return;
    const rerate = globalThis.__civitaiSongReRater;
    if (!rerate) {
      logToAxiom({
        name: 'song-rating',
        type: 'error',
        message: 'song re-rater not registered',
        payload: { songId },
      });
      return;
    }
    await rerate(songId);
  } catch (error) {
    logToAxiom({
      name: 'song-rating',
      type: 'error',
      message: (error as Error).message,
      payload: { coverId },
    });
  }
}
