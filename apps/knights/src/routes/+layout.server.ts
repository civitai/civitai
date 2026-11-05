import { env } from '$env/dynamic/private';
import { playerBadge } from '$lib/player-badge';
import { imageUrl } from '$lib/server/image-url';
import { CONVERSION } from '$lib/server/conversion/config';
import { shopEnabled } from '$lib/server/conversion/runtime';
import { getDailyStatus, getRecapState } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { ladderRows } from '$lib/server/ladder';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import { rankBadgeUrls } from '$lib/server/rank-badges';
import type { LayoutServerLoad } from './$types';

// The header's recap dot: a recap exists and has not been seen today, on the home card or in the header dialog (either one
// stores today's dismissal). The old popup opt-out no longer matters. The recap itself is read when the button is clicked, so a
// failure here only costs the dot.
async function recapUnseen(playerId: number | undefined): Promise<boolean> {
  if (playerId === undefined) return false;
  try {
    const state = await getRecapState(db, { playerId, now: queueDeps.now() });
    return state.hasHistory && !state.dismissedToday;
  } catch (error) {
    console.error('knights: could not read the recap state', { error });
    return false;
  }
}

// The header's gold and rank pills and the streak chip, for every page. A page that loads its own `status`/`daily` overrides
// these in page data (play keeps its live copy); the rest get them here, so no page can forget the header's stats. A failed
// read only costs the pills.
async function headerStats(playerId: number) {
  try {
    const status = await getPlayerStatus(db, playerId);
    if (!status) return { status: null, daily: null };
    const daily = await getDailyStatus(db, { playerId, rank: status.rank, now: queueDeps.now() });
    return { status, daily };
  } catch (error) {
    console.error('knights: could not read the header stats', { error });
    return { status: null, daily: null };
  }
}

export const load: LayoutServerLoad = async ({ locals, depends, url }) => {
  depends('app:recap');
  // Re-run on every navigation, so the stats are as fresh as a page's own load.
  void url.pathname;
  const civitaiUrl = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, '');
  // Only a player has a career to restart, which the account menu offers.
  const player = locals.user
    ? await db
        .selectFrom('NewOrderPlayer')
        .select('userId')
        .where('userId', '=', locals.user.id)
        .executeTakeFirst()
    : undefined;
  return {
    civitaiUrl,
    // Keys the player's own sound setting in the browser; never shown.
    userId: locals.user?.id ?? null,
    player: playerBadge(locals.user, civitaiUrl, imageUrl),
    isPlayer: player !== undefined,
    shopOpen: shopEnabled(),
    // For the header's gold popover, the rank gauge popover and the rank badge on the avatar.
    goldPerBuzz: CONVERSION.goldPerBuzz,
    ladder: ladderRows(),
    badges: await rankBadgeUrls(db),
    recapUnseen: await recapUnseen(locals.user?.id),
    headerStats: player !== undefined && locals.user ? await headerStats(locals.user.id) : null,
  };
};
