import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { getBountyPoiAppeals, resolveBountyPoiAppeal } from '$lib/server/bounty-poi.service';

const LIMIT = 100;

export const load: PageServerLoad = async () => {
  const { items, hasMore } = await getBountyPoiAppeals({ limit: LIMIT });
  return { items, hasMore, limit: LIMIT };
};

const run = async (event: RequestEvent, uphold: boolean) => {
  const form = await event.request.formData();
  const bountyId = Number(form.get('bountyId'));
  if (!(bountyId > 0)) return fail(400, { error: 'Missing bounty id.' });

  const result = await resolveBountyPoiAppeal(bountyId, uphold);
  if (!result.ok) return fail(400, { error: result.error, bountyId });
  return { success: true, bountyId, rescanQueued: result.rescanQueued };
};

export const actions: Actions = {
  uphold: (event) => run(event, true),
  overturn: (event) => run(event, false),
};
