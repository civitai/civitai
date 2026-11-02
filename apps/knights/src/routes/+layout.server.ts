import { env } from '$env/dynamic/private';
import { playerBadge } from '$lib/player-badge';
import { imageUrl } from '$lib/server/image-url';
import { conversionEnabled } from '$lib/server/conversion/runtime';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  const civitaiUrl = (env.CIVITAI_APP_URL || 'https://civitai.com').replace(/\/+$/, '');
  return {
    civitaiUrl,
    // Keys the player's own sound setting in the browser; never shown.
    userId: locals.user?.id ?? null,
    player: playerBadge(locals.user, civitaiUrl, imageUrl),
    conversionOpen: conversionEnabled(),
  };
};
