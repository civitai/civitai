import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import {
  OVERRIDE_TIERS,
  isOverrideTier,
  listOverrides,
  setOverride,
  removeOverride,
} from '$lib/server/auth/membership';

export const load: PageServerLoad = async () => {
  return { overrides: await listOverrides(), tiers: OVERRIDE_TIERS };
};

export const actions: Actions = {
  set: async ({ request, locals }) => {
    const data = await request.formData();
    const userRaw = String(data.get('user') ?? '').trim();
    const tier = String(data.get('tier') ?? '');
    const note = String(data.get('note') ?? '').trim() || null;

    if (!userRaw) return fail(400, { error: 'Enter a user id or username.' });
    if (!isOverrideTier(tier)) return fail(400, { error: `"${tier}" is not a grantable tier.` });

    const res = await setOverride(userRaw, tier, note, locals.user?.id ?? null);
    if (!res.ok) return fail(404, { error: res.error });
    return {
      success: true,
      message: `${res.user.username ?? `user #${res.user.id}`} now has ${tier}.`,
    };
  },

  remove: async ({ request }) => {
    const data = await request.formData();
    const userId = Number(data.get('userId'));
    if (!Number.isInteger(userId)) return fail(400, { error: 'Invalid user.' });

    await removeOverride(userId);
    return { success: true, message: 'Override removed.' };
  },
};
