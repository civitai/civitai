import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSpendableBuzz } from '$lib/server/buzz';

// Re-read the caller's spendable balance for the header, hit on a `buzz:update` signal. Refetching the
// authoritative numbers is simpler and always correct vs. trying to apply the signal's per-account delta.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.devPreview) return json(null);
  return json(await getSpendableBuzz(locals.user.id));
};
