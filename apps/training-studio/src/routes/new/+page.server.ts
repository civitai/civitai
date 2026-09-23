import type { PageServerLoad } from './$types';
import { resolveOrchestratorToken } from '$lib/server/token';
import { getFromPrices } from '$lib/server/pricing';
import { allowedModelFlags } from '$lib/server/flipt';
import { catalogFlagKeys, type FromPrices } from '$lib/data/trainingModels';

const NO_PRICES: FromPrices = {};

export const load: PageServerLoad = async ({ locals }) => {
  const token = await resolveOrchestratorToken(locals);
  // Streamed (returned unawaited): the flow renders immediately and the per-model "from" quotes fill
  // in when the sweep resolves. `getFromPrices` never rejects.
  const fromPrices: Promise<FromPrices> = token ? getFromPrices(token) : Promise.resolve(NO_PRICES);

  // Which gated catalog models this user may see. The dev-login stub has no real Flipt identity, so the
  // preview shows the whole catalog; a real user gets the flags they're segmented into (fail-closed).
  const gateKeys = catalogFlagKeys();
  const enabledModelFlags = locals.devPreview
    ? gateKeys
    : await allowedModelFlags(locals.user, gateKeys);

  return { username: locals.user.username, image: locals.user.image, fromPrices, enabledModelFlags };
};
