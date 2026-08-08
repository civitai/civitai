import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { getPaginatedCosmetics, grantCosmeticsToUsers } from '$lib/server/cosmetics.service';
import { CosmeticType } from '$lib/cosmetics';
import { parseQuery } from '$lib/server/query';

const LIMIT = 60;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  name: z.string().trim().catch(''),
  // Repeated `?type=` filter; absent/invalid → [] → all types.
  type: z.array(z.enum(CosmeticType)).catch([]),
});

export const load: PageServerLoad = async ({ url }) => {
  const { page, name, type } = parseQuery(url, querySchema, ['type']);

  const data = await getPaginatedCosmetics({
    page,
    limit: LIMIT,
    name: name || undefined,
    types: type.length ? type : undefined,
  });

  return { name, types: type, ...data };
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
