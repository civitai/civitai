import type { PageServerLoad } from './$types';
import { resolveOrchestratorToken } from '$lib/server/token';
import { getFromPrices } from '$lib/server/pricing';
import type { FromPrices } from '$lib/data/trainingModels';

const NO_PRICES: FromPrices = {};

export const load: PageServerLoad = async ({ locals }) => {
  const token = await resolveOrchestratorToken(locals);
  // Streamed (returned unawaited): the flow renders immediately and the per-model "from" quotes fill
  // in when the sweep resolves. `getFromPrices` never rejects.
  const fromPrices: Promise<FromPrices> = token ? getFromPrices(token) : Promise.resolve(NO_PRICES);
  return { username: locals.user.username, image: locals.user.image, fromPrices };
};
