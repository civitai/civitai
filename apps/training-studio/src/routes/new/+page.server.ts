import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { orchestratorToken } from '$lib/server/orchestrator-token';
import { getFromPrices } from '$lib/server/pricing';
import type { FromPrices } from '$lib/data/trainingModels';

const NO_PRICES: FromPrices = {};

export const load: PageServerLoad = async ({ locals }) => {
  // The dev-login stub has no minted token — but a pinned ORCHESTRATOR_ACCESS_TOKEN (your API key) lets the
  // preview show real quotes with no DB/redis tunnel (prices are user-agnostic). Falls back to "—" when unset.
  if (locals.devPreview) {
    const token = env.ORCHESTRATOR_ACCESS_TOKEN;
    return {
      username: locals.user.username,
      fromPrices: token ? getFromPrices(token) : Promise.resolve(NO_PRICES),
    };
  }

  let token: string | null = null;
  try {
    token = await orchestratorToken(locals.user.id);
  } catch (err) {
    console.warn('[training-studio] orchestratorToken failed', err);
  }

  // Streamed (returned unawaited): the flow renders immediately and the per-model "from" quotes fill in
  // when the sweep resolves. `getFromPrices` never rejects.
  const fromPrices: Promise<FromPrices> = token ? getFromPrices(token) : Promise.resolve(NO_PRICES);
  return { username: locals.user.username, fromPrices };
};
