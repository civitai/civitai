import { env } from '$env/dynamic/private';
import { playerBadge } from '$lib/player-badge';
import { imageUrl } from '$lib/server/image-url';
import { CONVERSION } from '$lib/server/conversion/config';
import { conversionEnabled } from '$lib/server/conversion/runtime';
import { getRecapState } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { ladderRows } from '$lib/server/ladder';
import { queueDeps } from '$lib/server/queue/runtime';
import { rankBadgeUrls } from '$lib/server/rank-badges';
import type { LayoutServerLoad } from './$types';

// The header's recap dot: a recap exists and today's was neither dismissed nor opted out of. The recap itself is read when the
// button is clicked, so a failure here only costs the dot.
async function recapUnseen(playerId: number | undefined): Promise<boolean> {
  if (playerId === undefined) return false;
  try {
    const state = await getRecapState(db, { playerId, now: queueDeps.now() });
    return state.hasHistory && !state.dismissedToday && !state.optedOut;
  } catch (error) {
    console.error('knights: could not read the recap state', { error });
    return false;
  }
}

export const load: LayoutServerLoad = async ({ locals, depends }) => {
  depends('app:recap');
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
    conversionOpen: conversionEnabled(),
    // For the header's gold popover, the rank gauge popover and the rank badge on the avatar.
    goldPerBuzz: CONVERSION.goldPerBuzz,
    ladder: ladderRows(),
    badges: await rankBadgeUrls(db),
    recapUnseen: await recapUnseen(locals.user?.id),
  };
};
