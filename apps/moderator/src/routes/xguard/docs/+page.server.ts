import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { apiCatalog, type CatalogEntry } from '$lib/server/api-catalog';

export type Endpoint = CatalogEntry;

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return { endpoints: await apiCatalog(locals.user, '/api/xguard') };
};
