import { env } from '$env/dynamic/private';
import { playerBadge } from '$lib/player-badge';
import { imageUrl } from '$lib/server/image-url';
import { conversionEnabled } from '$lib/server/conversion/runtime';
import { getRecapState } from '$lib/server/daily/daily.service';
import { db } from '$lib/server/db';
import { queueDeps } from '$lib/server/queue/runtime';
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
  return {
    civitaiUrl,
    // Keys the player's own sound setting in the browser; never shown.
    userId: locals.user?.id ?? null,
    player: playerBadge(locals.user, civitaiUrl, imageUrl),
    conversionOpen: conversionEnabled(),
    recapUnseen: await recapUnseen(locals.user?.id),
  };
};
