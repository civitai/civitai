import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getPaginatedCosmetics, grantCosmeticsToUsers } from '$lib/server/cosmetics.service';
import { CosmeticType } from '$lib/cosmetics';

const LIMIT = 60;
const COSMETIC_TYPES = new Set<string>(Object.values(CosmeticType));
const isType = (v: string): v is CosmeticType => COSMETIC_TYPES.has(v);

export const load: PageServerLoad = async ({ url }) => {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const name = url.searchParams.get('name')?.trim() || '';
  const types = url.searchParams.getAll('type').filter(isType);

  const data = await getPaginatedCosmetics({
    page,
    limit: LIMIT,
    name: name || undefined,
    types: types.length ? types : undefined,
  });

  return { name, types, ...data };
};

// Access is enforced globally (hooks.server.ts). Grant runs internally via Kysely.
export const actions: Actions = {
  grant: async ({ request }) => {
    const form = await request.formData();
    const cosmeticIds = form.getAll('cosmeticId').map(Number).filter(Boolean);
    const userIds = form.getAll('userId').map(Number).filter(Boolean);

    if (!cosmeticIds.length || !userIds.length)
      return fail(400, { error: 'Select at least one cosmetic and one user.' });

    try {
      const result = await grantCosmeticsToUsers({ cosmeticIds, userIds });
      return { success: true, ...result };
    } catch (e) {
      return fail(400, { error: e instanceof Error ? e.message : 'Failed to grant cosmetics.' });
    }
  },
};
