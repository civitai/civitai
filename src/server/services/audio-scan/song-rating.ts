import { isSongsOwnCover } from '@civitai/db-queries/profile-picture-clear';
import { NsfwLevel } from '~/server/common/enums';
import { judgeRatingFloor } from '~/server/common/judge-rating';
import { hasBlockMarker } from '~/server/common/image-block-marker';
import { dbWrite } from '~/server/db/client';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

// Defined here, not beside the scan submits: those sit in an import cycle this module must stay out
// of, since the image scan pipeline re-rates a song from here.
export const TRACK_LYRICS_ENTITY_TYPE = 'TrackLyrics';
/** A song's lyrics profanity verdict: its own row, as EntityModeration is one row per entity. */
export const TRACK_LYRICS_LANGUAGE_ENTITY_TYPE = 'TrackLyricsLanguage';

const RATINGS: number[] = [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
const asRating = (level: unknown) =>
  typeof level === 'number' && RATINGS.includes(level) ? level : NsfwLevel.PG;

/**
 * A song's level (docs/features/music.md "A song's rating"): the highest of PG, its lyrics and title
 * text scan, its lyrics profanity, and its own cover's rating. Only a text-scan verdict rates, not an
 * XGuard one (no result version); a cover rates once scanned, and not while it carries a block.
 */
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

  const levels = (verdicts ?? []).map(({ entityType, nsfwLevel, result }) =>
    entityType === TRACK_LYRICS_LANGUAGE_ENTITY_TYPE ||
    (result as { version?: unknown } | null)?.version != null
      ? asRating(nsfwLevel)
      : NsfwLevel.PG
  );
  const cover = track?.coverImage;
  if (
    cover &&
    isSongsOwnCover(cover, song) &&
    cover.ingestion === ImageIngestionStatus.Scanned &&
    !hasBlockMarker(cover)
  )
    levels.push(asRating(cover.nsfwLevel));
  return Math.max(NsfwLevel.PG, ...levels);
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
