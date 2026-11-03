import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { imageUrl } from '$lib/server/image-url';
import {
  LEADERBOARD_SIZE,
  queryBoard,
  viewBoard,
  type LeaderboardEntry,
} from '$lib/server/leaderboard';
import { fervorCopy, nextTally } from '$lib/server/leaderboard-view';
import { boardCache } from '$lib/server/leaderboard-runtime';
import { requireMember } from '$lib/server/membership';
import { PROGRESSION } from '$lib/server/progression/config';
import { playerBadge } from '$lib/player-badge';
import type { PageServerLoad } from './$types';

const BADGE_PX = 48;

export const load: PageServerLoad = async ({ locals }) => {
  const civitaiUrl = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, '');
  const now = new Date();
  const [status, board] = await Promise.all([
    requireMember(db, locals.user.id),
    boardCache.get(now, () => queryBoard(db, now)),
  ]);
  const view = viewBoard(board, locals.user.id);
  const shown = <T extends LeaderboardEntry>({ image, ...entry }: T) => {
    const badge = playerBadge(
      { username: entry.username, image: image ?? undefined },
      civitaiUrl,
      imageUrl
    );
    const badgeKey = view.badges[entry.rankType];
    return {
      ...entry,
      avatarUrl: badge?.avatarUrl ?? null,
      profileUrl: badge?.profileUrl ?? null,
      badgeUrl: badgeKey ? imageUrl(badgeKey, BADGE_PX) : null,
    };
  };
  return {
    status,
    size: LEADERBOARD_SIZE,
    windowDays: PROGRESSION.fervorWindowDays,
    nextTally: nextTally(now),
    copy: fervorCopy(),
    entries: view.entries.map(shown),
    self: view.self && shown(view.self),
    viewerId: locals.user.id,
  };
};
