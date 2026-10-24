import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { getBountyPoiAppeals, resolveBountyPoiAppeal } from '$lib/server/bounty-poi.service';
import { parseForm } from '$lib/server/query';
import { rulingReasonFromForm } from '$lib/server/resolution-reason';

const LIMIT = 100;

export const load: PageServerLoad = async () => {
  const { items, hasMore } = await getBountyPoiAppeals({ limit: LIMIT });
  return { items, hasMore, limit: LIMIT };
};

export const actions = {
  resolve: async ({ request }) => {
    const form = await request.formData();
    const input = parseForm(
      z.object({
        bountyId: z.coerce.number().int().positive({ error: 'Missing bounty id.' }),
        status: z.enum(['Approved', 'Rejected'], { error: 'Pick a verdict.' }),
      }),
      form
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const reason = rulingReasonFromForm('flagAppeal', input.status, form, ['poi']);
    if (typeof reason === 'string') return fail(400, { error: reason, bountyId: input.bountyId });

    const uphold = input.status === 'Rejected';
    const result = await resolveBountyPoiAppeal(input.bountyId, uphold, reason);
    if (!result.ok) return fail(400, { error: result.error, bountyId: input.bountyId });
    return { success: true, bountyId: input.bountyId, rescanQueued: result.rescanQueued };
  },
} satisfies Actions;
