import type { NextApiRequest } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import { resolveClientIp } from '~/server/utils/client-ip';
import {
  checkFixedWindow,
  type PublicApiRateLimitResult,
} from '~/server/utils/public-api-rate-limit';

/**
 * Per-actor cap on the song play calls, on the public REST limiter's fixed-window primitive. That
 * primitive fails open on a Redis error; the play count itself fails closed in `song-play.service`.
 */
export const SONG_PLAY_RATE_LIMIT_MAX = 60;
export const SONG_PLAY_RATE_LIMIT_WINDOW_SECONDS = 60;

export type SongPlayStep = 'start' | 'play';

/** Who is listening: the signed-in user id, else the client IP (the app-visit convention). */
export function songPlayActor({
  user,
  req,
}: {
  user?: { id: number } | null;
  req: NextApiRequest;
}): string {
  return user ? `user:${user.id}` : `ip:${resolveClientIp(req)}`;
}

export function checkSongPlayRateLimit(
  actor: string,
  step: SongPlayStep
): Promise<PublicApiRateLimitResult> {
  return checkFixedWindow(
    prefixCacheKey(`song-play:rate-limit:${step}:${actor}`),
    SONG_PLAY_RATE_LIMIT_MAX,
    SONG_PLAY_RATE_LIMIT_WINDOW_SECONDS
  );
}
