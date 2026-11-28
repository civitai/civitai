import { isIP } from 'node:net';
import type { NextApiRequest } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import { getTrustedClientIp } from '~/server/utils/client-ip';
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

/**
 * The /64 network of a canonical IPv6 address: one subscriber is commonly handed a whole /64, so
 * keying on the full address would give one listener 2^64 actors.
 */
function ipv6Network(ip: string): string {
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded IPv4 tail is two groups wide.
  const rightWidth = right.reduce((width, group) => width + (group.includes('.') ? 2 : 1), 0);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - rightWidth).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Who is listening: the signed-in user id, else the client's trusted address (an IPv6 address by its
 * /64). Null when an anonymous caller's address cannot be established; such a caller is not counted.
 */
export function songPlayActor({
  user,
  req,
}: {
  user?: { id: number } | null;
  req: NextApiRequest;
}): string | null {
  if (user) return `user:${user.id}`;
  const ip = getTrustedClientIp(req);
  if (!ip) return null;
  return isIP(ip) === 6 ? `ip:${ipv6Network(ip)}` : `ip:${ip}`;
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
