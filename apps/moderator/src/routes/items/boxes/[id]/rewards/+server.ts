import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { findCosmeticRewards } from '$lib/server/item-definitions.service';
import { parseIdPaste } from '$lib/server/query';

const MAX_IDS = 1000;

/** The cosmetic definitions to add to a box: every one of an event, or the pasted cosmetic ids. */
export const GET: RequestHandler = async ({ url }) => {
  const event = url.searchParams.get('event')?.trim();
  if (event) return json(await findCosmeticRewards({ event }));
  const cosmeticIds = parseIdPaste(url.searchParams.get('cosmeticIds') ?? '', MAX_IDS);
  if (typeof cosmeticIds === 'string') return json({ error: cosmeticIds }, { status: 400 });
  return json(await findCosmeticRewards({ cosmeticIds }));
};
