import { prefixCacheKey } from '@civitai/redis';
import { Prisma } from '@prisma/client';
import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { updateEntityMetric } from '~/server/utils/metric-helpers';
import { checkSongPlayRateLimit, songPlayActor } from '~/server/utils/song-play-rate-limit';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  isCountablePlay,
  SONG_PLAY_MIN_LISTEN_SEC,
  storedSongDurationSec,
} from '~/shared/utils/song-play';

/**
 * Song plays: "Play = 30 s listened or full track if shorter", the owner's own plays included. The client is
 * untrusted, so the server is the only writer of the play event and enforces the rule against its
 * own clock: a start, then a complete that counts only once the rule's time has passed since it.
 *
 * The event joins the ClickHouse image metric pipeline, which is additive and not self-healing, so
 * every Redis step fails closed: an outage under-counts, it never inflates.
 */

type SongPlayContext = Pick<Context, 'user' | 'features' | 'req' | 'track'>;

// The visibility rule and the excluded-users list are imported where they are used: both load
// cache modules at import time that the track router's other procedures do not need.

/** How long a start waits for its complete; a longer pause loses the play. */
const START_TTL_SECONDS = 60 * 60;

const startKey = (actor: string, imageId: number) =>
  prefixCacheKey(`song-play:start:${actor}:${imageId}`);
const countedKey = (actor: string, imageId: number) =>
  prefixCacheKey(`song-play:counted:${actor}:${imageId}`);

const NOT_COUNTED = { counted: false } as const;

/** The song when the public may see it, with its stored duration; null otherwise. */
async function readPublicSong(imageId: number) {
  const { imageVisibilityConditions } = await import('~/server/services/image-visibility.service');
  const [song] = await dbRead.$queryRaw<
    { id: number; type: MediaType; duration: unknown }[]
  >(Prisma.sql`
    SELECT i.id, i.type, i.metadata->'duration' AS duration
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${Prisma.join([Prisma.sql`i.id = ${imageId}`, ...imageVisibilityConditions({})], ' AND ')}
  `);
  if (!song || song.type !== MediaType.audio) return null;
  return { durationSec: storedSongDurationSec(song.duration) };
}

/** The song when this requester's play of it may count; null when the song or requester is refused. */
async function readCountableSong(ctx: SongPlayContext, imageId: number) {
  const song = await readPublicSong(imageId);
  if (!song) return null;
  if (ctx.user) {
    const { getMetricExcludedUserIds } = await import(
      '~/server/services/metric-excluded-users.service'
    );
    if ((await getMetricExcludedUserIds()).includes(ctx.user.id)) return null;
  }
  return song;
}

/** Records that this actor began a playback of a song it may count, at server time. */
export async function recordSongPlayStart({
  ctx,
  imageId,
}: {
  ctx: SongPlayContext;
  imageId: number;
}): Promise<{ started: boolean }> {
  if (!ctx.features.music) return { started: false };
  const actor = songPlayActor(ctx);
  if (!actor) return { started: false };
  if (!(await checkSongPlayRateLimit(actor, 'start')).allowed) return { started: false };
  if (!(await readCountableSong(ctx, imageId))) return { started: false };
  try {
    await redis.set(startKey(actor, imageId) as never, String(Date.now()), {
      EX: START_TTL_SECONDS,
    });
    return { started: true };
  } catch {
    return { started: false };
  }
}

/**
 * Counts one play when every check passes; otherwise `{ counted: false }`, with no error and no
 * write. `counted` says the play event was emitted; one that was not is lost, never retried.
 */
export async function countSongPlay({
  ctx,
  imageId,
}: {
  ctx: SongPlayContext;
  imageId: number;
}): Promise<{ counted: boolean }> {
  if (!ctx.features.music) return NOT_COUNTED;
  const actor = songPlayActor(ctx);
  if (!actor) return NOT_COUNTED;
  if (!(await checkSongPlayRateLimit(actor, 'play')).allowed) return NOT_COUNTED;

  const song = await readCountableSong(ctx, imageId);
  if (!song) return NOT_COUNTED;

  try {
    // One start yields at most one complete: the one GETDEL that returns it, early or not.
    const startedAt = await redis.getDel(startKey(actor, imageId));
    if (startedAt == null) return NOT_COUNTED;
    const elapsedSec = (Date.now() - Number(startedAt)) / 1000;
    if (!isCountablePlay(elapsedSec, song.durationSec)) return NOT_COUNTED;

    // A song cannot be counted faster than it can be played.
    const repeatWindowSec = Math.ceil(Math.max(SONG_PLAY_MIN_LISTEN_SEC, song.durationSec ?? 0));
    const claimed = await redis.set(countedKey(actor, imageId) as never, String(Date.now()), {
      NX: true,
      EX: repeatWindowSec,
    });
    if (!claimed) return NOT_COUNTED;
  } catch {
    return NOT_COUNTED;
  }

  // The claim above stands even when the emit fails: a lost play under-counts, a retry could inflate.
  return {
    counted: await updateEntityMetric({
      ctx,
      entityType: 'Image',
      entityId: imageId,
      metricType: 'Play',
    }),
  };
}
