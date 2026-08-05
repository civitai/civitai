import type { PageServerLoad } from './$types';
import { readTableSort } from '$lib/server/table-sort';
import { getModelEngagement } from '$lib/server/engagement';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const engagement = await getModelEngagement({ userId: locals.user.id }).catch(() => null);
  return { engagement , tableSort: readTableSort(cookies, 'engagement') };
};
