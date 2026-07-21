import type { PageServerLoad } from './$types';
import { getModelEngagement } from '$lib/server/engagement';

export const load: PageServerLoad = async ({ locals }) => {
  const engagement = await getModelEngagement({ userId: locals.user.id }).catch(() => null);
  return { engagement };
};
